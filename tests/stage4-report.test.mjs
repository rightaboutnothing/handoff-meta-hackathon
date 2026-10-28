import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {stage4SliceIds,summarizeStage4Slice,summarizeStage4Cost,blendStage4Costs,buildStage4Report,renderStage4Summary} from '../src/comparison/stage4.mjs';
import {sha256} from '../src/rag/receipts.mjs';

const modelIds=['llama3.1:8b','gemma3:4b','gemma3:12b'];
const safety={kind:'safe',cloudEligible:true};
const decision=(id,change={})=>({id,modelId:'gemma3:12b',population:'frozen-saved60',category:'company-data multi-doc',suite:'company-rag',safe:true,safety,accepted:true,gate:{eligible:true},decision:{route:'local'},scoring:{score:1,labelAvailable:true},stages:[{stage:'retrieval',latencyMs:20},{stage:'local_answer',latencyMs:100},{stage:'local_self_check',latencyMs:30}],...change});
const pricing={currency:'USD',assumptions:true,label:'Assumptions',clouds:{gemini:{modelId:'gemini-test',inputUsdPerMillion:.3,outputUsdPerMillion:2.5},'muse-spark':{modelId:'muse-spark-1.3',inputUsdPerMillion:2,outputUsdPerMillion:6}},outputProjections:{},outputProjectionLabel:'Assumed output'};
const count=(id,change={})=>({id,cloudId:'gemini',inputTokens:100,baselineInputTokens:100,projectedOutputTokens:128,projectedReasoningTokens:64,eligible:true,accepted:false,handedOff:true,payloadHash:'hash',inputComponents:{instructions:20,query:80,retrievedChunks:0,localDraft:0,guardWrapper:0,receiptMetadata:0,piiMap:0},...change});

test('company subtypes partition while arithmetic is an explicit nonadditive frozen overlay',()=>{
  assert.deepEqual(stage4SliceIds(decision('c',{arithmeticEligible:true})),['company','company-multi','company-arithmetic','overall']);
  assert.deepEqual(stage4SliceIds(decision('c',{category:'company-data single-doc',arithmeticEligible:false}),{prompt:'Calculate a total.'}),['company','company-single','overall']);
  assert.ok(stage4SliceIds(decision('c',{category:'company-data single-doc',arithmeticEligible:undefined}),{prompt:'Calculate a total.'}).includes('company-arithmetic'));
  assert.deepEqual(stage4SliceIds(decision('m',{category:'reasoning',suite:'mmlu-pro'})),['knowledge','non-company','overall']);
  assert.deepEqual(stage4SliceIds(decision('g',{category:'reasoning',suite:'gpqa'})),['gpqa','non-company','overall']);
  assert.deepEqual(stage4SliceIds(decision('i',{category:'instruction-following',suite:'ifeval'})),['other','non-company','overall']);
});
test('Wilson uses conservative unknown-as-wrong labels; zero acceptance is undefined, not perfect',()=>{
  const rows=[decision('a'),decision('b',{scoring:{labelAvailable:false,score:null}}),decision('c',{accepted:false}),decision('unsafe',{safe:false,accepted:false,safety:{kind:'harmful',cloudEligible:false}})],s=summarizeStage4Slice(rows);
  assert.equal(s.accepted,2);assert.equal(s.acceptedCorrect,1);assert.equal(s.acceptedUnknown,1);assert.equal(s.acceptanceRate,.5);assert.equal(s.acceptanceRateSafe,2/3);assert.equal(s.acceptedAccuracy,.5);assert.ok(s.acceptedAccuracyWilson95[0]<.5&&s.acceptedAccuracyWilson95[1]>.5);
  assert.equal(s.escalations,1);assert.equal(s.escalationRate,.25);assert.equal(s.localOnly,1);
  const zero=summarizeStage4Slice([decision('z',{accepted:false})]);assert.equal(zero.acceptedAccuracy,null);assert.equal(zero.acceptedAccuracyWilson95,null);assert.equal(zero.exploratorySmallSlice,true);
});
test('saved local latency excludes warmup and explicit errors and includes both local steps and retrieval',()=>{
  const s=summarizeStage4Slice([decision('a',{stages:[{stage:'retrieval',latencyMs:20},{stage:'local_answer',latencyMs:100},{stage:'local_self_check',latencyMs:30},{stage:'warm-up',latencyMs:99999}]}),decision('b',{stages:[{stage:'retrieval',latencyMs:50},{stage:'local_answer',latencyMs:200},{stage:'local_self_check',latencyMs:50}]}),decision('e',{error:'FAILED'})]);
  assert.equal(s.latencyMeasured,2);assert.equal(s.medianLatencyMs,225);assert.equal(s.errors,1);assert.equal(s.medianAcceptedLatencyMs,225);
});
test('costs use counted per-provider inputs with zero local/unsafe cloud fees and matched baselines',()=>{
  const rows=[count('handoff'),count('local',{accepted:true,handedOff:false}),count('unsafe',{eligible:false,accepted:false,handedOff:false,inputTokens:0,baselineInputTokens:0,payloadHash:null})],s=summarizeStage4Cost(rows,'gemini',pricing);
  const one=(100*.3+192*2.5)/1e6;assert.equal(s.costPer1000,one/3*1000);assert.equal(s.cloudOnlyPer1000,one*2/3*1000);assert.equal(s.savingRate,.5);assert.equal(s.inputTokensPerQuery,100/3);assert.equal(s.cloudCallsSkipped,1);assert.equal(s.actualCloudCalls,0);
  assert.throws(()=>summarizeStage4Cost([count('bad',{inputComponents:{localDraft:1}})],'gemini',pricing),/draft/);
  assert.throws(()=>summarizeStage4Cost([count('bad',{eligible:false})],'gemini',pricing),/Adversarial/);
  assert.throws(()=>summarizeStage4Cost([count('bad',{baselineInputTokens:101})],'gemini',pricing),/identical/);
});
test('workload blending weights observed company and noncompany costs without pooling models or output lengths',()=>{
  const c={costPer1000:.2,cloudOnlyPer1000:1,savingPer1000:.8,inputTokensPerQuery:10,projectedTokensPerQuery:20},r={costPer1000:2,cloudOnlyPer1000:2,savingPer1000:0,inputTokensPerQuery:30,projectedTokensPerQuery:40},s=blendStage4Costs(c,r,.75);
  assert.equal(s.costPer1000,.65);assert.equal(s.cloudOnlyPer1000,1.25);assert.equal(s.savingPer1000,.6);assert.equal(s.savingRate,.48);assert.equal(s.inputTokensPerQuery,15);assert.equal(s.actualCloudCalls,0);
  assert.throws(()=>blendStage4Costs(c,r,1.1),/fraction/);
});

function fixture(){
  const calibration={alpha:.05,models:Object.fromEntries(modelIds.map(modelId=>[modelId,{slices:Object.fromEntries(['company','general'].map(slice=>[slice,{status:modelId==='gemma3:12b'&&slice==='company'?'CERTIFIED_FINITE_DEV_FRAME':'ABSTAIN_UNCERTIFIED',threshold:modelId==='gemma3:12b'&&slice==='company'?.03:0,errorBudget:.05,certifiedFiniteFrame:modelId==='gemma3:12b'&&slice==='company',certificate:{upperRisk:.03,unsampled:{upperRisk:.15},sampled:63,population:82,upperWrong:3,scope:'Fixed dev frame only'}}]))}]))};
  const sourceReport={runId:'source',timestamp:'2026-10-28T09:56:45.385Z',cloudCalls:0,spendUsd:0,network:{externalRequests:0},testReplayLocked:true,calibration,policyHash:sha256(calibration),settings:{models:modelIds},costs:{tokenizerMetadata:{gemini:{method:'provider_selected_local_tokenizer'},'muse-spark':{method:'documented_local_proxy'}}}};
  const wire={system:'Short instructions.',query:'A redacted question.',context:[{chunkId:'source-one',text:'Safe synthetic company evidence.'}],draft:null},payloadHash=sha256(wire),payloads=[{payloadHash,payload:{wire,variant:'question-only',payloadHash}}],decisions=[],tokenRows=[];
  for(const [population,n]of [['frozen-saved60',60],['frozen-plain50',50],['dev-audit',83]])for(const modelId of modelIds)for(let i=0;i<n;i++){
    const accepted=modelId==='gemma3:12b'&&i===0,row=decision('id-'+i,{population,modelId,category:i===0?'company-data multi-doc':i===1?'reasoning':'knowledge',suite:i===0?'company-rag':i===1?'gpqa':'mmlu-pro',accepted,decision:{route:accepted?'local':'escalate'},arithmeticEligible:i===0});decisions.push(row);
    for(const cloudId of ['gemini','muse-spark'])tokenRows.push(count(row.id,{population,modelId,cloudId,accepted,handedOff:!accepted,payloadHash}));
  }
  return{sourceReport,decisions,tokenRows,payloads,pricing};
}
test('aggregate report preserves populations and model sizes, verifies no-draft wires, and never performs network calls',()=>{
  const data=fixture(),original=globalThis.fetch;globalThis.fetch=()=>{throw new Error('Network forbidden');};
  try{
    const report=buildStage4Report(data);assert.equal(report.rows.length,81);assert.equal(report.costs.length,162);assert.equal(report.workloadMix.length,18);assert.equal(report.cloudCalls,0);assert.equal(report.modelCalls,0);assert.equal(report.spendUsd,0);assert.equal(report.recommendation.automaticProductionActivation,false);
    const primary=report.rows.find(row=>row.population==='frozen-saved60'&&row.modelId==='gemma3:12b'&&row.sliceId==='company');assert.equal(primary.accepted,1);assert.equal(primary.items,1);
    const p=report.privacy.find(row=>row.population==='frozen-saved60'&&row.modelId==='llama3.1:8b');assert.equal(p.proposedPayloadsWithContext,1);assert.equal(p.draftPayloads,0);assert.equal(p.guardScreenedHandoffs,null);assert.equal(p.actualCompanyCloudCalls,0);assert.match(p.questionOnlyMeaning,/does not mean context-free/);
    const text=renderStage4Summary(report);assert.match(text,/Actual company queries reaching a cloud after Guard\/redaction: \*\*0/);assert.match(text,/nonadditive overlay/);assert.match(text,/quality per dollar are pending/);
    assert.doesNotMatch(JSON.stringify(report),/Safe synthetic company evidence|A redacted question/);
    assert.throws(()=>buildStage4Report({...data,decisions:[...data.decisions,data.decisions[0]]}),/Duplicate/);
    assert.throws(()=>buildStage4Report({...data,sourceReport:{...data.sourceReport,cloudCalls:1}}),/zero-cloud/);
    assert.throws(()=>buildStage4Report({...data,payloads:[{payloadHash:'wrong',payload:{wire:data.payloads[0].payload.wire,variant:'question-only',payloadHash:'wrong'}}]}),/hash mismatch/);
    const bad=structuredClone(data);bad.decisions[0].safe=false;assert.throws(()=>buildStage4Report(bad),/Unsafe|safety/);
  }finally{globalThis.fetch=original;}
});
test('committed Stage 4 headline exactly preserves source Stage 3 primary acceptance and projected fees',async()=>{
  const report=JSON.parse(await readFile(new URL('../results/2026-10-28-stage4-slice-report/report.json',import.meta.url),'utf8')),source=JSON.parse(await readFile(new URL('../results/2026-10-28-stage3-dev-risk-calibration/report.json',import.meta.url),'utf8'));
  assert.equal(report.sourcePolicyHash,source.policyHash);assert.equal(report.certification.futureCertified,false);assert.equal(report.cloudCalls,0);
  for(const row of report.rows.filter(row=>['company','overall'].includes(row.sliceId))){const old=source.acceptance.rows.find(old=>old.population===row.population&&old.modelId===row.modelId&&old.slice===row.sliceId);assert.equal(row.items,old.items);assert.equal(row.accepted,old.accepted);assert.deepEqual(row.acceptedAccuracyWilson95,old.acceptedAccuracyWilson95IidSensitivity);}
  for(const row of report.costs.filter(row=>['company','overall'].includes(row.sliceId))){const old=source.costs.summary.find(old=>old.population===row.population&&old.modelId===row.modelId&&old.slice===row.sliceId&&old.cloudId===row.cloudId);assert.ok(Math.abs(row.costPer1000-old.costPer1000AllQueriesUsd)<1e-12);assert.ok(Math.abs(row.cloudOnlyPer1000-old.cloudOnlyCostPer1000AllQueriesUsd)<1e-12);}
  const privacy=report.privacy.find(row=>row.population==='frozen-saved60'&&row.modelId==='gemma3:12b');assert.equal(privacy.businessDataQueries,24);assert.equal(privacy.documentCompanyQueries,16);assert.equal(privacy.adPrivacyQueries,8);assert.equal(privacy.fullyLocalBusinessDataQueries,13);assert.equal(privacy.proposedBusinessHandoffs,11);assert.equal(privacy.proposedBusinessPayloadsWithContext,3);assert.equal(privacy.proposedBusinessPayloadsWithoutContext,8);assert.equal(privacy.proposedBusinessChunks,5);assert.equal(privacy.actualBusinessCloudCalls,0);assert.equal(privacy.guardPassedCompanyHandoffs,null);
});
