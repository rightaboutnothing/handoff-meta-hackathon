import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeCloudCosts, compareCostIdentity, projectedCloudFee, legacyCostBridge } from '../src/comparison/cost-metrics.mjs';

const pricing={localAllocationUsdPerQuery:.0002,clouds:{gemini:{inputUsdPerMillion:1,outputUsdPerMillion:2}}};
const pipeline={id:'gemma4b+llamaguard+gemini',name:'Gemma 4B / Llama Guard / Gemini',localModelId:'gemma3:4b',cloudId:'gemini'};
const sourceCounts={instructions:10,query:20,retrievedChunks:30,localDraft:0,serializationLabelsAndSeparators:5,guardWrapper:0,receiptMetadata:0,piiMap:0};
const row=(id,overrides={})=>({id,groupId:id,category:'knowledge',eligible:true,handedOff:true,inputTokens:1000,baselineInputTokens:1000,projectedOutputTokens:100,projectedReasoningTokens:0,inputComponents:sourceCounts,baselineInputComponents:sourceCounts,payloadHash:'same-payload',baselinePayloadHash:'same-baseline',...overrides});
const summary=rows=>summarizeCloudCosts(rows,{pipeline,pricing,replicates:40});

test('cloud fees are summed per actual payload/item, never routed share times workload-average size',()=>{
  const result=summary([row('large'),row('small',{handedOff:false,inputTokens:1,baselineInputTokens:1,projectedOutputTokens:10})]);
  assert.equal(result.cloudInputTokensPerQuery,500);assert.equal(result.cloudInputTokensPerHandoff,1000);
  assert.ok(Math.abs(result.costPer1000AllQueriesUsd-.6)<1e-12);assert.ok(Math.abs(result.cloudOnlyCostPer1000AllQueriesUsd-.6105)<1e-12);
  assert.equal(result.costPer1000HandedOffQueriesUsd,1.2);assert.equal(result.cloudOnlyCostPer1000HandedOffQueriesUsd,1.2);
  assert.equal(result.localAllocationPer1000Usd,.2);assert.ok(Math.abs(result.combinedCostPer1000AllQueriesUsd-.8)<1e-12);
  assert.ok(result.allQueries.costPer1000Usd.ci95);assert.equal(result.qualityPerDollar,null);
});
test('local and blocked items cost zero in cloud fees, even when potential payload tokenization is unavailable',()=>{
  const result=summary([row('local',{handedOff:false,inputTokens:null}),row('blocked',{handedOff:false,inputTokens:null})]);
  assert.equal(result.costPer1000AllQueriesUsd,0);assert.equal(result.cloudTokensPerQuery,0);assert.equal(result.handedOffItems,0);
  assert.equal(result.costPer1000HandedOffQueriesUsd,null);assert.equal(result.qualityPerDollar,null);assert.equal(result.actualCloudSpendUsd,0);
});
test('unsafe items have structural zero cloud costs and an unsafe handoff cannot be scored as cloud work',()=>{
  const result=summary([row('safe'),row('adversarial',{eligible:false,handedOff:false,inputTokens:null,baselineInputTokens:null,projectedOutputTokens:null})]);
  assert.equal(result.costPer1000AllQueriesUsd,.6);assert.equal(result.cloudOnlyCostPer1000AllQueriesUsd,.6);
  assert.throws(()=>summary([row('unsafe',{eligible:false})]),/cannot have a cloud handoff/);
  assert.throws(()=>summary([row('metadata',{inputComponents:{receiptMetadata:4}})]),/Local-only metadata/);
});
test('missing required token counts stay pending instead of becoming free or inflating the saving',()=>{
  const result=summary([row('known'),row('missing',{inputTokens:null})]);
  assert.equal(result.costPer1000AllQueriesUsd,null);assert.equal(result.allQueries.costPer1000Usd.coverage,.5);assert.equal(result.savingRateAllQueries,null);
  assert.equal(result.allQueries.costPer1000Usd.ci95,null);
  const missingBaseline=summary([row('one',{baselineInputTokens:null})]);assert.equal(missingBaseline.cloudOnlyCostPer1000AllQueriesUsd,null);assert.equal(missingBaseline.savingRateAllQueries,null);
});
test('category weights apply to per-item costs and output lengths, with output and reasoning assumptions counted once',()=>{
  const result=summary([row('short',{inputTokens:100,baselineInputTokens:100,projectedOutputTokens:10,projectedReasoningTokens:20,weight:3}),row('long',{inputTokens:1000,baselineInputTokens:1000,projectedOutputTokens:100,projectedReasoningTokens:200,weight:1})]);
  assert.equal(result.cloudTokensPerQuery,325);assert.equal(result.allQueries.projectedAnswerTokensPerQuery.estimate,32.5);assert.equal(result.allQueries.projectedReasoningTokensPerQuery.estimate,65);
  assert.equal(result.costPer1000AllQueriesUsd,.52);assert.equal(projectedCloudFee('gemini',{inputTokens:100,outputTokens:10,reasoningTokens:20},pricing),.00016);
  assert.equal(result.outputLengthsAreProjected,true);assert.equal(result.headlineBasis,'allQueries cloud fees only; local hardware/electricity allocation is reported separately');
});
test('different pipelines and local model sizes cannot be averaged; equal cost identity explains exact matching routes and payloads',()=>{
  assert.throws(()=>summary([row('one',{pipelineId:'a'}),row('two',{pipelineId:'b'})]),/Never average/);
  assert.throws(()=>summary([row('one',{localModelId:'gemma3:4b'}),row('two',{localModelId:'gemma3:12b'})]),/Never average/);
  const left=[row('one'),row('two',{handedOff:false})],right=structuredClone(left);
  assert.equal(compareCostIdentity(left,right).same,true);assert.match(compareCostIdentity(left,right).reason,/Same per-item route mask/);
  right[0].payloadHash='model-specific-draft';right[0].inputTokens=1010;
  const differs=compareCostIdentity(left,right);assert.equal(differs.same,false);assert.deepEqual(differs.differentPayloads,['one']);assert.deepEqual(differs.differentCounts,['one']);
});
test('historical Finkd Gemini premium is local allocation, not transmitted guard, receipt or draft tokens',()=>{
  const result=legacyCostBridge({costPer1000Usd:1.375884,cloudOnlyCostPer1000Usd:1.254921,localAllocationIncluded:.0002});
  assert.ok(Math.abs(result.historicalCloudFeesPer1000Usd-1.175884)<1e-12);assert.ok(Math.abs(result.cloudFeeSavingPer1000Usd-.079037)<1e-12);
  assert.equal(result.guardWrapperTokens,0);assert.equal(result.receiptMetadataTokens,0);assert.equal(result.localDraftTokens,0);
});
