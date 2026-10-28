import { bootstrapEstimate } from './metrics.mjs';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const validTokens=value=>finite(value)&&value>=0;
const mean=values=>values.length?values.reduce((sum,value)=>sum+value,0)/values.length:null;
const defaultSources=['instructions','query','retrievedChunks','localDraft','serializationLabelsAndSeparators','guardWrapper','receiptMetadata','piiMap'];
const weight=row=>finite(row.weight)&&row.weight>=0?row.weight:1;
function weightedMean(rows,getter){
  if(!rows.length)return null;
  let total=0,denominator=0;
  for(const row of rows){const value=getter(row);if(!finite(value))return null;const scale=weight(row);total+=value*scale;denominator+=scale;}
  return denominator?total/denominator:null;
}
/** Visible-answer and reasoning lengths are projections supplied per item type,
 * never actual output counts or a routed-share multiplier. */
export function projectedCloudFee(cloudId,{inputTokens,outputTokens,reasoningTokens=0},pricing){
  const rate=pricing?.clouds?.[cloudId];
  if(!rate)throw new Error('Explicit cloud pricing assumptions are required');
  if(![inputTokens,outputTokens,reasoningTokens].every(validTokens))return null;
  return(inputTokens*rate.inputUsdPerMillion+(outputTokens+reasoningTokens)*rate.outputUsdPerMillion)/1e6;
}
function checkedRows(rows,{pipeline,variant}){
  const ids=new Set(),pipelines=new Set(),models=new Set(),variants=new Set();
  for(const row of rows){
    if(!row.id||ids.has(row.id))throw new Error('Cost summaries require one effective outcome per pipeline/item/variant');ids.add(row.id);
    if(row.pipelineId)pipelines.add(row.pipelineId);if(row.localModelId)models.add(row.localModelId);if(row.variant)variants.add(row.variant);
    if(typeof row.eligible!=='boolean'||typeof row.handedOff!=='boolean')throw new Error('Cost rows require explicit eligibility and actual planned handoff decisions');
    if(row.handedOff&&!row.eligible)throw new Error('An adversarial or otherwise local-only item cannot have a cloud handoff cost');
    if(row.weight!=null&&(!finite(row.weight)||row.weight<0))throw new Error('Cost weights must be finite and nonnegative');
    for(const source of ['guardWrapper','receiptMetadata','piiMap'])if((row.inputComponents?.[source]??0)!==0||(row.baselineInputComponents?.[source]??0)!==0)throw new Error('Local-only metadata cannot contribute cloud input tokens');
  }
  if(pipelines.size>1||models.size>1||variants.size>1)throw new Error('Never average pipelines, model sizes or draft variants together');
  if(pipeline?.id&&pipelines.size&&![...pipelines].every(id=>id===pipeline.id))throw new Error('Pipeline cost identity mismatch');
  if(variant&&variants.size&&![...variants].every(value=>value===variant))throw new Error('Draft variant cost identity mismatch');
  return rows.map(row=>({...row,groupId:row.groupId??row.id}));
}

/** Direct per-item accounting. Local answers and blocked items have zero cloud
 * fee even if their potential handoff payload was counted for inspection. */
export function summarizeCloudCosts(inputRows,{pipeline,cloudId=pipeline?.cloudId,variant,pricing,seed=20261027,replicates=400}={}){
  const rows=checkedRows(inputRows,{pipeline,variant});
  const actualCloudId=cloudId??rows[0]?.cloudId??'muse-spark';
  const cost=row=>!row.handedOff?0:projectedCloudFee(actualCloudId,{inputTokens:row.inputTokens,outputTokens:row.projectedOutputTokens,reasoningTokens:row.projectedReasoningTokens??0},pricing);
  const baseline=row=>!row.eligible?0:projectedCloudFee(actualCloudId,{inputTokens:row.baselineInputTokens,outputTokens:row.baselineOutputTokens??row.projectedOutputTokens,reasoningTokens:row.baselineReasoningTokens??row.projectedReasoningTokens??0},pricing);
  const handed=rows.filter(row=>row.handedOff);
  const measurement=(selected,getter,multiplier=1)=>{
    const estimate=bootstrapEstimate(selected,sample=>{const value=weightedMean(sample,getter);return value==null?null:value*multiplier;},{seed,replicates});
    const known=selected.filter(row=>finite(getter(row))).length;
    return{...estimate,total:selected.length,coverage:selected.length?known/selected.length:null};
  };
  const ratio=(selected,numerator,denominator)=>bootstrapEstimate(selected,sample=>{const n=weightedMean(sample,numerator),d=weightedMean(sample,denominator);return n==null||d==null||d===0?null:n/d;},{seed,replicates});
  const summarize=selected=>{
    const cloudInput=row=>row.handedOff?validTokens(row.inputTokens)?row.inputTokens:null:0;
    const output=row=>row.handedOff?validTokens(row.projectedOutputTokens)?row.projectedOutputTokens:null:0;
    const reasoning=row=>row.handedOff?validTokens(row.projectedReasoningTokens??0)?row.projectedReasoningTokens??0:null:0;
    const baseInput=row=>row.eligible?validTokens(row.baselineInputTokens)?row.baselineInputTokens:null:0;
    const delta=row=>{const h=cost(row),b=baseline(row);return h==null||b==null?null:b-h;};
    const sources=[...new Set([...defaultSources,...selected.flatMap(row=>Object.keys(row.inputComponents??{})),...selected.flatMap(row=>Object.keys(row.baselineInputComponents??{}))])];
    const perSource=Object.fromEntries(sources.map(source=>[source,{handoff:measurement(selected,row=>!row.handedOff?0:finite(row.inputComponents?.[source])?row.inputComponents[source]:['guardWrapper','receiptMetadata','piiMap'].includes(source)?0:null),cloudOnly:measurement(selected,row=>!row.eligible?0:finite(row.baselineInputComponents?.[source])?row.baselineInputComponents[source]:['guardWrapper','receiptMetadata','piiMap'].includes(source)?0:null)}]));
    return{items:selected.length,cloudInputTokensPerQuery:measurement(selected,cloudInput),projectedAnswerTokensPerQuery:measurement(selected,output),projectedReasoningTokensPerQuery:measurement(selected,reasoning),cloudTotalTokensPerQuery:measurement(selected,row=>{const values=[cloudInput(row),output(row),reasoning(row)];return values.every(finite)?values.reduce((a,b)=>a+b,0):null;}),cloudOnlyInputTokensPerQuery:measurement(selected,baseInput),costPer1000Usd:measurement(selected,cost,1000),cloudOnlyCostPer1000Usd:measurement(selected,baseline,1000),savingPer1000Usd:measurement(selected,delta,1000),savingRate:ratio(selected,delta,baseline),inputTokensBySource:perSource};
  };
  const allQueries=summarize(rows),handedOffQueries=summarize(handed);
  const localAllocationPerQuery=pipeline?.localModelId?pricing?.localAllocationUsdPerQuery??0:0;
  return{pipelineId:pipeline?.id??rows[0]?.pipelineId??null,name:pipeline?.name??null,localModelId:pipeline?.localModelId??rows[0]?.localModelId??null,cloudId:actualCloudId,variant:variant??rows[0]?.variant??'question-only',items:rows.length,eligibleItems:rows.filter(row=>row.eligible).length,handedOffItems:handed.length,localOrBlockedItems:rows.length-handed.length,allQueries,handedOffQueries,
    cloudTokensPerQuery:allQueries.cloudInputTokensPerQuery.estimate,cloudTokensPerHandoff:handedOffQueries.cloudInputTokensPerQuery.estimate,cloudInputTokensPerQuery:allQueries.cloudInputTokensPerQuery.estimate,cloudTotalTokensPerQuery:allQueries.cloudTotalTokensPerQuery.estimate,cloudInputTokensPerHandoff:handedOffQueries.cloudInputTokensPerQuery.estimate,cloudTotalTokensPerHandoff:handedOffQueries.cloudTotalTokensPerQuery.estimate,costPer1000Usd:allQueries.costPer1000Usd.estimate,costPer1000AllQueriesUsd:allQueries.costPer1000Usd.estimate,costPer1000HandedOffQueriesUsd:handedOffQueries.costPer1000Usd.estimate,cloudOnlyCostPer1000Usd:allQueries.cloudOnlyCostPer1000Usd.estimate,cloudOnlyCostPer1000AllQueriesUsd:allQueries.cloudOnlyCostPer1000Usd.estimate,cloudOnlyCostPer1000HandedOffQueriesUsd:handedOffQueries.cloudOnlyCostPer1000Usd.estimate,savingRateAllQueries:allQueries.savingRate.estimate,
    localAllocationPer1000Usd:localAllocationPerQuery*1000,combinedCostPer1000AllQueriesUsd:allQueries.costPer1000Usd.estimate==null?null:allQueries.costPer1000Usd.estimate+localAllocationPerQuery*1000,qualityPerDollar:null,qualityPerDollarStatus:'pending Tier 1 cloud quality',actualCloudCalls:0,actualCloudSpendUsd:0,
    method:'Per-item counted payload input tokens and per-item-type projected output lengths; sum weighted item fees before dividing. Local/blocked/unsafe cloud fees are zero. Baseline uses exactly the same item population, with a separate matched handed-off subset. No routed-share-times-average approximation.',headlineBasis:'allQueries cloud fees only; local hardware/electricity allocation is reported separately',assumptions:true,outputLengthsAreProjected:true,serverFramingKnown:rows.every(row=>row.serverFramingKnown===true),tokenMethods:[...new Set(rows.map(row=>row.tokenMethod).filter(Boolean))]};
}

/** Explain equal model cost figures using actual per-item routing/payload hashes,
 * rather than calling different Gemma sizes interchangeable. */
export function compareCostIdentity(leftRows,rightRows){
  const right=new Map(rightRows.map(row=>[row.id,row]));
  if(leftRows.length!==rightRows.length||leftRows.some(row=>!right.has(row.id)))return{same:false,reason:'The item populations differ'};
  const differentDecisions=[],differentPayloads=[],differentCounts=[],differentOutputAssumptions=[];
  for(const left of leftRows){const other=right.get(left.id);if(left.handedOff!==other.handedOff||left.eligible!==other.eligible)differentDecisions.push(left.id);if(left.payloadHash!==other.payloadHash||left.baselinePayloadHash!==other.baselinePayloadHash)differentPayloads.push(left.id);if(left.inputTokens!==other.inputTokens||left.baselineInputTokens!==other.baselineInputTokens)differentCounts.push(left.id);if(left.projectedOutputTokens!==other.projectedOutputTokens||left.projectedReasoningTokens!==other.projectedReasoningTokens)differentOutputAssumptions.push(left.id);}
  const same=![differentDecisions,differentPayloads,differentCounts,differentOutputAssumptions].some(values=>values.length);
  return{same,items:leftRows.length,differentDecisions,differentPayloads,differentCounts,differentOutputAssumptions,reason:same?'Same per-item route mask, identical serialized handoff and baseline payloads, equal counted input tokens and shared per-type output assumptions. The models remain separate; equal cloud-fee forecasts do not imply equal answers, model size, local latency or local cost.':'Per-item routing, payload text/counts or output assumptions differ; figures must be computed separately.'};
}

export function legacyCostBridge(plan,{effectiveLocalAllocationPer1000Usd}={}){
  const allocation=effectiveLocalAllocationPer1000Usd??(plan.localAllocationIncluded??0)*1000;
  if(![plan.costPer1000Usd,plan.cloudOnlyCostPer1000Usd,allocation].every(finite))throw new Error('A complete historical cost plan is required for the accounting bridge');
  const cloudFees=plan.costPer1000Usd-allocation,cloudOnly=plan.cloudOnlyCostPer1000Usd;
  return{historicalCombinedCostPer1000Usd:plan.costPer1000Usd,historicalCloudFeesPer1000Usd:cloudFees,historicalLocalAllocationPer1000Usd:allocation,historicalCloudOnlyPer1000Usd:cloudOnly,cloudFeeSavingPer1000Usd:cloudOnly-cloudFees,combinedPremiumPer1000Usd:plan.costPer1000Usd-cloudOnly,guardWrapperTokens:0,receiptMetadataTokens:0,localDraftTokens:0,explanation:'The earlier headline included a local allocation while the cloud-only reference did not. Guard wrappers, receipts and local drafts were not sent. The local allocation exceeded the cloud fees avoided by local answers; the displayed premium was not extra receipt/Guard tokens.'};
}
