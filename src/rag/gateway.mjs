import { appendFile, mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';
import { ragConfig, localChat, guardText, screenForCloud, callMuse, metaAccessEnabled } from '../server/gateway-models.mjs';
import { generateLocalAnswer } from '../comparison/local-answer.mjs';
import { createLocalTokenCounters } from '../server/token-counts.mjs';
import { retrieveComplete } from './complete-retrieval.mjs';
import { calculateLocal } from './calculators.mjs';
import { createPrivacyVault, countPlaceholders, assertNoResidualPii } from './privacy.mjs';
import { signReceipt, verifyReceipt, appendReceipt, recordOutboundPayload, sha256 } from './receipts.mjs';
import {buildLeanPayload,semanticLeanWireText} from '../comparison/handoff-payload.mjs';
import {isCloudEligible,createCloudPolicyRegistry} from '../comparison/policy.mjs';
import {LOCKED_COMPANY_MODEL,LOCKED_POLICY_HASH,loadLockedPolicy,inferGatewayTask,decideLockedRoute,skippedGeneralAnswer} from './locked-routing.mjs';
import {readLiveMuseConfig} from '../server/live-muse.mjs';
import {prepareQuestionOnly,screenQuestionOnly,buildQuestionOnlyPayload,checkIncomingAnswer,applyAnswerLocally} from '../privacy/question-boundary.mjs';

export const estimateTokens = text => Math.ceil(String(text).length / 4);
const logDirectory = fileURLToPath(new URL('../../.logs/gateway/', import.meta.url));
let budgetCounter;
async function localBudgetCounter() {
  budgetCounter ??= createLocalTokenCounters().then(counters => text => Math.max(counters.countText('muse-spark', text), counters.countText('gemini', text))).catch(() => null);
  // Missing local tokenizer assets use the retriever's conservative byte upper
  // bound; this helper never downloads assets or calls a counting endpoint.
  return budgetCounter;
}
function capEvidence(text, tokenBudget) {
  const end = Math.min(text.length, tokenBudget * 4);
  const cut = text.slice(0, end);
  const open = cut.lastIndexOf('[[PII_');
  return open >= 0 && cut.indexOf(']]', open) === -1 ? cut.slice(0, open) : cut;
}
export function parseLocalAnswer(text) {
  try {
    const value = JSON.parse(text);
    if (typeof value.answer !== 'string' || !Number.isFinite(value.confidence) || !Array.isArray(value.citations)) throw new Error('Invalid answer');
    return { ...value, confidence: Math.max(0, Math.min(1, value.confidence)), citations: value.citations.filter(id => typeof id === 'string') };
  } catch { return { answer: 'The local model could not produce a grounded answer.', confidence: 0, needsCloud: true, citations: [] }; }
}

export async function askRag(question, { dataDir = path.resolve('.handoff'), offlineMeta = true, retrievalEnabled = true, onEvent, localOnly = false, lockedCompanyRouting=ragConfig.lockedCompanyRoutingEnabled, task, liveRunId=process.env.HANDOFF_LIVE_RUN_ID, dependencies = {} } = {}) {
  if (typeof question !== 'string' || !question.trim() || question.length > 8000) throw new Error('Question must contain 1 to 8000 characters');
  if(typeof lockedCompanyRouting!=='boolean')throw new Error('The locked company-routing flag must be boolean');
  if(lockedCompanyRouting&&(ragConfig.lockedCompanyModel!==LOCKED_COMPANY_MODEL||ragConfig.lockedPolicyHash!==LOCKED_POLICY_HASH))throw new Error('Locked routing configuration does not match Stage 3');
  const activeModel=lockedCompanyRouting?LOCKED_COMPANY_MODEL:ragConfig.localModel;
  const modelName=lockedCompanyRouting?'Gemma 12B':'Llama';
  const started = performance.now(), runId = randomUUID(), stages = [], events = [];
  const vault = await createPrivacyVault(dataDir);
  const redacted = vault.redact(question.trim());
  await vault.save();
  const metric = { latencyMs: 0, stages, tokensSentToCloud: 0, outboundChunks: 0, piiItemsRedacted: redacted.count, guardBlocks: 0, receiptVerified: false, actualCostUsd: 0, allCloudCostUsdAssumption: 0 };
  const emit = async (type, step, caption, actor = 'local', data = {}) => {
    const event = { id: `${runId}-${events.length}`, type, step, at: Math.round(performance.now() - started), caption, actor, data };
    events.push(event); await onEvent?.(event);
  };
  await emit('received', 1, 'Your question stays on this machine');
  await emit('thinking', 3, `${modelName} is searching your local documents`);
  const countTokens = dependencies.countTokens ?? (lockedCompanyRouting||!dependencies.retrieve&&retrievalEnabled ? await localBudgetCounter() : undefined);
  const retrieval = retrievalEnabled ? await (dependencies.retrieve ?? retrieveComplete)(redacted.text, {
    dataDir, topK: ragConfig.completeRetrievalTopK ?? 8, tokenBudget: ragConfig.localContextTokenBudget ?? 1800, vault, ...(countTokens ? { countTokens } : {}),
  }) : { chunks: [], quality: 0, latencyMs: 0, embeddingModel: 'control-no-retrieval', completeness: { score: 0, requiredFacets: [], coveredFacets: [], missingFacets: [] } };
  const chunks = retrieval.chunks;
  const completeness = Number.isFinite(retrieval.completeness?.score) ? retrieval.completeness.score : 0;
  Object.assign(metric, { evidenceCompleteness: completeness, evidenceCompletenessMethod: retrieval.completeness?.method ?? 'not measured',
    retrievalQueryCount: retrieval.queryCount ?? 0, retrievalTokenCount: retrieval.tokenCount ?? null,
    retrievalTokenBudget: retrieval.tokenBudget ?? ragConfig.localContextTokenBudget ?? 1800,
    missingEvidenceFacets: retrieval.completeness?.missingFacets ?? [], bestMatchScore: retrieval.bestMatchScore ?? retrieval.quality });
  metric.piiItemsRedacted += chunks.reduce((sum, chunk) => sum + countPlaceholders(chunk.text), 0);
  stages.push({ stage: 'retrieval', modelId: retrieval.embeddingModel?.model ?? retrieval.embeddingModel, latencyMs: retrieval.latencyMs, tokens: { input: 0, output: 0, total: 0 } });
  const routingTask=lockedCompanyRouting?inferGatewayTask(redacted.text,retrieval,{id:runId,localOnly,task}):null;
  const companyTask=lockedCompanyRouting&&/^company-data(?:[ -]|$)/.test(String(routingTask.category));
  const effectiveLocalOnly=localOnly||Boolean(task&&!isCloudEligible(task))||lockedCompanyRouting&&!isCloudEligible(routingTask);
  const calibration=lockedCompanyRouting?await loadLockedPolicy():null;
  await emit('thinking', 3, lockedCompanyRouting&&!companyTask?'The locked general policy requests a safe cloud handoff':`${modelName} is answering from the retrieved evidence`);
  const context = chunks.map(chunk => `[${chunk.chunkId}]\n${chunk.text}`).join('\n\n');
  const toolResult = lockedCompanyRouting&&(!companyTask||effectiveLocalOnly)?{status:'not_applicable'}:await (dependencies.calculateLocal ?? calculateLocal)(redacted.text, chunks);
  const prepared={
    question: redacted.text, chunks, retrievalScore: lockedCompanyRouting?(retrieval.bestMatchScore??retrieval.quality):retrieval.quality,
    ...(lockedCompanyRouting?{bestMatchScore:retrieval.bestMatchScore??retrieval.quality}:{}),
    sourceDocCount: new Set(chunks.map(chunk => chunk.file)).size, completeness: retrieval.completeness,
  };
  const generated = lockedCompanyRouting&&(!companyTask||effectiveLocalOnly)?skippedGeneralAnswer(prepared):await generateLocalAnswer(activeModel, prepared, {
    item: lockedCompanyRouting?routingTask:{ category: 'company-data', suite: 'company-rag' },
    answerMaxTokens: ragConfig.structuredAnswerMaxTokens ?? 768, requireClaimCitations: true, toolResult,
    dependencies: { call: dependencies.localChat ?? localChat },
    onStage: async stage => {
      stages.push(stage);
      if (stage.stage === 'local_answer' || stage.stage === 'local_calculator') await emit('thinking', 4, `${modelName} is checking its answer against the local evidence`);
    },
  });
  const parsed = generated.answer;
  const localEvidence = generated.prepared?.chunks ?? chunks;
  const citedIds = new Set(parsed.citations.map(citation => citation.chunkId));
  const validCitations = localEvidence.filter(chunk => citedIds.has(chunk.chunkId));
  const originalSourceCitations = chunks.filter(chunk => citedIds.has(chunk.chunkId));
  const grounded = parsed.features.hasValidCitations;
  Object.assign(metric, {
    lockedCompanyRoutingEnabled:lockedCompanyRouting,configuredLocalModelId:activeModel,localModelId:generated.generationSkipped?'code-policy-abstention':activeModel,generationSkipped:Boolean(generated.generationSkipped),
    localAnswerVersion: generated.version, localRoutingSource: parsed.routingSource,
    answerParseFailures: Number(!parsed.parseValid), selfCheckParseFailures: Number(!parsed.selfCheckParseValid),
    invalidCitationItems: Number(parsed.citationAudit.hadInvalidIds), invalidCitationIds: parsed.citationAudit.invalidIds.length + parsed.citationAudit.malformedCount,
    repairedCitationIds: parsed.citationAudit.repaired.length, rejectedCitationIds: parsed.citationAudit.remainingInvalidCount,
    missingRequiredCitations: Number(parsed.citationAudit.missingRequired),
    missingClaimCitations: parsed.claimAudit?.missingClaimCount ?? null, factualClaimCount: parsed.claimAudit?.factualClaimCount ?? null,
    citedClaimCount: parsed.claimAudit?.coveredClaimCount ?? null, claimCitationCoverage: parsed.claimAudit?.coverage ?? null,
    calculatorStatus: toolResult.status, calculatorIntent: toolResult.arithmeticIntent ?? null,
    calculatorSourceCount: toolResult.sourceChunkIds?.length ?? 0, calculatorUsed: Boolean(generated.calculator),
    localAnswerLatencyMs: generated.stages.find(stage => stage.stage === 'local_answer' || stage.stage === 'local_calculator')?.latencyMs ?? null,
    localSelfCheckLatencyMs: generated.stages.find(stage => stage.stage === 'local_self_check')?.latencyMs ?? null,
    localTokens: generated.stages.reduce((sum, stage) => ({ input: sum.input + (stage.tokens?.input ?? 0), output: sum.output + (stage.tokens?.output ?? 0), total: sum.total + (stage.tokens?.total ?? 0) }), { input: 0, output: 0, total: 0 }),
  });
  await emit('self_check', 4, 'The separate local self-check is complete', 'local', {
    confidence: parsed.confidence, evidenceSupported: parsed.selfCheck.evidenceSupported,
    answerComplete: parsed.selfCheck.answerComplete, parseValid: parsed.selfCheckParseValid,
    issues: parsed.selfCheck.issues,
    invalidCitations: metric.invalidCitationIds, repairedCitations: metric.repairedCitationIds,
  });
  const lockedDecision=lockedCompanyRouting?decideLockedRoute(routingTask,generated,generated.prepared??prepared,calibration,{modelId:activeModel}):null;
  const routeLocal = lockedCompanyRouting?lockedDecision.accepted:parsed.confidence >= ragConfig.confidenceThreshold && retrieval.quality >= ragConfig.retrievalQualityThreshold && completeness >= 1 && grounded && parsed.needsCloud !== true;
  const reason = lockedCompanyRouting?lockedDecision.reason:routeLocal ? 'Local self-check, evidence completeness, retrieval quality and claim citations passed' : !parsed.parseValid ? 'Local answer format failed validation' : !parsed.selfCheckParseValid ? 'Local self-check format failed validation' : completeness < 1 ? 'Required local source evidence is incomplete' : !grounded || parsed.claimAudit?.complete === false ? 'A factual claim lacks valid local evidence citations' : retrieval.quality < ragConfig.retrievalQualityThreshold ? 'Retrieval quality is below threshold' : parsed.needsCloud ? 'The local self-check found an unsupported or incomplete answer' : 'Local self-check confidence is below threshold';
  if(lockedDecision)Object.assign(metric,{lockedPolicyHash:LOCKED_POLICY_HASH,lockedRouting:{...lockedDecision,classificationMethod:routingTask.classificationMethod,category:routingTask.category,futureCertified:false}});
  await emit('confidence', 4, `${modelName} checked its confidence and source coverage`, 'local', { confidence: parsed.confidence, reason,...(lockedDecision?{policyHash:LOCKED_POLICY_HASH,predictedWrongness:lockedDecision.predictedWrongness,threshold:lockedDecision.threshold,futureCertified:false}:{} ) });
  const prices = JSON.parse(await readFile(new URL('../../config/rag-pricing.json', import.meta.url), 'utf8'));
  const inputPrice = prices.museInputPerMillionUsd;
  const outputPrice = prices.museOutputPerMillionUsd;
  const price = (input, output) => (input * inputPrice + output * outputPrice) / 1e6;
  const liveConfig=await readLiveMuseConfig(),outputProjections=JSON.parse(await readFile(new URL('../../config/pricing.yaml',import.meta.url),'utf8')).outputProjections;
  const outputProjection=outputProjections[routingTask?.category??'company-data multi-doc']??{answerTokens:prices.expectedOutputTokens,reasoningTokens:128};
  metric.estimatedCloudVisibleOutputTokens=outputProjection.answerTokens;
  metric.estimatedCloudReasoningTokens=outputProjection.reasoningTokens;
  metric.estimatedCloudOutputTokens = outputProjection.answerTokens+outputProjection.reasoningTokens;
  metric.cloudCompletionTokenCap=liveConfig.maxCompletionTokens;
  metric.estimatedAllCloudInputTokens = estimateTokens(redacted.text + context) + 140;
  metric.allCloudCostUsdAssumption = price(metric.estimatedAllCloudInputTokens, metric.estimatedCloudOutputTokens);
  metric.estimatedCloudInputTokens = 0;
  metric.projectedHandoffCostUsd = 0;
  let receipt, outbound = { question: '', chunks: [] }, answer = parsed.renderedAnswer ?? parsed.answer, route = 'local', status = 'ok', citationChunks = validCitations;
  if (routeLocal || effectiveLocalOnly) {
    if (!routeLocal) { route = lockedCompanyRouting?'blocked_local':'deferred_cloud'; status = route; answer = lockedCompanyRouting?'This local-only request is blocked from all cloud services.':'The local evidence is insufficient for a reliable answer. Cloud assistance is deferred.'; citationChunks = []; }
    await emit('decision', 5, routeLocal ? 'The answer stays local' : 'This local-only task will not reach a cloud API', 'local', { route: routeLocal ? 'local' : route, reason });
  } else {
    route = 'deferred_cloud';
    // Source data never becomes a proposed cloud request. Only an abstract
    // question that passed every local layer can obtain a release permit.
    const cloudItem=routingTask??inferGatewayTask(redacted.text,retrieval,{id:runId,localOnly,task});
    const privateItem={...cloudItem,content:JSON.stringify({question:question.trim(),evidence:chunks.map(chunk=>({chunkId:chunk.chunkId,text:vault.restore(chunk.text)}))})};
    const boundaryOptions={lens:'meta',dataDir:path.join(dataDir,'question-privacy'),shadowEvaluation:false,dependencies:dependencies.privacyDependencies??{}};
    const privacyBoundary=dependencies.questionBoundary?await dependencies.questionBoundary(privateItem,boundaryOptions):await screenQuestionOnly(await prepareQuestionOnly(privateItem,boundaryOptions),boundaryOptions);
    metric.questionOnlyBoundary={method:'question-only-layered-privacy-v4',sourceHash:privacyBoundary.sourceHash,questionHash:privacyBoundary.questionHash,status:privacyBoundary.liveEligible?'PASS':privacyBoundary.injectionPending?'PENDING':'BLOCKED',blockedByLayer:privacyBoundary.blockedByLayer??[],stages:privacyBoundary.stages??[],injectionPending:privacyBoundary.injectionPending===true};
    if(!privacyBoundary.liveEligible){
      metric.guardBlocks+=1;metric.projectedHandoffCostUsd=0;status='blocked_local';route='blocked_local';citationChunks=[];
      answer=privacyBoundary.injectionPending?'The private question boundary is pending local Prompt Guard weights. Nothing was sent.':'The private question boundary blocked this handoff. Nothing was sent.';
      await emit('blocked',2,'The question-only privacy boundary kept this task local','guard',{route,status:privacyBoundary.injectionPending?'pending_privacy':'blocked_local'});
    }else{
    const cloudInput=buildQuestionOnlyPayload(privacyBoundary.question);
    outbound={question:privacyBoundary.question,chunks:[]};
    Object.assign(metric,{handoffPayloadHash:sha256(cloudInput),handoffVariant:'general-question-only',localDraftSent:false,proposedChunks:0});
    metric.estimatedCloudInputTokens = estimateTokens(cloudInput);
    metric.projectedHandoffCostUsd = price(metric.estimatedCloudInputTokens, metric.estimatedCloudOutputTokens);
    assertNoResidualPii(cloudInput, vault);
    await emit('screened', 2, 'Llama Guard is screening the redacted handoff', 'guard', { status: 'checking' });
    const outboundGuard = await screenForCloud(cloudInput,{guard:dependencies.guardText??guardText,localOnly:effectiveLocalOnly,allowInjectedLegacy:Boolean(dependencies.guardText)});
    stages.push({ stage: 'guard_outbound', ...outboundGuard, text: undefined,releasePermit:undefined });
    Object.assign(metric,{guardOutboundVerdict:outboundGuard.classification,guardOutboundCategories:outboundGuard.safetyCategories,wouldReleaseToCloud:outboundGuard.wouldRelease,guardScreenedInputHash:outboundGuard.inputHash});
    if (!outboundGuard.safe) {
      metric.guardBlocks += 1; status = 'blocked_local'; route = 'blocked_local'; answer = 'The local safety boundary blocked this request. Nothing was sent to Muse Spark.'; citationChunks = [];
      metric.projectedHandoffCostUsd = 0;
      outbound = { question: '', chunks: [] };
      await emit('blocked', 2, 'Guard kept the request on this machine', 'guard', { route: 'blocked_local', reason: outboundGuard.reason });
    } else {
      const canSend = !offlineMeta && metaAccessEnabled();
      await recordOutboundPayload({ runId, input: cloudInput, outbound }, { dataDir });
      await emit('decision', 5, canSend ? 'Only the minimum redacted evidence can be handed off' : 'Muse Spark is paused, this safe handoff is deferred', 'guard', { route: canSend ? 'cloud' : 'deferred_cloud', reason });
      const payload = { version: 1, runId, timestamp: new Date().toISOString(), modelId: ragConfig.cloudModel, status: canSend ? 'prepared' : 'deferred', inputHash: sha256(cloudInput), chunks: outbound.chunks.map(chunk => ({ chunkId: chunk.id, hash: chunk.hash })), estimatedInputTokens: estimateTokens(cloudInput), actualChunksSent: 0, guardOutbound: 'safe', methodVersion: ragConfig.methodVersion };
      receipt = await signReceipt(payload, { dataDir });
      receipt = await appendReceipt(receipt, { dataDir });
      if (!canSend) {
        status = 'deferred_cloud'; answer = 'A safe handoff is needed, but Meta access is paused. The cloud answer is deferred and no request was sent.'; citationChunks = [];
      } else {
        await emit('handed_off', 5, 'Guard approved the redacted handoff to Muse Spark', 'guard', { route: 'cloud' });
          await emit('thinking', 5, 'Muse Spark is considering the generalized question', 'cloud');
        try {
          // The question trace UUID must never reset a multi-question spend cap.
          // Only operator environment or a trusted server caller selects a run.
          const cloud = await (dependencies.callMuse ?? callMuse)(cloudInput, { offlineMeta: false,releasePermit:outboundGuard.releasePermit,questionReleasePermit:privacyBoundary.releasePermit,item:cloudItem,registry:createCloudPolicyRegistry([cloudItem]),liveRunId,dataDir });
          metric.tokensSentToCloud = cloud.tokens.input; metric.outboundChunks = outbound.chunks.length;
          metric.actualCostUsd = cloud.providerCostUsd ?? null;
          metric.cloudCostUnknown = cloud.providerCostUsd == null;
          metric.estimatedCloudCostUsd = price(cloud.tokens.input, cloud.tokens.output);
          stages.push({ stage: 'cloud_answer', ...cloud, text: undefined });
          const inboundCheck=await (dependencies.checkIncomingAnswer??checkIncomingAnswer)(privacyBoundary,cloud.text,{dependencies:dependencies.privacyDependencies??{}});
          stages.push(...inboundCheck.stages.map(stage=>({stage:'privacy_inbound_'+stage.layerId,...stage})));
          const inboundGuard={safe:inboundCheck.operationalPassed===true};
          if(!inboundGuard.safe){metric.guardBlocks+=1;route='blocked_local';status='blocked_local';answer='The incoming guidance was blocked by the local privacy boundary.';citationChunks=[];}
          else{const applied=await (dependencies.applyAnswerLocally??applyAnswerLocally)(privacyBoundary,inboundCheck,{localContext:chunks.map(chunk=>({...chunk,text:vault.restore(chunk.text)})),dependencies:dependencies.privacyDependencies??{}});stages.push({stage:'local_apply',...applied.stage});route='cloud';answer=applied.answer;citationChunks=chunks.filter(chunk=>applied.citations.includes(chunk.chunkId));}
          receipt = await signReceipt({ ...payload, status: inboundGuard.safe ? 'completed' : 'inbound_blocked', actualChunksSent: outbound.chunks.length, responseHash: sha256(cloud.text), guardInbound: inboundGuard.safe ? 'safe' : 'unsafe', responseId: cloud.responseId, tokens: cloud.tokens }, { dataDir });
          receipt = await appendReceipt(receipt, { dataDir });
        } catch (error) {
          metric.cloudFailureCode=/^LIVE_[A-Z_]+$/.test(error.code??'')?error.code:'CLOUD_REQUEST_FAILED';
          if(error.tokens){metric.tokensSentToCloud=error.tokens.input;metric.outboundChunks=outbound.chunks.length;metric.estimatedCloudCostUsd=price(error.tokens.input,error.tokens.output);}
          status = 'deferred_cloud'; answer = error.code==='LIVE_EMPTY_OUTPUT'?'Muse Spark returned no answer text. This item remains deferred.':'The cloud request failed. This item remains deferred for a later retry.'; citationChunks = [];
          metric.cloudCostUnknown = true; metric.actualCostUsd = null; metric.cloudDeliveryUnknown = true;
          receipt = await signReceipt({ ...payload, status: 'request_failed', actualChunksSent: null, attemptedChunks: outbound.chunks.length, delivery: 'unknown' }, { dataDir });
          receipt = await appendReceipt(receipt, { dataDir });
        }
      }
      metric.receiptVerified = await verifyReceipt(receipt, { dataDir });
      if (!metric.receiptVerified) throw new Error('Receipt verification failed');
    }
  }
  }
  metric.latencyMs = Math.round(performance.now() - started);
  const citations = citationChunks.map(({ file, chunkId, location, hash }) => ({ file, chunkId, location, hash }));
  const result = { runId, status, route, answer: vault.restore(answer), citations, confidence: parsed.confidence, retrievalQuality: retrieval.quality, evidenceCompleteness: completeness, reason, metrics: metric, receipt, outbound, events, retrievalChunks: chunks.length,localModelId:metric.localModelId,lockedCompanyRoutingEnabled:lockedCompanyRouting };
  await emit('answered', 6, status === 'ok' ? 'A cited answer is ready on your machine' : 'The boundary decision is recorded locally', route === 'cloud' ? 'cloud' : 'local', { answer: result.answer, route, latencyMs: metric.latencyMs });
  await mkdir(logDirectory, { recursive: true });
  await appendFile(path.join(logDirectory, 'events.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), runId, modelId: metric.localModelId, cloudModelId: ragConfig.cloudModel, questionHash: sha256(question), route, status, confidence: parsed.confidence, retrievalQuality: retrieval.quality, reason, metrics: metric, settings: {...ragConfig,lockedCompanyRoutingEnabled:lockedCompanyRouting}, chunkHashes: outbound.chunks.map(chunk => chunk.hash), receiptSignature: receipt?.signature }) + '\n');
  return result;
}
