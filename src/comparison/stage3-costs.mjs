import {buildLeanPayload,LEAN_PAYLOAD_LIMITS} from './handoff-payload.mjs';
import {summarizeCloudCosts} from './cost-metrics.mjs';
import {bootstrapEstimate} from './metrics.mjs';
import {isCloudEligible} from './policy.mjs';
import {sha256} from '../rag/receipts.mjs';

export const STAGE3_COST_VERSION='stage3-offline-question-only-projection-v1';
const providers=Object.freeze(['gemini','muse-spark']);
const sources=Object.freeze(['instructions','query','retrievedChunks','localDraft','serializationLabelsAndSeparators','guardWrapper','receiptMetadata','piiMap']);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const sliceOf=category=>/^company-data(?:[ -])/.test(String(category))?'company':'general';
const weight=row=>row.weight??1;

function checkedCounters(counters){
  if(typeof counters?.countText!=='function'||typeof counters?.countPayload!=='function')throw new Error('Offline native/proxy token counters are required');
  for(const provider of providers){const meta=counters.metadata?.[provider];
    if(meta?.exactForSelectedTokenizer!==true||!['provider_selected_local_tokenizer','documented_local_proxy'].includes(meta?.method)||(meta.remoteCountRequests??0)!==0||(meta.cloudInferenceCalls??0)!==0)throw new Error('Stage 3 requires documented offline tokenizer evidence and zero remote calls');
  }
}
function checkedProjection(category,pricing,maxTokens){
  const output=pricing?.outputProjections?.[category];
  if(!output||![output.answerTokens,output.reasoningTokens].every(value=>Number.isInteger(value)&&value>=0)||output.answerTokens+output.reasoningTokens>maxTokens)throw new Error('An explicit per-category output projection within the cloud cap is required');
  return output;
}
function checkedItem(row){
  if(typeof row?.id!=='string'||!row.id||typeof row.category!=='string'||typeof row.safe!=='boolean'||typeof row.accepted!=='boolean')throw new Error('Projection rows require item identity, category and explicit safe/accepted booleans');
  const modelId=row.modelId??row.localModelId;if(typeof modelId!=='string'||!modelId)throw new Error('A separate explicit local model ID is required for every projection row');
  const population=row.population??row.cohort??row.split??'comparison';if(typeof population!=='string'||!population)throw new Error('An explicit cost population must be a nonempty string');
  if(row.weight!=null&&(!finite(row.weight)||row.weight<0))throw new Error('Projection weights must be finite and nonnegative');
  const item={...(row.item??{}),id:row.id,category:row.category};
  for(const field of ['suite','type','harmful','redTeam','poisoning','localOnly'])if(row[field]!=null)item[field]=row[field];
  item.safety=row.safety??item.safety??{kind:row.safe?'safe':'local-only',cloudEligible:row.safe};
  if(row.cloudEligible!=null)item.cloudEligible=row.cloudEligible;
  const eligible=row.safe&&isCloudEligible(item),slice=sliceOf(row.category);
  if(row.slice!=null&&row.slice!==slice)throw new Error('Cost slice conflicts with the item category');
  return{item,modelId,population,eligible,slice};
}
function zeroCount(metadata){return{inputTokens:0,contentTokens:0,billingInputTokens:null,serverFramingTokens:null,components:Object.fromEntries(sources.map(source=>[source,0])),metadata};}
function checkedCount(count){
  if(!Number.isInteger(count?.inputTokens)||count.inputTokens<0)throw new Error('A finite actual local content-token count is required');
  if(!count.components||Object.values(count.components).some(value=>!finite(value))||Math.abs(Object.values(count.components).reduce((sum,value)=>sum+value,0)-count.inputTokens)>1e-9)throw new Error('Counted token-source components must sum to the saved wire content');
  if(['guardWrapper','receiptMetadata','piiMap','localDraft'].some(source=>(count.components[source]??0)!==0))throw new Error('Local routing, privacy, proof or answer metadata cannot be part of the Stage 3 cloud payload');
  return count;
}
function requestRate(rows,predicate,options){
  return bootstrapEstimate(rows,sample=>{const denominator=sample.reduce((sum,row)=>sum+weight(row),0);return denominator?sample.reduce((sum,row)=>sum+weight(row)*Number(predicate(row)),0)/denominator:null;},options);
}

/** Count exact saved question-only potential wires offline. This helper neither
 * chooses thresholds nor dispatches cloud/Guard requests. Each provider's
 * all-cloud baseline receives exactly the same lean redacted question/context.
 * Raw payload objects are returned separately for ignored local persistence. */
export async function projectStage3Costs(inputRows,{pricing,counters,seed=20261027,replicates=400,payloadOptions={},cloudOutputMaxTokens=384}={}){
  if(!Array.isArray(inputRows))throw new Error('Projection rows must be an array');checkedCounters(counters);
  if(!Number.isInteger(cloudOutputMaxTokens)||cloudOutputMaxTokens<1)throw new Error('The unchanged explicit cloud output cap is required');
  if(payloadOptions.includeDraft||payloadOptions.draft!=null)throw new Error('Stage 3 projections use question-only payloads; local drafts and control metadata stay local');
  if((pricing?.serverFramingTokensAssumed??0)!==0||(pricing?.cacheHitRateAssumed??0)!==0)throw new Error('Only the recorded zero-framing and zero-cache-discount planning assumptions are supported');
  for(const provider of providers){const rate=pricing?.clouds?.[provider];if(!rate||![rate.inputUsdPerMillion,rate.outputUsdPerMillion].every(value=>finite(value)&&value>=0))throw new Error('Explicit unchanged nonnegative cloud price assumptions are required');}
  const limits={topK:payloadOptions.topK??LEAN_PAYLOAD_LIMITS.topK,contextTokenBudget:payloadOptions.contextTokenBudget??LEAN_PAYLOAD_LIMITS.contextTokenBudget,draftTokenBudget:0};
  const countText=text=>Math.max(...providers.map(provider=>counters.countText(provider,text))),payloadMemo=new Map(),payloads=new Map(),countRows=[],seen=new Set();
  for(const row of inputRows){
    const {item,modelId,population,eligible,slice}=checkedItem(row),identity=JSON.stringify([population,modelId,row.id]);if(seen.has(identity))throw new Error('One effective outcome per population/model/item is required');seen.add(identity);
    const projection=eligible?checkedProjection(row.category,pricing,cloudOutputMaxTokens):{answerTokens:0,reasoningTokens:0};
    let payload=null,counts=null;
    if(eligible){
      const prepared=row.prepared;if(typeof prepared?.question!=='string'||!Array.isArray(prepared.chunks))throw new Error('Every safe item requires its saved redacted question and retrieved source chunks');
      // A trusted local calculator is evidence for local answers, not a cloud
      // source document. Neither its numeric draft nor its proof crosses here.
      const chunks=prepared.chunks.filter(chunk=>!chunk?.verifiedLocalTool&&!chunk?.isTool&&chunk?.kind!=='local_calculator'&&!String(chunk?.chunkId).startsWith('calc:'));
      const memoKey=sha256({question:prepared.question,chunks:chunks.map(({chunkId,text,file,hash,score})=>({chunkId,text,file,hash,score})),limits});
      if(!payloadMemo.has(memoKey)){
        const potential=await buildLeanPayload(item,{question:prepared.question,chunks},{...limits,includeDraft:false,countText,budgetTokenizer:'Maximum of the two pinned offline cloud text counters; no remote counting'});
        const tokenCounts=Object.fromEntries(providers.map(provider=>[provider,checkedCount(counters.countPayload(provider,potential))]));
        payloadMemo.set(memoKey,{payload:potential,tokenCounts});
      }
      const cached=payloadMemo.get(memoKey);payload=cached.payload;counts=cached.tokenCounts;
      if(!payloads.has(payload.payloadHash))payloads.set(payload.payloadHash,{payloadHash:payload.payloadHash,payload,tokenCounts:counts});
    }
    for(const cloudId of providers){
      const count=counts?.[cloudId]??zeroCount(counters.metadata[cloudId]),pipelineId=`${modelId}+calibrated-local+${cloudId}`;
      countRows.push({id:row.id,groupId:row.groupId??row.id,population,modelId,localModelId:modelId,category:row.category,slice,cloudId,pipelineId,variant:'question-only',eligible,accepted:eligible&&row.accepted,handedOff:eligible&&!row.accepted,
        inputTokens:count.inputTokens,baselineInputTokens:count.inputTokens,projectedOutputTokens:projection.answerTokens,projectedReasoningTokens:projection.reasoningTokens,inputComponents:{...count.components},baselineInputComponents:{...count.components},payloadHash:payload?.payloadHash??null,baselinePayloadHash:payload?.payloadHash??null,providerWireTextHash:count.providerWireTextHash??null,
        tokenMethod:count.metadata.method,serverFramingKnown:false,serverFramingTokens:null,billingInputTokens:null,weight:weight(row),selectedChunkCount:payload?.context.length??0,sourceChunkCount:eligible?row.prepared.chunks.filter(chunk=>!chunk?.verifiedLocalTool&&!chunk?.isTool&&chunk?.kind!=='local_calculator'&&!String(chunk?.chunkId).startsWith('calc:')).length:0});
    }
  }
  const summary=[],options={seed,replicates};
  for(const population of [...new Set(countRows.map(row=>row.population))])for(const modelId of [...new Set(countRows.filter(row=>row.population===population).map(row=>row.modelId))])for(const slice of ['company','general','overall'])for(const cloudId of providers){
    const selected=countRows.filter(row=>row.population===population&&row.modelId===modelId&&row.cloudId===cloudId&&(slice==='overall'||row.slice===slice));if(!selected.length)continue;
    const pipeline={id:`${modelId}+calibrated-local+${cloudId}`,name:`${modelId} / calibrated local / ${cloudId}`,localModelId:modelId,cloudId};
    const plan=summarizeCloudCosts(selected,{pipeline,cloudId,variant:'question-only',pricing,...options});
    const skipped=requestRate(selected,row=>row.eligible&&row.accepted,options),projected=requestRate(selected,row=>row.handedOff,options);
    summary.push({...plan,population,slice,modelId,cloudCallsSkipped:selected.filter(row=>row.eligible&&row.accepted).length,projectedCloudCalls:selected.filter(row=>row.handedOff).length,cloudOnlyCalls:selected.filter(row=>row.eligible).length,adversarialLocalOnlyItems:selected.filter(row=>!row.eligible).length,
      projectedCloudCallsSkippedPer1000:{...skipped,estimate:skipped.estimate==null?null:skipped.estimate*1000,ci95:skipped.ci95?.map(value=>value*1000)??null},projectedCloudCallsPer1000:{...projected,estimate:projected.estimate==null?null:projected.estimate*1000,ci95:projected.ci95?.map(value=>value*1000)??null},
      requestScope:'Conditional pre-Guard projection from locked code acceptance; no new Guard screening, remote answers or cloud quality are measured',contextCompletenessNotGuaranteed:true,cloudOutputMaxTokens,cacheDiscountAssumed:0,serverFramingTokensAssumed:0,actualCloudCalls:0,actualCloudSpendUsd:0,remoteCountingCalls:0});
  }
  return{version:STAGE3_COST_VERSION,summary,privatePayloads:[...payloads.values()],countRows,tokenizerMetadata:structuredClone(counters.metadata),settings:{seed,replicates,variant:'question-only',payloadLimits:limits,cloudOutputMaxTokens,cacheDiscountAssumed:0,serverFramingTokensAssumed:0},cloudCalls:0,remoteCountingCalls:0,actualSpendUsd:0,
    limitations:['Gemini uses its pinned SDK-selected offline text tokenizer; Muse Spark uses a documented Llama BPE proxy. Hidden service framing and actual billing tokens remain unknown.',
      'Input content counts are real for the recorded local tokenizer artifacts. Visible answer/reasoning lengths and unit prices remain assumptions, not observed cloud usage.',
      'All-query headline cloud fees include accepted and adversarial items at zero. Calls skipped count accepted safe items only; adversarial items already have a zero-cloud baseline.',
      'Question-only handoff and cloud-only baselines share the same minimal evidence; it may omit sources needed for cloud answer quality. No cloud quality or new Guard outcome is claimed.',
      'Related source families are retained in bootstrap confidence intervals. Distinct model sizes and evaluation populations are never pooled.']};
}
