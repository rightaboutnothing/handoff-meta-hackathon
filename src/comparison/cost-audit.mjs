import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFile, mkdir, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { buildPipelineMatrix, comparisonConfig } from './matrix.mjs';
import { loadComparisonDataset, loadComparisonManifest } from './dataset.mjs';
import { prepareContext, attachRestorer, parseAnswer } from './context.mjs';
import { createPrivacyVault, assertNoResidualPii } from '../rag/privacy.mjs';
import { createLocalTokenCounters } from '../server/token-counts.mjs';
import { comparisonLocal, loadPricing, CLOUD_MODELS, COMPARISON_SETTINGS } from '../server/comparison-models.mjs';
import { buildLeanPayload, serializeLeanUserPayload } from './handoff-payload.mjs';
import { summarizeCloudCosts, compareCostIdentity, legacyCostBridge } from './cost-metrics.mjs';
import { loadAuditManifest, auditLocalAnswers, AUDIT_MODELS, summarizePromptAblation } from './grading-audit.mjs';
import { scoreItem } from './scoring.mjs';
import { isCloudEligible } from './policy.mjs';
import { atomicJson, appendCheckpoint, readCheckpoints, retryItem, installTier0NetworkBoundary } from './runner.mjs';
import { acquireRunLock } from './run-lock.mjs';
import { recordEnvironment } from './hardware.mjs';
import { verifySyntheticSource } from './corpus.mjs';
import { listDocumentFiles, extractDocument, chunkText, stableChunkId } from '../rag/documents.mjs';
import { LocalVectorStore } from '../rag/store.mjs';
import { openReceiptJournal } from './receipt-journal.mjs';
import { sha256, canonicalJSON, recordOutboundPayload, signReceipt } from '../rag/receipts.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const sourceRun='2026-10-28-meta-google-tier0';
const configuration=JSON.parse(await readFile(new URL('../../config/handoff-cost.json',import.meta.url),'utf8'));
const fmt=value=>value==null?'pending':Number(value).toFixed(4);
const pct=value=>value==null?'pending':`${(value*100).toFixed(1)}%`;
const estimate=metric=>metric?.estimate??null;
const interval=metric=>`${pct(estimate(metric))}${metric?.ci95?` [${metric.ci95.map(pct).join(', ')}]`:' [CI pending]'}`;

export function categoryProjection(category,pricing){
  const value=pricing.outputProjections?.[category];
  if(!value||![value.answerTokens,value.reasoningTokens].every(n=>Number.isInteger(n)&&n>=0)||value.answerTokens+value.reasoningTokens>COMPARISON_SETTINGS.maxTokens)throw new Error('A valid per-item-type projected output length within the output cap is required');
  return value;
}
export function costPopulationWeights(items,core){
  const key=item=>`${item.category}|${isCloudEligible(item)}`,sample=new Map(),population=new Map();
  for(const item of items)sample.set(key(item),(sample.get(key(item))??0)+1);
  for(const item of core)population.set(key(item),(population.get(key(item))??0)+1);
  for(const stratum of population.keys())if(!sample.has(stratum))throw new Error('Cost sample lacks a core category/eligibility stratum');
  return new Map(items.map(item=>[item.id,(population.get(key(item))??0)/core.length/sample.get(key(item))]));
}
function components(count){return{...count.components};}
export function plainPrompt(prepared){
  const start=prepared.input.indexOf('\n\nQUESTION:\n');if(start<0)throw new Error('Original prompt body is unavailable for a controlled format ablation');
  const semanticLines=prepared.input.slice(0,start).split('\n').slice(2).map(line=>line.replace('so use an empty citations array.','so do not add company citations.'));
  return['Answer the task concisely.',...semanticLines].join('\n')+prepared.input.slice(start);
}
function plainAnswer(text,prepared){const ids=[...new Set([...String(text).matchAll(/\[([^\]\n]+)\]/g)].map(match=>match[1]))];return{answer:String(text),parseValid:true,citations:ids.map(chunkId=>({chunkId,file:prepared.chunks.find(chunk=>chunk.chunkId===chunkId)?.file??null}))};}
export function addFramingSensitivity(plans,rows,pricing){
  for(const plan of plans){const selected=rows.filter(row=>row.pipelineId===plan.pipelineId&&row.variant===plan.variant),denominator=selected.reduce((sum,row)=>sum+row.weight,0),handWeight=selected.filter(row=>row.handedOff).reduce((sum,row)=>sum+row.weight,0)/denominator,baseWeight=selected.filter(row=>row.eligible).reduce((sum,row)=>sum+row.weight,0)/denominator,rate=pricing.clouds[plan.cloudId].inputUsdPerMillion;plan.framingSensitivity=pricing.framingSensitivityTokensPerRequest.map(tokens=>({additionalTokensPerRequestAssumed:tokens,costPer1000AllQueriesUsd:plan.costPer1000AllQueriesUsd+handWeight*tokens*rate/1000,cloudOnlyCostPer1000AllQueriesUsd:plan.cloudOnlyCostPer1000AllQueriesUsd+baseWeight*tokens*rate/1000,costPer1000HandedOffQueriesUsd:plan.costPer1000HandedOffQueriesUsd==null?null:plan.costPer1000HandedOffQueriesUsd+tokens*rate/1000}));}
  return plans;
}
export async function verifyAuditCorpus(dataDir,vault,manifest){
  const folder=path.join(root,'demo_data');await verifySyntheticSource(folder,manifest.companyCorpus.files);
  const source=await listDocumentFiles(folder),expected=new Map();
  for(const file of source.files)for(const unit of await extractDocument(file.absolutePath)){const clean=vault.redact(unit.text).text;chunkText(clean).forEach((text,index)=>expected.set(stableChunkId(file.file,unit.location,index),sha256(text)));}
  const store=new LocalVectorStore({dataDir});try{const actual=store.database.prepare('SELECT chunk_id,hash,text FROM chunks').all();if(actual.length!==expected.size||actual.some(chunk=>expected.get(chunk.chunk_id)!==chunk.hash||sha256(chunk.text)!==chunk.hash))throw new Error('Audit index differs from the pinned synthetic corpus; restore the synthetic index before comparing prompts');return{chunks:actual.length,corpusHash:sha256([...expected].sort())};}finally{store.close();}
}
export async function costStudyFingerprint(){
  const names=['package-lock.json','tasks/comparison/manifest.json','tasks/comparison/grading-audit-manifest.json'];
  for(const dir of ['config','src/comparison','src/server','src/scoring','src/rag'])for(const file of await readdir(path.join(root,dir)))if(/\.(mjs|json|yaml)$/.test(file))names.push(`${dir}/${file}`);
  const files={};for(const name of names.sort())files[name]=sha256((await readFile(path.join(root,name),'utf8')).replace(/\r\n/g,'\n'));
  return{hash:sha256(files),files,gitCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim()};
}

export async function reviseTier0Costs({runId='2026-10-28-tier0-payload-costs',dataDir=path.join(root,'.handoff'),log=event=>console.error(JSON.stringify(event))}={}){
  if(!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,90}$/.test(runId))throw new Error('A safe cost-study run ID is required');
  const privateDir=path.join(root,'.logs/comparison-cost',runId),publicDir=path.join(root,'results',runId),oldPrivate=path.join(root,'.logs/comparison',sourceRun);
  await mkdir(privateDir,{recursive:true});
  const release=await acquireRunLock(path.join(privateDir,'run.lock'),{owner:{runId,purpose:'zero-cloud-cost-audit'}}),boundary=installTier0NetworkBoundary();let journal=null,receiptReport=null;
  const progress=async event=>{const row={at:new Date().toISOString(),runId,tier:0,cloudInferenceCalls:0,remoteCountingCalls:0,actualSpendUsd:0,...event};await appendCheckpoint(path.join(privateDir,'progress.jsonl'),row);log(row);};
  try{
    const [previous,manifest,pricing,counters,auditManifest,environment,fingerprint]=await Promise.all([
      readFile(path.join(root,'results',sourceRun,'report.json'),'utf8').then(JSON.parse),loadComparisonManifest(),loadPricing(),createLocalTokenCounters(),loadAuditManifest(),recordEnvironment(),costStudyFingerprint()]);
    const identity={source:fingerprint.hash,manifest:sha256(manifest),auditManifest:sha256(auditManifest),tokenizers:sha256(counters.metadata),settings:comparisonConfig,leanSettings:configuration,modelDigests:environment.ollamaModels.map(model=>[model.modelId,model.digest]).sort()};
    const priorState=await readFile(path.join(privateDir,'study.json'),'utf8').then(JSON.parse).catch(error=>{if(error.code==='ENOENT')return null;throw error;});
    if(pricing.serverFramingTokensAssumed!==0)throw new Error('Headline counts measured content only; use the separately reported framing sensitivity for unmeasured server framing');
    if(priorState&&sha256(priorState.identity)!==sha256(identity))throw new Error('Cost-audit resume denied: frozen code/settings/tokenizers/models changed');
    for(const modelId of AUDIT_MODELS){const before=previous.environment.ollamaModels.find(row=>row.modelId===modelId),after=environment.ollamaModels.find(row=>row.modelId===modelId);if(!before||!after||before.digest!==after.digest)throw new Error('Audit model weights differ from the originally reported comparison');}
    await atomicJson(path.join(privateDir,'study.json'),{identity,fingerprint,environment});
    const costItems=await loadComparisonDataset({split:'tier0-test'}),core=await loadComparisonDataset({split:'core'}),ids=[...new Set([...auditManifest.itemIds,...auditManifest.originalReportedTestIds])],auditItems=await loadComparisonDataset({split:'test',ids}),allItems=[...new Map([...costItems,...auditItems].map(item=>[item.id,item])).values()];
    if(allItems.some(item=>!item.available))throw new Error('Gated audit items must be hydrated locally; never replace them with fake questions');
    const vault=await createPrivacyVault(dataDir),corpus=await verifyAuditCorpus(dataDir,vault,manifest),preparedById=new Map();
    const weights=costPopulationWeights(costItems,core);
    for(const item of allItems){const file=path.join(privateDir,'contexts',sha256(item.id)+'.json');let prepared;
      try{prepared=JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code!=='ENOENT')throw error;try{prepared=JSON.parse(await readFile(path.join(oldPrivate,'contexts',sha256(item.id)+'.json'),'utf8'));}catch(oldError){if(oldError.code!=='ENOENT')throw oldError;prepared=await retryItem(()=>prepareContext(item,{dataDir,vault}));}await atomicJson(file,prepared);}
      preparedById.set(item.id,await attachRestorer(prepared,{dataDir,vault}));
    }
    const oldRecords=await readCheckpoints(path.join(oldPrivate,'local.jsonl')),originalFile=path.join(privateDir,'audit-original.jsonl'),plainFile=path.join(privateDir,'audit-plain.jsonl');
    const original=new Map([...oldRecords,...await readCheckpoints(originalFile)].map(row=>[`${row.modelId}|${row.id}`,row])),plain=new Map((await readCheckpoints(plainFile)).map(row=>[`${row.modelId}|${row.id}`,row]));
    const byItem=new Map(allItems.map(item=>[item.id,item]));
    // Every new answer is local, under the original temperature/seed/output cap.
    // The plain-answer ablation is a separate predeclared prompt experiment.
    for(const modelId of AUDIT_MODELS){
      const work=[...auditItems.filter(item=>!original.has(`${modelId}|${item.id}`)).map(item=>({item,kind:'original'})),...(auditManifest.promptAblationIds??[]).filter(id=>!plain.has(`${modelId}|${id}`)).map(id=>({item:byItem.get(id),kind:'plain'}))];
      if(work.length){const warm=await retryItem(()=>comparisonLocal(modelId,[{role:'user',content:'Reply with OK.'}],{maxTokens:8,json:false}));await progress({phase:'warm-up',modelId,latencyMs:warm.latencyMs,excludedFromTimings:true});}
      for(const[at,{item,kind}]of work.entries()){
        const prepared=preparedById.get(item.id),input=kind==='plain'?plainPrompt(prepared):prepared.input;let row;
        try{const raw=await retryItem(()=>comparisonLocal(modelId,[{role:'user',content:input}],{maxTokens:COMPARISON_SETTINGS.maxTokens,json:false}));const answer=kind==='plain'?plainAnswer(raw.text,prepared):parseAnswer(raw.text,prepared);const scoring=scoreItem(item,{answer:prepared.restore(answer.answer),citations:answer.citations,status:'ok',route:'local'});row={id:item.id,modelId,kind,inputHash:sha256(input),raw,answer,scoring,sourceHash:fingerprint.hash,environmentHash:environment.sha256};}
        catch{row={id:item.id,modelId,kind,error:'LOCAL_AUDIT_FAILED',inputHash:sha256(input),scoring:{labelAvailable:false},answer:{answer:'',citations:[]},sourceHash:fingerprint.hash};}
        await appendCheckpoint(kind==='plain'?plainFile:originalFile,row);(kind==='plain'?plain:original).set(`${modelId}|${item.id}`,row);await progress({phase:'local-grading-audit',modelId,promptVariant:kind,completed:at+1,total:work.length,itemId:item.id,status:row.error?'error':'ok'});
      }
    }
    const recordsFor=(map)=>Object.fromEntries(AUDIT_MODELS.map(modelId=>[modelId,allItems.flatMap(item=>{const record=map.get(`${modelId}|${item.id}`);if(!record)return[];const prepared=preparedById.get(item.id);return[{...record,answerForGrading:prepared.restore(record.answer?.answer??''),rawForGrading:prepared.restore(record.raw?.text??'')}];})]));
    const recordsByModel=recordsFor(original),gradingAudit=auditLocalAnswers({items:auditItems,recordsByModel,manifest:auditManifest});
    if(auditManifest.promptAblationIds?.length)gradingAudit.promptFormatAblation=summarizePromptAblation({items:auditItems,originalRecordsByModel:recordsByModel,plainRecordsByModel:recordsFor(plain),manifest:auditManifest});
    await atomicJson(path.join(privateDir,'grading-audit.json'),gradingAudit);
    const frozenResults=await readCheckpoints(path.join(oldPrivate,'results.jsonl')),routes=new Map(frozenResults.map(row=>[`${row.pipelineId}|${row.id}`,row]));
    const matrix=buildPipelineMatrix(),rows=[],payloads=new Map(),payloadMemo=new Map(),legacySources={handoff:[],baseline:[]};
    const budgetCount=text=>Math.max(counters.countText('gemini',text),counters.countText('muse-spark',text));
    const redactText=text=>{vault.registerNames([...String(text).matchAll(/\bCANARY-[A-Za-z0-9_-]+\b/gi)].map(match=>match[0]));const redacted=vault.redact(text);assertNoResidualPii(redacted.text,vault);return redacted.text;};
    for(const item of costItems){
      const prepared=preparedById.get(item.id);
      for(const variant of configuration.variants)for(const pipeline of matrix){
        const includeDraft=variant==='with-draft'&&Boolean(pipeline.localModelId),memoKey=`${item.id}|${includeDraft?pipeline.localModelId:'none'}`;
        let payload=payloadMemo.get(memoKey);
        if(!payload){const local=original.get(`${pipeline.localModelId}|${item.id}`)??oldRecords.find(row=>row.modelId===pipeline.localModelId&&row.id===item.id);payload=await buildLeanPayload(item,prepared,{...configuration,includeDraft,draft:local?.answer,redactText,countText:budgetCount,budgetTokenizer:configuration.budgetTokenizer});payloadMemo.set(memoKey,payload);}
        const baseKey=`${item.id}|none`;let baseline=payloadMemo.get(baseKey);if(!baseline){baseline=await buildLeanPayload(item,prepared,{...configuration,includeDraft:false,countText:budgetCount,budgetTokenizer:configuration.budgetTokenizer});payloadMemo.set(baseKey,baseline);}
        for(const candidate of [payload,baseline])if(candidate.eligible&&!payloads.has(candidate.payloadHash)){await atomicJson(path.join(privateDir,'payloads',candidate.payloadHash+'.json'),{wire:candidate.wire,userText:serializeLeanUserPayload(candidate),payloadHash:candidate.payloadHash,localAudit:candidate.localAudit});payloads.set(candidate.payloadHash,candidate);}
        const provider=pipeline.cloudId??'muse-spark',count=counters.countPayload(provider,payload),baseCount=counters.countPayload(provider,baseline),old=routes.get(`${pipeline.id}|${item.id}`),eligible=isCloudEligible(item),handedOff=eligible&&pipeline.kind!=='local-only'&&(pipeline.kind==='cloud-only'||old?.handoff===true),output=categoryProjection(item.category,pricing);
        if(eligible&&pipeline.kind!=='cloud-only'&&pipeline.kind!=='local-only'&&!old)throw new Error('Frozen routing outcome is missing; do not invent a handoff share');
        rows.push({id:item.id,groupId:item.groupId,category:item.category,pipelineId:pipeline.id,localModelId:pipeline.localModelId,cloudId:provider,variant,eligible,handedOff,inputTokens:count.inputTokens,baselineInputTokens:baseCount.inputTokens,projectedOutputTokens:output.answerTokens,projectedReasoningTokens:output.reasoningTokens,inputComponents:components(count),baselineInputComponents:components(baseCount),payloadHash:payload.payloadHash,baselinePayloadHash:baseline.payloadHash,tokenMethod:count.metadata.method,serverFramingKnown:false,serverFramingTokens:null,weight:weights.get(item.id)});
      }
      if(isCloudEligible(item)){
        const input=prepared.input,q=input.indexOf('QUESTION:\n'),e=input.indexOf('LOCAL EVIDENCE:\n'),a=counters.countText('gemini',input.slice(0,q)),b=counters.countText('gemini',input.slice(0,e)),total=counters.countText('gemini',input),value={instructions:a,query:b-a,retrievedContext:total-b,localDraft:0,separators:0,guardWrapper:0,receiptMetadata:0,piiMap:0,total};
        legacySources.baseline.push({weight:weights.get(item.id),value});if(routes.get(`llama8b+llamaguard+gemini|${item.id}`)?.handoff)legacySources.handoff.push({weight:weights.get(item.id),value});
      }
    }
    await vault.save();
    await atomicJson(path.join(privateDir,'payload-token-counts.json'),rows);
    const receiptDir=path.join(dataDir,'comparison-cost',runId);journal=await openReceiptJournal({dataDir:receiptDir});
    for(const[hash,payload]of payloads)for(const cloudId of ['muse-spark','gemini']){const id=sha256(`${cloudId}|${hash}`),input=canonicalJSON({system:payload.system,user:serializeLeanUserPayload(payload)}),outbound={chunks:payload.context.map(chunk=>({id:chunk.chunkId,text:chunk.text,hash:sha256(chunk.text)}))};const snapshot=await recordOutboundPayload({runId:id,input,outbound},{dataDir:receiptDir});const receipt=await signReceipt({runId:id,inputHash:snapshot.inputHash,kind:'tier0_cost_payload',status:'counterfactual_not_sent',modelId:CLOUD_MODELS[cloudId],wireHash:hash,chunks:outbound.chunks.map(chunk=>({chunkId:chunk.id,hash:chunk.hash})),createdAt:new Date().toISOString()},{dataDir:receiptDir});await journal.append(receipt);}
    receiptReport=await journal.close();if(!receiptReport.valid)throw new Error('Lean payload receipt audit failed; publication refused');
    const variants=configuration.variants.flatMap(variant=>matrix.map(pipeline=>summarizeCloudCosts(rows.filter(row=>row.variant===variant&&row.pipelineId===pipeline.id),{pipeline,cloudId:pipeline.cloudId??'muse-spark',variant,pricing,seed:comparisonConfig.seed})));
    const weightedSources=values=>Object.fromEntries(['instructions','query','retrievedContext','localDraft','separators','guardWrapper','receiptMetadata','piiMap','total'].map(key=>[key,values.reduce((sum,row)=>sum+row.weight*row.value[key],0)]));
    const legacyReconciliation={...legacyCostBridge(previous.costPlan.find(plan=>plan.pipelineId==='llama8b+llamaguard+gemini')),sourceBreakdown:weightedSources(legacySources.handoff),sourceBreakdownCloudOnly:weightedSources(legacySources.baseline),sourceBreakdownScope:'Provider-selected Gemini local tokenizer content tokens per all-query core-weighted question, recounted from exact historical payload snapshots. Dollar bridge retains original historical assumptions.',localDraftSent:false,guardVerdictsSent:false,receiptsSent:false,piiMapsSent:false};
    const gemmaComparison=[];for(const cloudId of ['muse-spark','gemini'])for(const guard of comparisonConfig.guards)for(const variant of configuration.variants){const group=localModelId=>rows.filter(row=>row.localModelId===localModelId&&row.cloudId===cloudId&&row.variant===variant&&matrix.find(p=>p.id===row.pipelineId)?.guardModelId===guard.modelId);gemmaComparison.push({cloudId,guardModelId:guard.modelId,variant,...compareCostIdentity(group('gemma3:4b'),group('gemma3:12b'))});}
    const plans=variants.map(plan=>({...plan,sampleItems:plan.items,plannedHandoffs:plan.handedOffItems,estimatedInputTokens:rows.filter(row=>row.pipelineId===plan.pipelineId&&row.variant===plan.variant&&row.handedOff).reduce((sum,row)=>sum+row.inputTokens,0),estimatedOutputTokens:rows.filter(row=>row.pipelineId===plan.pipelineId&&row.variant===plan.variant&&row.handedOff).reduce((sum,row)=>sum+row.projectedOutputTokens,0),estimatedReasoningTokens:rows.filter(row=>row.pipelineId===plan.pipelineId&&row.variant===plan.variant&&row.handedOff).reduce((sum,row)=>sum+row.projectedReasoningTokens,0),expectedInputTokensPer1000:plan.cloudInputTokensPerQuery*1000,expectedAllCloudInputTokensPer1000:estimate(plan.allQueries.cloudOnlyInputTokensPerQuery)*1000,cloudOnlyReferenceCloudId:plan.cloudId,actualSpendUsd:0,localAllocationIncluded:plan.localAllocationPer1000Usd/1000}));
    const report={...previous,runId,timestamp:new Date().toISOString(),tier:0,status:'TIER0_COST_AUDIT_COMPLETE',cloudCalls:0,pricing,environment,costPlan:plans.filter(plan=>plan.variant===configuration.defaultVariant),costPlanVariants:plans,costAudit:{version:'payload-token-cost-v2',sourceRun,settings:configuration,costItems:costItems.length,sourceRoutingFrozen:true,headlineBasis:'all-query cloud fees only',tokenizers:counters.metadata,legacyReconciliation,gemmaComparison,gradingAudit,uniquePayloads:payloads.size,perItemTokenRecords:rows.length,privatePayloadManifest:'.logs/comparison-cost/<runId>/payloads/',remoteCountingCalls:0,cloudInferenceCalls:0,actualSpendUsd:0,caching:{mode:'implicit automatic stable prefix; shared Meta system-hash key',discountAssumed:0,cacheCreationCalls:0,observedCachedTokens:null,notes:'No cache hit or discount is claimed before actual provider usage. A short shared prefix may not meet caching thresholds.'},outputAssumptions:pricing.outputProjections,serverFraming:{measured:null,assumed:pricing.serverFramingTokensAssumed,sensitivityTokens:pricing.framingSensitivityTokensPerRequest},qualityPerDollar:null},provenance:{...previous.provenance,gitCommit:fingerprint.gitCommit,sourceHash:fingerprint.hash,inferenceSourceRun:sourceRun,auditManifestHash:sha256(auditManifest)},notes:[...previous.notes,'Corrected costs are cloud fees only, directly averaged over item-level routed payload token counts. Local hardware allowance is separate.','Gemini uses the offline tokenizer selected in Google’s SDK; Muse Spark uses a labelled Llama 3.1 proxy. Neither is a measured provider invoice, and hidden server framing remains unknown.','Output and reasoning lengths vary by category and are explicitly assumed.','The 200-item random local grading audit and the original 60-item slice are distinct; no routing thresholds were retuned.'],network:boundary.status()};
    addFramingSensitivity(plans,rows,pricing);
    report.sourceHash=fingerprint.hash;report.provenance.inferenceSourceHash=previous.sourceHash;report.costAudit.corpus=corpus;report.receipts=receiptReport;report.costAudit.receiptScope='Unique provider/payload counterfactuals; signed local evidence only, never proof of remote delivery';
    const endSource=await costStudyFingerprint();if(endSource.hash!==fingerprint.hash)throw new Error('Evaluation code/settings changed during the audit; refusing to publish a mixed run');
    await atomicJson(path.join(publicDir,'report.json'),report);await atomicJson(path.join(publicDir,'manifest.json'),{version:'payload-token-cost-v2',source:fingerprint,originalStudy:sourceRun,costItemIds:costItems.map(item=>item.id),gradingAuditManifest:auditManifest,tokenizerMetadataHash:sha256(counters.metadata),environmentHash:environment.sha256});
    const summary=renderCostAuditSummary(report);await (await import('node:fs/promises')).writeFile(path.join(publicDir,'summary.md'),summary);await atomicJson(path.join(root,'results/comparison-latest.json'),{schemaVersion:1,directory:runId,reportSha256:sha256(await readFile(path.join(publicDir,'report.json')))});await progress({phase:'complete',pipelinePlans:plans.length,payloads:payloads.size,localAuditItems:200,stopBeforeTier1:true});return report;
  }finally{boundary.restore();try{if(journal&&!receiptReport)await journal.close();}finally{await release();}}
}

export function renderCostAuditSummary(report){
  const audit=report.costAudit,table=['| Pipeline | Variant | Input tokens / all query | Input tokens / handoff | USD / 1,000 all queries | Matched all-cloud | Saving | USD / 1,000 handoffs | Matched cloud-only handoffs | Quality / $ |','|---|---|---:|---:|---:|---:|---:|---:|---:|---|',...report.costPlanVariants.map(row=>`| ${row.pipelineId} | ${row.variant} | ${fmt(row.cloudInputTokensPerQuery)} | ${fmt(row.cloudInputTokensPerHandoff)} | $${fmt(row.costPer1000AllQueriesUsd)} | $${fmt(row.cloudOnlyCostPer1000AllQueriesUsd)} | ${pct(row.savingRateAllQueries)} | ${row.costPer1000HandedOffQueriesUsd==null?'n/a':`$${fmt(row.costPer1000HandedOffQueriesUsd)}`} | ${row.cloudOnlyCostPer1000HandedOffQueriesUsd==null?'n/a':`$${fmt(row.cloudOnlyCostPer1000HandedOffQueriesUsd)}`} | pending Tier 1 |`)];
  const bridge=audit.legacyReconciliation,g=audit.gradingAudit;
  const grades=['| Cohort | Model | Original method (95% CI) | Independent method (95% CI) | Exact score agreement (95% CI) | Format disagreements |','|---|---|---:|---:|---:|---:|'];for(const [cohort,data]of[['Random 200',g.random200],['Original 60',g.originalReportedSlice]])for(const[model,row]of Object.entries(data.models))grades.push(`| ${cohort} | ${model} | ${interval(row.firstScore)} | ${interval(row.secondScore)} | ${interval(row.exactScoreAgreement)} | ${row.formatDisagreements} |`);
  const gaps=[['Random 200',g.random200],['Original 60',g.originalReportedSlice]].map(([name,data])=>`${name}: Gemma 12B minus Llama 8B gap, original grader ${interval(data.baselineGap)}, second grader ${interval(data.secondMethodGap)}.`).join('\n\n');
  const ablation=g.promptFormatAblation,ablationTable=ablation?['| Model | Original JSON prompt (95% CI) | Plain-answer prompt (95% CI) | Paired change (95% CI) |','|---|---:|---:|---:|',...Object.entries(ablation.models).map(([model,row])=>`| ${model} | ${interval(row.originalScore)} | ${interval(row.plainScore)} | ${interval(row.withinModelChange)} |`)].join('\n'):'pending';
  const ablationGaps=ablation?`Gemma 12B minus Llama 8B gap: JSON ${interval(ablation.originalPromptGap)}; plain ${interval(ablation.plainPromptGap)}; paired gap change ${interval(ablation.gapChange)}.`:'pending';
  return`# Corrected Tier 0 payload cost and grading audit\n\nRun ${report.runId}; cloud inference calls **0**, remote counting calls **0**, actual cloud spend **$0**. STOP before Tier 1.\n\n## Cloud fees over the complete query population\n\nThese are item-level projections from retained exact lean payloads, not routed-share multipliers. All 60 source items remain in every population; local/blocked/adversarial cloud fees are zero. Category/eligibility weights match the original 1,000-item core. The headline saving is the all-query cloud-fee comparison. Local hardware allocation is secondary and excluded from that headline.\n\n${table.join('\n')}\n\n## Why the earlier Gemini headline was higher\n\nThe old Finkd/Gemini figure $${fmt(bridge.historicalCombinedCostPer1000Usd)} included $${fmt(bridge.historicalLocalAllocationPer1000Usd)} local allocation. Its cloud fees were $${fmt(bridge.historicalCloudFeesPer1000Usd)}, below the $${fmt(bridge.historicalCloudOnlyPer1000Usd)} cloud-only reference by $${fmt(bridge.cloudFeeSavingPer1000Usd)}. Guard wrappers, receipts and local drafts contributed zero cloud tokens. The apparent $${fmt(bridge.combinedPremiumPer1000Usd)} premium was accounting scope, not metadata overhead.\n\nThe exact legacy-input source recount and its matched cloud-only breakdown are in report.json. Both draft variants keep all receipts, Guard verdicts, file paths and PII maps local. Context is relevance-trimmed, deduplicated, top-${audit.settings.topK}, within ${audit.settings.contextTokenBudget} tokens under the stricter of both local counters; optional redacted draft is capped at ${audit.settings.draftTokenBudget}.\n\n## Tokenizers and forecast assumptions\n\nGemini: Google SDK-selected local ${audit.tokenizers.gemini.repository}@${audit.tokenizers.gemini.revision}. Muse Spark: installed Llama 3.1 BPE **proxy**, not the unavailable Muse Spark tokenizer. Asset/model hashes and the pinned Google SDK mapping are recorded. Text counts are exact for these artifacts; hidden service framing and actual billed input remain **unknown**. Headline projections assume ${report.pricing.serverFramingTokensAssumed} additional framing tokens and zero cache discount; per-type answer/reasoning lengths are assumptions bounded by the shared output cap. No provider API or cache-creation call was made.\n\nGemma 4B and Gemma 12B are computed separately. Question-only figures can match because their frozen route masks and payload bytes match under the same Guard; a common cloud tokenizer and per-type output assumption then produce equal cloud fees. The with-draft variant includes each model’s actual redacted draft, so equality is checked per item rather than imposed. See gemmaComparison in report.json.\n\n## Blind second grading method\n\n${grades.join('\n')}\n\n${gaps}\n\n### Predeclared 50-item prompt-format control\n\n${ablationTable}\n\n${ablationGaps}\n\nAll point estimates, 95% paired/source-group bootstrap intervals, model-gap changes, per-category agreement and format-disagreement IDs are in report.json. The second grader is independently implemented and format-tolerant, not a human semantic gold standard. The random 200 held-out items and original reported 60 are separate cohorts. The predeclared 50-item plain-answer prompt ablation is reported separately; neither experiment retunes routing thresholds. Raw answers and GPQA question text stay in ignored local files.\n\nCloud quality per dollar is **pending Tier 1**.\n`;
}
