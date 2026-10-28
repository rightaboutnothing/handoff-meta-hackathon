import test from'node:test';
import assert from'node:assert/strict';
import{projectStage3Costs}from'../src/comparison/stage3-costs.mjs';
import{assemblePayloadCount}from'../src/server/token-counts.mjs';
import{serializeLeanUserPayload}from'../src/comparison/handoff-payload.mjs';

const pricing={localAllocationUsdPerQuery:.0002,serverFramingTokensAssumed:0,cacheHitRateAssumed:0,clouds:{gemini:{inputUsdPerMillion:1,outputUsdPerMillion:2},'muse-spark':{inputUsdPerMillion:3,outputUsdPerMillion:4}},outputProjections:{knowledge:{answerTokens:20,reasoningTokens:10},'company-data multi-doc':{answerTokens:30,reasoningTokens:20},'safety-boundary':{answerTokens:10,reasoningTokens:0}}};
const metadata={gemini:{method:'provider_selected_local_tokenizer',exactForSelectedTokenizer:true,remoteCountRequests:0,cloudInferenceCalls:0,exactProviderBillingTokens:false},'muse-spark':{method:'documented_local_proxy',exactForSelectedTokenizer:true,remoteCountRequests:0,cloudInferenceCalls:0,exactProviderBillingTokens:false}};
function counters(){const requests=[];return{requests,metadata,countText(provider,text){requests.push({provider,text});return Math.ceil(Buffer.byteLength(text,'utf8')/(provider==='gemini'?3:2));},countPayload(provider,payload){return assemblePayloadCount(provider,payload,text=>({length:this.countText(provider,text)}),metadata[provider]);}};}
const row=(id,overrides={})=>({id,groupId:id,modelId:'llama3.1:8b',population:'frozen60',category:'knowledge',safe:true,accepted:false,prepared:{question:'Answer the safe knowledge question.',chunks:[]},...overrides});
const options=()=>({pricing,counters:counters(),replicates:40});
const plan=(result,model='llama3.1:8b',slice='overall',cloud='gemini',population='frozen60')=>result.summary.find(p=>p.modelId===model&&p.slice===slice&&p.cloudId===cloud&&p.population===population);

test('costs use exact per-provider payload counts and all-query zero charges for accepted answers',async()=>{
  const actualCounters=counters(),result=await projectStage3Costs([row('cloud'),row('local',{accepted:true})],{pricing,counters:actualCounters,replicates:40}),gemini=plan(result),meta=plan(result,undefined,undefined,'muse-spark');
  assert.equal(result.countRows.length,4);assert.equal(result.privatePayloads.length,1);assert.equal(gemini.cloudCallsSkipped,1);assert.equal(gemini.projectedCloudCalls,1);assert.equal(gemini.projectedCloudCallsSkippedPer1000.estimate,500);
  const wire=result.privatePayloads[0].payload,expected=actualCounters.countText('gemini',wire.system)+actualCounters.countText('gemini',serializeLeanUserPayload(wire));
  assert.equal(gemini.cloudInputTokensPerQuery,expected/2);assert.equal(gemini.cloudOnlyCostPer1000Usd,gemini.costPer1000AllQueriesUsd*2);assert.ok(meta.cloudInputTokensPerQuery>gemini.cloudInputTokensPerQuery);
  assert.deepEqual(gemini.allQueries.savingRate.ci95,[0,1]);assert.equal(gemini.qualityPerDollar,null);assert.equal(gemini.serverFramingKnown,false);assert.equal(gemini.actualCloudSpendUsd,0);
});
test('unsafe/adversarial items never build payloads, invoke tokenizers, or inflate safe skipped-call counts',async()=>{
  const actualCounters=counters(),unsafe=row('unsafe',{safe:false,accepted:true,prepared:{question:'CANARY-LOCAL-EXCLUDED test',chunks:[]},safety:{kind:'red-team',cloudEligible:false}});
  const result=await projectStage3Costs([unsafe],{pricing,counters:actualCounters,replicates:40}),p=plan(result);
  assert.equal(actualCounters.requests.length,0);assert.equal(result.privatePayloads.length,0);assert.equal(p.costPer1000AllQueriesUsd,0);assert.equal(p.cloudOnlyCostPer1000Usd,0);assert.equal(p.cloudCallsSkipped,0);assert.equal(p.adversarialLocalOnlyItems,1);
  assert.ok(result.countRows.every(r=>r.payloadHash===null&&r.inputTokens===0&&!r.handedOff));
  const contradicted=await projectStage3Costs([row('forbidden',{suite:'StrongREJECT',safe:true})],options());assert.equal(contradicted.privatePayloads.length,0);
  const unknownUnsafe=await projectStage3Costs([row('unknown-unsafe',{safe:false,category:'harmful',prepared:null})],options());assert.equal(unknownUnsafe.privatePayloads.length,0);assert.ok(unknownUnsafe.countRows.every(r=>r.projectedOutputTokens===0));
});
test('company/general slices, model sizes and separate populations are never pooled',async()=>{
  const company={category:'company-data multi-doc',prepared:{question:'What is the warranty?',chunks:[{chunkId:'warranty-1',file:'policy.md',text:'Warranty is 18 months.',hash:'h',score:.9}]}};
  const result=await projectStage3Costs([row('a',{...company,accepted:true}),row('b'),row('a',{...company,modelId:'gemma3:12b'}),row('b',{modelId:'gemma3:12b',accepted:true}),row('a',{population:'plain50',accepted:false})],options());
  assert.equal(plan(result,'llama3.1:8b','company').costPer1000Usd,0);assert.equal(plan(result,'gemma3:12b','company').cloudCallsSkipped,0);assert.equal(plan(result,'gemma3:12b','general').costPer1000Usd,0);
  assert.equal(plan(result,'llama3.1:8b','overall','gemini','plain50').items,1);assert.equal(plan(result).items,2);
  await assert.rejects(projectStage3Costs([row('a'),row('a')],options()),/one effective/i);
});
test('proofs, PII maps, verdicts, local drafts and calculator chunks never appear in a wire',async()=>{
  const source={chunkId:'policy-1',file:'policy.md',text:'Warranty is 18 months.',hash:'h',score:.8},tool={chunkId:'calc:private',verifiedLocalTool:true,text:'LOCAL_TOOL_SECRET_RESULT',file:'local-tools/calculator',score:1};
  const result=await projectStage3Costs([row('company',{category:'company-data multi-doc',prepared:{question:'What is the warranty?',chunks:[source,tool],receipt:{signature:'LOCAL_RECEIPT_SECRET'},piiMap:{name:'LOCAL_NAME_SECRET'},guardVerdict:'LOCAL_GUARD_SECRET'},answer:{answer:'LOCAL_DRAFT_SECRET'}})],options());
  const wire=JSON.stringify(result.privatePayloads[0].payload.wire);assert.doesNotMatch(wire,/LOCAL_|calc:|receipt|confidence|piiMap/);
  assert.deepEqual(result.privatePayloads[0].payload.wire.context.map(c=>c.chunkId),['policy-1']);assert.ok(result.countRows.every(r=>r.inputComponents.receiptMetadata===0&&r.inputComponents.guardWrapper===0&&r.inputComponents.piiMap===0&&r.inputComponents.localDraft===0));
  await assert.rejects(projectStage3Costs([row('a')],{...options(),payloadOptions:{includeDraft:true}}),/question-only/);
});
test('missing counts, unknown categories, raw private patterns and undocumented estimators fail closed',async()=>{
  await assert.rejects(projectStage3Costs([row('a',{accepted:undefined})],options()),/booleans/);
  const unknown=await projectStage3Costs([row('a',{category:'unknown'})],options());assert.equal(unknown.privatePayloads.length,0);assert.ok(unknown.countRows.every(r=>!r.handedOff));
  await assert.rejects(projectStage3Costs([row('a',{prepared:{question:'Email secret@example.invalid',chunks:[]}})],options()),/private-field/);
  const bad=counters();bad.metadata={...metadata,gemini:{method:'chars-divided-by-four'}};await assert.rejects(projectStage3Costs([row('a')],{pricing,counters:bad}),/offline tokenizer evidence/);
  const missing=counters();missing.countPayload=()=>({inputTokens:null});await assert.rejects(projectStage3Costs([row('a')],{pricing,counters:missing}),/content-token count/);
  await assert.rejects(projectStage3Costs([row('a')],{...options(),pricing:{...pricing,serverFramingTokensAssumed:64}}),/framing/);
});
test('the helper has no network/threshold side effects and ignores grading references for cost accounting',async()=>{
  const original=globalThis.fetch;globalThis.fetch=()=>assert.fail('No network requests are permitted');
  try{const rows=[row('a',{accepted:true,scoring:{score:0,labelAvailable:true},reference:{answer:'NEVER_SENT_REFERENCE'}}),row('b',{scoring:{score:1,labelAvailable:true}})],snapshot=structuredClone(rows),result=await projectStage3Costs(rows,options());
    assert.deepEqual(rows,snapshot);assert.equal(plan(result).cloudCallsSkipped,1);assert.equal(result.cloudCalls,0);assert.equal(result.remoteCountingCalls,0);assert.doesNotMatch(JSON.stringify(result.privatePayloads),/NEVER_SENT_REFERENCE/);
    assert.match(plan(result).requestScope,/pre-Guard/);assert.equal(plan(result).contextCompletenessNotGuaranteed,true);
  }finally{globalThis.fetch=original;}
});
