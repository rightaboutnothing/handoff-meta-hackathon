import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {wilsonInterval,percentile} from './metrics.mjs';
import {projectedCloudFee} from './cost-metrics.mjs';
import {isArithmeticQuestion} from './stage2-metrics.mjs';
import {assertLeanWire} from './handoff-payload.mjs';
import {isCloudEligible} from './policy.mjs';
import {sha256} from '../rag/receipts.mjs';

export const STAGE4_VERSION='stage4-frozen-slice-report-v1';
export const STAGE4_SOURCE_RUN='2026-10-28-stage3-dev-risk-calibration';
export const STAGE4_RUN='2026-10-28-stage4-slice-report';
const root=fileURLToPath(new URL('../../',import.meta.url));
const providers=['gemini','muse-spark'];
const populations=[{id:'frozen-saved60',label:'Frozen saved60 test',items:60,role:'primary frozen test replay'},{id:'frozen-plain50',label:'Frozen plain50 control',items:50,role:'separate frozen prompt control; overlapping IDs must not be pooled'},{id:'dev-audit',label:'Held-out dev AUDIT',items:83,role:'separate dev audit; never combined with test'}];
export const STAGE4_SLICES=Object.freeze([
  {id:'company',label:'Company data',parentId:null,overlay:false,definition:'All registered company-data tasks'},
  {id:'company-single',label:'Company · single document',parentId:'company',overlay:false,definition:'Registered company-data single-doc category'},
  {id:'company-multi',label:'Company · multiple documents',parentId:'company',overlay:false,definition:'Registered company-data multi-doc category'},
  {id:'company-arithmetic',label:'Company · arithmetic',parentId:'company',overlay:true,definition:'Frozen Stage 2 arithmetic eligibility; question-driven heuristic for dev AUDIT. Overlaps single/multi and must not be added to them.'},
  {id:'knowledge',label:'General knowledge · MMLU-Pro',parentId:'non-company',overlay:false,definition:'MMLU-Pro suite, including its knowledge and reasoning category tags'},
  {id:'gpqa',label:'Hard questions · GPQA',parentId:'non-company',overlay:false,definition:'GPQA suite only; a one-item frozen slice is exploratory'},
  {id:'other',label:'Other · instruction, privacy and safety',parentId:'non-company',overlay:false,definition:'Remaining noncompany items, including local-only adversarial items'},
  {id:'non-company',label:'All noncompany questions',parentId:null,overlay:false,definition:'Knowledge + GPQA + other; preserves complete workload denominator'},
  {id:'overall',label:'Observed blended workload',parentId:null,overlay:false,definition:'Every item in this population, once'},
]);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const ratio=(count,total)=>total?count/total:null;
const key=row=>JSON.stringify([row.population,row.modelId,row.id]);
const isCompany=row=>/^company-data(?:[ -]|$)/.test(String(row.category));
const isFull=row=>!row.error&&row.scoring?.labelAvailable!==false&&row.scoring?.score===1;
const modelDefinitions=[{id:'llama3.1:8b',label:'Llama 3.1 8B',parametersB:8},{id:'gemma3:4b',label:'Gemma 3 4B',parametersB:4},{id:'gemma3:12b',label:'Gemma 3 12B',parametersB:12}];

export function stage4SliceIds(row,metadata={}){
  if(isCompany(row)){
    const arithmetic=typeof row.arithmeticEligible==='boolean'?row.arithmeticEligible:isArithmeticQuestion(metadata.prompt??'');
    return['company',row.category.includes('multi-doc')?'company-multi':'company-single',...(arithmetic?['company-arithmetic']:[]),'overall'];
  }
  const suite=row.suite??metadata.suite;
  return[suite==='mmlu-pro'?'knowledge':suite==='gpqa'?'gpqa':'other','non-company','overall'];
}

function checkedDecisions(decisions,modelIds){
  const filtered=decisions.filter(row=>populations.some(pop=>pop.id===row.population)),seen=new Set();
  for(const row of filtered){
    if(typeof row.id!=='string'||!modelIds.includes(row.modelId)||typeof row.safe!=='boolean'||typeof row.accepted!=='boolean')throw new Error('Stage 4 needs explicit saved model/item acceptance records');
    if(seen.has(key(row)))throw new Error('Duplicate population/model/item record');seen.add(key(row));
    if(row.accepted&&(!row.safe||row.gate?.eligible!==true))throw new Error('Unsafe or failed-gate answer cannot be accepted');
    if(row.safe!==isCloudEligible(row))throw new Error('Saved safety flag conflicts with trusted manifest safety metadata');
    if(!row.safe&&row.decision?.route!=='local_only_safety')throw new Error('Adversarial item must remain local-only');
  }
  for(const population of populations)for(const modelId of modelIds){const rows=filtered.filter(row=>row.population===population.id&&row.modelId===modelId);if(rows.length!==population.items)throw new Error('Frozen population is incomplete');}
  return filtered;
}
function localLatency(row){
  if(row.error||!Array.isArray(row.stages)||!row.stages.length)return null;
  const stages=row.stages.filter(stage=>stage.stage!=='warm-up');
  return stages.length&&stages.every(stage=>finite(stage.latencyMs)&&stage.latencyMs>=0)?stages.reduce((sum,stage)=>sum+stage.latencyMs,0):null;
}
export function summarizeStage4Slice(rows){
  const safe=rows.filter(row=>row.safe),accepted=safe.filter(row=>row.accepted),correct=accepted.filter(isFull),escalations=safe.length-accepted.length;
  const latencies=rows.map(localLatency).filter(finite),acceptedLatencies=accepted.map(localLatency).filter(finite);
  return{items:rows.length,safeItems:safe.length,accepted:accepted.length,acceptedCorrect:correct.length,acceptedUnknown:accepted.filter(row=>row.error||row.scoring?.labelAvailable===false||!finite(row.scoring?.score)).length,
    acceptanceRate:ratio(accepted.length,rows.length),acceptanceRateSafe:ratio(accepted.length,safe.length),acceptedAccuracy:ratio(correct.length,accepted.length),acceptedAccuracyWilson95:wilsonInterval(correct.length,accepted.length),
    escalations,escalationRate:ratio(escalations,rows.length),escalationRateSafe:ratio(escalations,safe.length),localOnly:rows.length-safe.length,localOnlyRate:ratio(rows.length-safe.length,rows.length),
    medianLatencyMs:percentile(latencies,.5),p95LatencyMs:percentile(latencies,.95),latencyMeasured:latencies.length,medianAcceptedLatencyMs:percentile(acceptedLatencies,.5),errors:rows.filter(row=>row.error).length,
    acceptedSourceGroups:new Set(accepted.map(row=>row.groupId??row.id)).size,exploratorySmallSlice:rows.length>0&&rows.length<10,
    intervalMeaning:'Wilson 95% IID sensitivity interval for conservative automated full-credit labels; correlated templates limit generalization. No accepted answers means undefined accuracy.',
    latencyMeaning:'Saved local stages, including reconstructed shared retrieval and answer/self-check; excludes warm-up and unavailable Guard/cloud completion. Not live cloud end-to-end latency.'};
}
export function summarizeStage4Cost(rows,cloudId,pricing){
  const price=row=>projectedCloudFee(cloudId,{inputTokens:row.inputTokens,outputTokens:row.projectedOutputTokens,reasoningTokens:row.projectedReasoningTokens},pricing);
  for(const row of rows){
    if(row.cloudId!==cloudId||!Number.isInteger(row.inputTokens)||row.inputTokens<0||typeof row.eligible!=='boolean'||typeof row.handedOff!=='boolean')throw new Error('Provider-specific saved token counts are required');
    if(row.eligible&&row.baselineInputTokens!==row.inputTokens)throw new Error('Matched all-cloud and handoff inputs must use identical counted payloads');
    if(row.handedOff&&!row.eligible)throw new Error('Adversarial handoff is forbidden');
    if(['guardWrapper','receiptMetadata','piiMap','localDraft'].some(field=>(row.inputComponents?.[field]??0)!==0))throw new Error('Local metadata or draft cannot appear in a cloud payload');
    if(!row.eligible&&(row.inputTokens!==0||row.payloadHash!==null||row.handedOff))throw new Error('Local-only items must have zero hypothetical cloud payload');
    if(row.eligible&&!finite(price(row)))throw new Error('Missing output projection or price assumptions');
  }
  const total=rows.length,handed=rows.filter(row=>row.handedOff),cost=handed.reduce((sum,row)=>sum+price(row),0),baseline=rows.filter(row=>row.eligible).reduce((sum,row)=>sum+price(row),0),per1000=ratio(cost,total),basePer1000=ratio(baseline,total);
  return{items:total,safeItems:rows.filter(row=>row.eligible).length,handedOffQueries:handed.length,cloudCallsSkipped:rows.filter(row=>row.eligible&&!row.handedOff).length,
    costPer1000:per1000==null?null:per1000*1000,cloudOnlyPer1000:basePer1000==null?null:basePer1000*1000,savingPer1000:per1000==null?null:(basePer1000-per1000)*1000,savingRate:baseline?1-cost/baseline:null,
    inputTokensPerQuery:ratio(handed.reduce((sum,row)=>sum+row.inputTokens,0),total),projectedTokensPerQuery:ratio(handed.reduce((sum,row)=>sum+row.inputTokens+row.projectedOutputTokens+row.projectedReasoningTokens,0),total),
    cloudOnlyInputTokensPerQuery:ratio(rows.reduce((sum,row)=>sum+(row.eligible?row.inputTokens:0),0),total),inputTokensTotal:handed.reduce((sum,row)=>sum+row.inputTokens,0),projectedAnswerTokensTotal:handed.reduce((sum,row)=>sum+row.projectedOutputTokens,0),projectedReasoningTokensTotal:handed.reduce((sum,row)=>sum+row.projectedReasoningTokens,0),
    actualCloudCalls:0,actualSpendUsd:0,qualityPerDollar:null,conditionalPreGuard:true,assumptions:true};
}
export function blendStage4Costs(company,rest,companyShare){
  if(!(companyShare>=0&&companyShare<=1))throw new Error('Company share must be a fraction');
  const weighted=field=>finite(company[field])&&finite(rest[field])?companyShare*company[field]+(1-companyShare)*rest[field]:null;
  const costPer1000=weighted('costPer1000'),cloudOnlyPer1000=weighted('cloudOnlyPer1000'),savingPer1000=costPer1000==null||cloudOnlyPer1000==null?null:cloudOnlyPer1000-costPer1000;
  return{companyShare,costPer1000,cloudOnlyPer1000,savingPer1000,savingRate:cloudOnlyPer1000?savingPer1000/cloudOnlyPer1000:null,inputTokensPerQuery:weighted('inputTokensPerQuery'),projectedTokensPerQuery:weighted('projectedTokensPerQuery'),assumptions:true,actualCloudCalls:0,actualSpendUsd:0};
}

function inspectPayloads(payloads){
  const map=new Map();for(const saved of payloads){
    const wire=assertLeanWire(saved.payload?.wire);if(wire.draft!==null||saved.payload.variant!=='question-only')throw new Error('Stage 4 requires no-draft potential payloads');
    if(saved.payloadHash!==sha256(wire)||saved.payloadHash!==saved.payload.payloadHash)throw new Error('Saved payload hash mismatch');
    map.set(saved.payloadHash,{chunks:wire.context.length,redactedPlaceholderOccurrences:([wire.query,...wire.context.map(chunk=>chunk.text)].join('\n').match(/\[\[PII_[^\]]+\]\]/g)??[]).length});
  }return map;
}

export function buildStage4Report({sourceReport,decisions,tokenRows,payloads,metadata=[],pricing,sourceHashes={},runId=STAGE4_RUN}={}){
  if(sourceReport?.cloudCalls!==0||sourceReport.spendUsd!==0||sourceReport.network?.externalRequests!==0||sourceReport.testReplayLocked!==true||sourceReport.policyHash!==sha256(sourceReport.calibration))throw new Error('Stage 4 requires a locked zero-cloud Stage 3 source');
  const modelIds=sourceReport.settings.models,selected=checkedDecisions(decisions,modelIds),meta=new Map(metadata.map(item=>[item.id,item])),wires=inspectPayloads(payloads),tokenMap=new Map();
  for(const row of tokenRows){const k=key(row)+'|'+row.cloudId;if(tokenMap.has(k))throw new Error('Duplicate saved provider token row');tokenMap.set(k,row);}
  const memberships=new Map(selected.map(row=>[key(row),stage4SliceIds(row,meta.get(row.id))]));
  const rows=[],costs=[],privacy=[];
  for(const population of populations)for(const modelId of modelIds){
    const modelRows=selected.filter(row=>row.population===population.id&&row.modelId===modelId);
    for(const slice of STAGE4_SLICES){
      const selectedRows=modelRows.filter(row=>memberships.get(key(row)).includes(slice.id));
      rows.push({population:population.id,modelId,sliceId:slice.id,...summarizeStage4Slice(selectedRows)});
      for(const cloudId of providers){const countRows=selectedRows.map(row=>{const count=tokenMap.get(key(row)+'|'+cloudId);if(!count||count.eligible!==row.safe||count.accepted!==(row.safe&&row.accepted)||count.handedOff!==(row.safe&&!row.accepted))throw new Error('Saved provider counts disagree with locked acceptance');return count;});costs.push({population:population.id,modelId,sliceId:slice.id,cloudId,...summarizeStage4Cost(countRows,cloudId,pricing)});}
    }
    const company=modelRows.filter(isCompany),proposed=company.filter(row=>row.safe&&!row.accepted),counts=proposed.map(row=>tokenMap.get(key(row)+'|gemini'));
    for(const count of counts)if(!wires.has(count.payloadHash))throw new Error('Proposed company payload snapshot is missing');
    const adRows=modelRows.filter(row=>row.suite==='ad-privacy'),businessRows=[...company,...adRows],businessProposed=businessRows.filter(row=>row.safe&&!row.accepted),businessCounts=businessProposed.map(row=>tokenMap.get(key(row)+'|gemini'));
    for(const count of businessCounts)if(!wires.has(count.payloadHash))throw new Error('Proposed business payload snapshot is missing');
    privacy.push({population:population.id,modelId,queries:modelRows.length,companyQueries:company.length,documentCompanyQueries:company.length,companyDefinition:'Registered company-data RAG questions; synthetic ad-account exports are counted separately, within the Other reporting slice.',adPrivacyQueries:adRows.length,businessDataQueries:businessRows.length,businessDataKeptOnMachine:businessRows.length,businessDataDefinition:'Company-document RAG questions plus synthetic ad-account exports. This broader privacy count does not reclassify cost/routing workload slices.',fullyLocalBusinessDataQueries:businessRows.filter(row=>row.accepted&&row.safe).length,proposedBusinessHandoffs:businessProposed.length,actualBusinessCloudCalls:0,proposedBusinessPayloadsWithContext:businessCounts.filter(count=>wires.get(count.payloadHash).chunks>0).length,proposedBusinessPayloadsWithoutContext:businessCounts.filter(count=>wires.get(count.payloadHash).chunks===0).length,proposedBusinessChunks:businessCounts.reduce((sum,count)=>sum+wires.get(count.payloadHash).chunks,0),fullyLocalCompanyQueries:company.filter(row=>row.accepted&&row.safe).length,companyDataKeptOnMachine:company.length,proposedCompanyHandoffs:proposed.length,deferredCompanyQueries:proposed.length,
      actualCloudCalls:0,actualCompanyCloudCalls:0,postGuardCompanyCloudCalls:0,guardScreenedHandoffs:null,guardPassedCompanyHandoffs:null,outboundGuardCalls:null,inboundGuardCalls:null,
      proposedPayloadsWithContext:counts.filter(count=>wires.get(count.payloadHash).chunks>0).length,proposedPayloadsWithoutContext:counts.filter(count=>wires.get(count.payloadHash).chunks===0).length,proposedCompanyChunks:counts.reduce((sum,count)=>sum+wires.get(count.payloadHash).chunks,0),draftPayloads:0,
      proposedCompanyPayloadsChecked:counts.length,redactedPlaceholderOccurrences:counts.reduce((sum,count)=>sum+wires.get(count.payloadHash).redactedPlaceholderOccurrences,0),
      questionOnlyMeaning:'Redacted question plus bounded minimum redacted source spans when needed; no local draft, Guard verdict, receipt or PII map. Question-only does not mean context-free.',
      guardStatus:'Pending: Stage 3 replay made no outbound/inbound Guard calls and delivered no cloud payload. Proposed handoffs are pre-Guard deferred candidates.',
      privacyCheckScope:'Saved wire allowlist, hashes, no draft and recognized raw-private-pattern checks pass. This is local potential-payload inspection, not a universal PII guarantee or remote-delivery attestation.'});
  }
  const workloadMix=[];
  for(const modelId of modelIds)for(const cloudId of providers){const find=sliceId=>costs.find(row=>row.population==='frozen-saved60'&&row.modelId===modelId&&row.cloudId===cloudId&&row.sliceId===sliceId);for(const companyShare of [.25,.5,.75])workloadMix.push({population:'frozen-saved60',modelId,cloudId,...blendStage4Costs(find('company'),find('non-company'),companyShare)});}
  const policy=sourceReport.calibration.models['gemma3:12b'].slices.company,certification={modelId:'gemma3:12b',sliceId:'company',finiteDevUpperRisk:policy.certificate.upperRisk,auditOnlyUpperRisk:policy.certificate.unsampled.upperRisk,acceptedCalib:policy.certificate.sampled,finiteFrame:policy.certificate.population,upperWrong:policy.certificate.upperWrong,errorBudget:policy.errorBudget,familywiseConfidence:1-sourceReport.calibration.alpha,operationalThreshold:policy.threshold,policyHash:sourceReport.policyHash,futureCertified:false,
    certifiedScope:policy.certificate.scope,notCertified:['Future company traffic','Unseen source families','Test population risk','GPQA or general knowledge','Cloud answer quality','Universal PII removal or post-Guard remote delivery'],intervalLabel:'Wilson 95% IID sensitivity; accepted answers share source/template families.',allPolicies:modelIds.flatMap(modelId=>Object.entries(sourceReport.calibration.models[modelId].slices).map(([sliceId,p])=>({modelId,sliceId,status:p.status,threshold:p.threshold,finiteDevUpperRisk:p.certificate.upperRisk,certifiedFiniteFrame:p.certifiedFiniteFrame,futureCertified:false})))};
  const headline=rows.find(row=>row.population==='frozen-saved60'&&row.modelId==='gemma3:12b'&&row.sliceId==='company'),recommendation={modelId:'gemma3:12b',label:'Gemma 3 12B for company data',scope:'Demo deployment candidate; use the locked company policy and all citation/completeness/truncation gates. Escalate other safe tasks through Guard and redaction; keep adversarial items local.',routeOtherSafe:'escalate_after_guard_and_redaction',adversarialRoute:'local_only_safety',automaticProductionActivation:false,reason:`The frozen company slice accepts ${headline.accepted}/${headline.items} locally with ${headline.acceptedCorrect}/${headline.accepted} full-credit answers. Other model/slice policies remain abstentions.`,cloudLabel:'Muse Spark'};
  const summaryParagraph=`On the frozen ${populations[0].items}-question comparison, Gemma 12B answered ${headline.accepted} of ${headline.items} company-data questions locally; all ${headline.acceptedCorrect} accepted answers received full rubric credit. Its Wilson IID sensitivity interval is ${(headline.acceptedAccuracyWilson95[0]*100).toFixed(1)}–${(headline.acceptedAccuracyWilson95[1]*100).toFixed(1)}%. Llama 8B and Gemma 4B continue to abstain. The ${ (certification.finiteDevUpperRisk*100).toFixed(2)}% upper error bound applies only to the fixed accepted dev frame; future traffic remains uncertified. Every cloud answer and all spending remain deferred: this report made zero cloud calls and spent $0.`;
  const primaryComposition=STAGE4_SLICES.filter(slice=>['company-single','company-multi','knowledge','gpqa','other'].includes(slice.id)).map(slice=>({sliceId:slice.id,items:rows.find(row=>row.population==='frozen-saved60'&&row.modelId===modelIds[0]&&row.sliceId===slice.id).items}));
  const report={schemaVersion:1,kind:'stage4-slice-report',version:STAGE4_VERSION,runId,tier:0,status:'STAGE4_SAVED_DATA_COMPLETE',timestamp:sourceReport.timestamp,timestampMeaning:'Frozen Stage 3 measurements finished at this time; Stage 4 performs saved-data analysis only.',reportBuiltFromFrozenAt:sourceReport.timestamp,sourceRun:sourceReport.runId,sourcePolicyHash:sourceReport.policyHash,sourceHashes,primaryPopulation:'frozen-saved60',populations,models:modelDefinitions.filter(model=>modelIds.includes(model.id)),modelIds,slices:STAGE4_SLICES,rows,costs,workloadMix,privacy,recommendation,certification,summaryParagraph,primaryComposition,
    pricing:{currency:pricing.currency,assumptions:true,label:pricing.label,clouds:Object.fromEntries(providers.map(id=>[id,{modelId:pricing.clouds[id].modelId,inputUsdPerMillion:pricing.clouds[id].inputUsdPerMillion,outputUsdPerMillion:pricing.clouds[id].outputUsdPerMillion}])),outputProjections:pricing.outputProjections,outputProjectionLabel:pricing.outputProjectionLabel,localHardwareAllocationIncluded:false,cacheDiscountAssumed:0,serverFramingTokensAssumed:0,providerBillingKnown:false},
    tokenCounting:{...sourceReport.costs.tokenizerMetadata,scope:'Saved provider-specific offline input content counts. Gemini uses its pinned SDK-selected tokenizer; Muse Spark uses the documented Llama BPE proxy. Actual provider billing/framing are unknown.'},
    workloadAssumptions:'Company share varies; the observed saved60 composition within company and within noncompany stays fixed. The noncompany remainder includes MMLU-Pro, one GPQA item, instructions, privacy and safety; unsafe items have zero cloud fees in both plans. Models and populations are never pooled.',
    cloudCalls:0,modelCalls:0,remoteCountingCalls:0,spendUsd:0,externalRequests:0,readOnlyAnalysis:true,qualityPerDollar:null,
    notes:['No new inference, retrieval, grading, calibration, Guard screening, provider token endpoint or cloud request was performed.','Primary saved60, plain50 control and dev AUDIT are separate; repeated IDs are never pooled.','Company arithmetic is an overlay across single/multi-document tasks and is not an additive partition.','The primary and control GPQA slices each contain only one question; no broad hard-reasoning accuracy claim is supported.','Unknown accepted labels count conservatively as wrong. Zero accepted answers have undefined accuracy and Wilson intervals.','Median latency sums the saved local stages and reconstructed retrieval, excludes warm-up, and omits unavailable Guard/cloud completion.','All cloud fees are conditional pre-Guard projections. Real offline input counts are combined with assumed visible output/reasoning lengths and unit prices; no actual invoices or cloud accuracy exist.','The recommendation is advisory; this report does not switch the production gateway model or certify future traffic.','All-company-data queries remained on the machine physically; fully local answers count only accepted answers, while proposed handoffs remain deferred.']};
  return report;
}

const pct=value=>finite(value)?`${(value*100).toFixed(1)}%`:'undefined';
const money=value=>finite(value)?`$${value.toFixed(4)}`:'pending';
const ci=value=>value?`[${value.map(pct).join(', ')}]`:'undefined';
export function renderStage4Summary(report){
  if(report.cloudCalls!==0||report.modelCalls!==0||report.spendUsd!==0)throw new Error('Stage 4 must remain a zero-call saved-data report');
  const primary=report.rows.filter(row=>row.population===report.primaryPopulation),labels=new Map(report.slices.map(slice=>[slice.id,slice.label])),rows=primary.filter(row=>['company','company-single','company-multi','company-arithmetic','knowledge','gpqa','other','overall'].includes(row.sliceId));
  const metrics=['| Model | Slice | Accepted / all | Acceptance | Accepted full credit / accepted | Wilson 95% IID sensitivity | Escalation | Local-only | Median local ms |','|---|---|---:|---:|---:|---|---:|---:|---:|',...rows.map(row=>`| ${row.modelId} | ${labels.get(row.sliceId)}${row.sliceId==='company-arithmetic'?' (overlay)':''} | ${row.accepted}/${row.items} | ${pct(row.acceptanceRate)} | ${row.acceptedCorrect}/${row.accepted} | ${ci(row.acceptedAccuracyWilson95)} | ${pct(row.escalationRate)} | ${row.localOnly} | ${row.medianLatencyMs==null?'pending':row.medianLatencyMs.toFixed(1)} |`)];
  const plans=report.costs.filter(row=>row.population===report.primaryPopulation&&['company','company-single','company-multi','company-arithmetic','knowledge','gpqa','other','overall'].includes(row.sliceId));
  const cost=['| Model | Slice | Cloud | Fees / 1,000 | Safe all-cloud / 1,000 | Saving $ / 1,000 | Saving % | Counted input / all query |','|---|---|---|---:|---:|---:|---:|---:|',...plans.map(row=>`| ${row.modelId} | ${labels.get(row.sliceId)} | ${row.cloudId==='muse-spark'?'Muse Spark':'Gemini'} | ${money(row.costPer1000)} | ${money(row.cloudOnlyPer1000)} | ${money(row.savingPer1000)} | ${pct(row.savingRate)} | ${row.inputTokensPerQuery?.toFixed(2)??'pending'} |`)];
  const mix=['| Local model | Company share | Cloud | Fees / 1,000 | Safe all-cloud / 1,000 | Saving $ | Saving % |','|---|---:|---|---:|---:|---:|---:|',...report.workloadMix.map(row=>`| ${row.modelId} | ${pct(row.companyShare)} | ${row.cloudId==='muse-spark'?'Muse Spark':'Gemini'} | ${money(row.costPer1000)} | ${money(row.cloudOnlyPer1000)} | ${money(row.savingPer1000)} | ${pct(row.savingRate)} |`)];
  const privacy=['| Local model | Business-data queries | Company documents / ad exports | Accepted fully local business answers | Proposed pre-Guard business handoffs | Actual business cloud calls | Proposed payloads with minimum context | Draft payloads |','|---|---:|---:|---:|---:|---:|---:|---:|',...report.privacy.filter(row=>row.population===report.primaryPopulation).map(row=>`| ${row.modelId} | ${row.businessDataQueries} | ${row.documentCompanyQueries} / ${row.adPrivacyQueries} | ${row.fullyLocalBusinessDataQueries} | ${row.proposedBusinessHandoffs} | ${row.actualBusinessCloudCalls} | ${row.proposedBusinessPayloadsWithContext} | ${row.draftPayloads} |`)];
  const controls=report.rows.filter(row=>row.population!=='frozen-saved60'&&['company','knowledge','gpqa','other','overall'].includes(row.sliceId));
  const separate=['| Population | Model | Slice | Accepted / all | Full credit / accepted | Wilson 95% IID sensitivity | Median local ms |','|---|---|---|---:|---:|---|---:|',...controls.map(row=>`| ${row.population} | ${row.modelId} | ${labels.get(row.sliceId)} | ${row.accepted}/${row.items} | ${row.acceptedCorrect}/${row.accepted} | ${ci(row.acceptedAccuracyWilson95)} | ${row.medianLatencyMs?.toFixed(1)??'pending'} |`)];
  return`# Handoff Stage 4: slice results and private-gateway demo\n\n${report.summaryParagraph}\n\n**Read-only Tier 0 analysis: zero new model/cloud/token-endpoint calls; $0 spend.** Source: ${report.sourceRun}, policy ${report.sourcePolicyHash}. Primary population is the frozen saved60 test; controls and dev AUDIT remain separate.\n\n## Headline metrics by slice\n\n${metrics.join('\n')}\n\nArithmetic is a nonadditive overlay over company single/multi-document items. MMLU-Pro includes its reasoning-tagged questions; GPQA is its exact suite, with only one primary item. General knowledge and GPQA accepted accuracy are undefined because every policy abstains. Two adversarial primary items stay local-only, so escalation plus acceptance does not equal 100% for every slice. Wilson intervals are IID sensitivity, not family-independent guarantees. Latency is the saved local pipeline including reconstructed shared retrieval and excluding unavailable Guard/cloud completion; this report performs no live timing.\n\n## Cloud fee projections by slice and observed blend\n\n${cost.join('\n')}\n\nCosts include all queries in each slice, charging accepted and unsafe items zero cloud fees. The safe all-cloud comparator uses identical question/minimum-context payloads. Gemini input counts use the pinned provider-selected offline tokenizer; Muse Spark input counts use a documented Llama BPE proxy. Output lengths, reasoning lengths and prices remain assumptions, server billing/framing are unknown, and local hardware allocation is excluded. These are pre-Guard projections; cloud quality and quality per dollar are pending. Equal costs for Llama/Gemma 4B reflect identical no-draft potential payloads and zero accepted safe items, not pooled model answers.\n\n## What if company data is 25%, 50% or 75%?\n\n${mix.join('\n')}\n\n${report.workloadAssumptions}\n\n## Deployment recommendation and certification\n\nRecommend **${report.recommendation.label}** as the company-data demo candidate, applying the locked ${report.certification.operationalThreshold.toFixed(8)} threshold and all existing gates; escalate other safe questions after Guard and redaction. Harmful, red-team and poisoning items remain local-only. This recommendation does not activate a production model or retune thresholds from test results.\n\nThe simultaneous fixed-dev-frame upper error bound is **${pct(report.certification.finiteDevUpperRisk)}** (${report.certification.upperWrong}/${report.certification.finiteFrame}), with ${report.certification.acceptedCalib} accepted CALIB answers sampled from that frame. The separate AUDIT-only bound is **${pct(report.certification.auditOnlyUpperRisk)}**. This certificate covers accepted CALIB+AUDIT dev items only, not future traffic, unseen source families, test population risk, cloud quality or universal PII removal.\n\n## Privacy: proposed boundary traffic versus actual delivery\n\n${privacy.join('\n')}\n\nAll company queries physically remained local because the source run was offline. Accepted fully local answers and deferred handoff candidates are distinguished above. Actual company queries reaching a cloud after Guard/redaction: **0**. New outbound/inbound Guard screens and post-Guard eligibility are **pending**, because no Guard calls were performed by the source replay. Proposed snapshots pass saved-wire hashes, strict wire allowlists, no-draft and recognized-private-pattern checks. “Question-only” means the redacted question plus minimum redacted evidence when needed, never a local draft or local control/proof/PII-map metadata. It does not mean that every potential payload is context-free. No post-Guard delivery or universal redaction guarantee is claimed.\n\n## Separate controls and held-out dev audit\n\n${separate.join('\n')}\n\nNo rows are pooled across these populations. Their per-slice costs and privacy counts remain in report.json.\n\n**STOP: no new benchmark or paid tier was started.**\n`;
}

export async function writeStage4Report({runId=STAGE4_RUN}={}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(runId))throw new Error('Invalid Stage 4 run ID');
  const privateDir=path.join(root,'.logs/stage3',STAGE4_SOURCE_RUN),sourceFile=path.join(root,'results',STAGE4_SOURCE_RUN,'report.json'),names={sourceReport:sourceFile,sourcePolicy:path.join(root,'results',STAGE4_SOURCE_RUN,'policy.json'),policyLock:path.join(privateDir,'policy-lock.json'),decisions:path.join(privateDir,'decisions.json'),tokenRows:path.join(privateDir,'token-counts.json'),payloads:path.join(privateDir,'potential-cloud-payloads.json'),pricing:path.join(root,'config/pricing.yaml'),dataset:path.join(root,'tasks/comparison/items.jsonl'),datasetManifest:path.join(root,'tasks/comparison/manifest.json')};
  const text=Object.fromEntries(await Promise.all(Object.entries(names).map(async([name,file])=>[name,await readFile(file,'utf8')]))),sourceHashes=Object.fromEntries(Object.entries(text).map(([name,body])=>[name,sha256(body)]));
  const sourceReport=JSON.parse(text.sourceReport),policyFile=JSON.parse(text.sourcePolicy),lock=JSON.parse(text.policyLock),datasetManifest=JSON.parse(text.datasetManifest);
  if(sourceReport.source.files['config/pricing.yaml']!==sha256(text.pricing.replace(/\r\n/g,'\n')))throw new Error('Pricing assumptions changed since the frozen Stage 3 measurement');
  if(sourceReport.source.files['tasks/comparison/manifest.json']!==sha256(text.datasetManifest.replace(/\r\n/g,'\n'))||datasetManifest.itemsSha256!==sha256(text.dataset))throw new Error('Public task metadata changed since the frozen Stage 3 measurement');
  if(policyFile.policyHash!==sourceReport.policyHash||sha256(policyFile.calibration)!==sourceReport.policyHash||lock.policyHash!==sourceReport.policyHash||lock.sourceHash!==sourceReport.source.hash||sha256(sourceReport.source.files)!==sourceReport.source.hash)throw new Error('Frozen source policy or lock proof does not match');
  const metadata=text.dataset.trim().split(/\r?\n/).map(line=>JSON.parse(line));
  const report=buildStage4Report({sourceReport,decisions:JSON.parse(text.decisions),tokenRows:JSON.parse(text.tokenRows),payloads:JSON.parse(text.payloads),metadata,pricing:JSON.parse(text.pricing),sourceHashes,runId});
  const directory=path.join(root,'results',runId),body=JSON.stringify(report,null,2)+'\n';await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'report.json'),body);await writeFile(path.join(directory,'summary.md'),renderStage4Summary(report));
  await writeFile(path.join(directory,'summary.txt'),report.summaryParagraph+'\n');
  await writeFile(path.join(root,'results/stage4-latest.json'),JSON.stringify({schemaVersion:1,directory:runId,reportSha256:sha256(body)},null,2)+'\n');return report;
}
