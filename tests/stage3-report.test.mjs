import test from'node:test';
import assert from'node:assert/strict';
import{summarizeStage3Acceptance,renderStage3Summary}from'../src/comparison/stage3-report.mjs';

const row=(id,overrides={})=>({id,groupId:id,modelId:'llama3.1:8b',population:'dev-audit',role:'audit',category:'company-data multi-doc',slice:'company',safe:true,accepted:true,gate:{eligible:true},scoring:{score:1,labelAvailable:true},...overrides});
const summarize=(rows,options={})=>summarizeStage3Acceptance(rows,{seed:7,replicates:40,...options});
test('zero-error bootstrap is presented alongside a wider explicitly IID sensitivity interval',()=>{
  const acceptance=summarize([row('a'),row('b')]),report={runId:'unit',tier:0,cloudCalls:0,spendUsd:0,network:{externalRequests:0},settings:{errorBudget:.05},acceptance,costs:{summary:[]}};
  const text=renderStage3Summary(report);assert.match(text,/Wilson 95% IID sensitivity/);assert.match(text,/descriptive bootstrap 95%/);assert.match(text,/100\.0% \[100\.0%, 100\.0%\]/);assert.match(text,/\[34\.2%, 100\.0%\]/);
});
test('unknown accepted answers are conservative errors, supported-only sensitivity is separate',()=>{
  const result=summarize([row('a'),row('b',{scoring:{score:.5,labelAvailable:true}}),row('c',{scoring:{score:null,labelAvailable:false}}),row('d',{accepted:false})]),r=result.rows.find(r=>r.slice==='company');
  assert.equal(r.accepted,3);assert.equal(r.acceptedCorrect,1);assert.equal(r.acceptedKnownWrong,1);assert.equal(r.acceptedUnknown,1);assert.equal(r.acceptedConservativeWrong,2);assert.equal(r.acceptedAnswerAccuracy,1/3);assert.equal(r.acceptedAccuracySupportedOnly.estimate,.5);
  assert.equal(r.projectedCloudCallsSkipped,3);assert.equal(r.projectedCloudCalls,1);assert.equal(r.projectedCloudCallsSkippedPer1000.estimate,750);assert.equal(r.acceptanceRateAllQueries.estimate,.75);assert.ok(r.acceptedAccuracy.ci95);assert.ok(r.acceptedAccuracyWilson95IidSensitivity);assert.equal(result.riskCertificateComputedHere,false);
});
test('full-credit reporting uses the same strict score-one rule as risk calibration',()=>{
  const result=summarize([row('a'),row('b',{scoring:{score:1-1e-10,labelAvailable:true}})]).rows[0];
  assert.equal(result.acceptedCorrect,1);assert.equal(result.acceptedKnownWrong,1);assert.equal(result.acceptedAnswerAccuracy,.5);
});
test('model sizes, company/general slices and frozen populations are never pooled',()=>{
  const result=summarize([row('a'),row('b',{category:'reasoning',slice:'general',accepted:false}),row('a',{modelId:'gemma3:12b',accepted:false}),row('a',{population:'frozen-saved60'}),row('a',{population:'frozen-plain50',accepted:false})]);
  const find=(model,slice,pop)=>result.rows.find(r=>r.modelId===model&&r.slice===slice&&r.population===pop);
  assert.equal(find('llama3.1:8b','overall','dev-audit').items,2);assert.equal(find('gemma3:12b','overall','dev-audit').items,1);assert.equal(find('llama3.1:8b','company','frozen-saved60').accepted,1);assert.equal(find('llama3.1:8b','company','frozen-plain50').accepted,0);
});
test('adversarial local-only outcomes do not inflate safe acceptance or skipped-cloud calls',()=>{
  const r=summarize([row('a'),row('unsafe',{safe:false,accepted:true,scoring:{score:1,labelAvailable:true}})]).rows.find(r=>r.slice==='overall');
  assert.equal(r.accepted,1);assert.equal(r.adversarialLocalOnlyItems,1);assert.equal(r.unsafeMarkedAccepted,1);assert.equal(r.acceptanceRateAllQueries.estimate,.5);assert.equal(r.acceptanceRateSafeQueries.estimate,1);assert.equal(r.projectedCloudCallsSkipped,1);
});
test('zero acceptance and one source group cannot manufacture confidence or a risk certificate',()=>{
  const zero=summarize([row('a',{accepted:false}),row('b',{accepted:false})]).rows[0];assert.equal(zero.acceptedAccuracy.estimate,null);assert.equal(zero.acceptedAccuracyWilson95IidSensitivity,null);
  const clustered=summarize([row('a',{groupId:'one'}),row('b',{groupId:'one'})]).rows[0];assert.equal(clustered.acceptedAnswerAccuracy,1);assert.equal(clustered.acceptedAccuracy.ci95,null);assert.match(clustered.uncertaintyScope,/not the calibration risk certificate/);
});
test('duplicate identities, dev-role overlap and accepted hard-gate failures are rejected',()=>{
  assert.throws(()=>summarize([row('a'),row('a')]),/Duplicate/);assert.throws(()=>summarize([row('a'),row('a',{population:'dev-fit',role:'fit'})]),/Dev roles/);
  assert.throws(()=>summarize([row('a',{gate:{eligible:false,reason:'truncated'}})]),/failed hard gate/);assert.throws(()=>summarize([row('a',{slice:'general'})]),/slice/);
});
test('previous frozen-policy acceptance is descriptive and dev role coverage is explicit',()=>{
  const result=summarize([row('a',{population:'dev-fit',role:'fit',beforeAccepted:false}),row('b',{beforeAccepted:false}),row('c',{accepted:false,beforeAccepted:true})]),r=result.rows.find(r=>r.population==='dev-audit'&&r.slice==='company');
  assert.equal(result.devCoverage[0].items,3);assert.deepEqual(result.devCoverage[0].roles,{fit:1,audit:2});assert.equal(r.before.accepted,1);assert.equal(r.before.acceptanceRateAllQueries.estimate,.5);assert.equal(r.before.acceptanceRateChange.estimate,0);
});
test('renderer separates finite-frame bounds from descriptive test accuracy and refuses unlocked replay or spend',()=>{
  const acceptance=summarize([row('a'),row('b',{population:'frozen-saved60'})]),calibration={models:{'llama3.1:8b':{slices:{company:{candidateThreshold:.2,threshold:.2,errorBudget:.05,status:'CERTIFIED_FINITE_DEV_FRAME',certificate:{sampled:100,population:200,wrong:0,upperRisk:.04,scope:'Fixed CALIB+AUDIT dev frame only'}}}}}},report={runId:'unit',tier:0,cloudCalls:0,spendUsd:0,network:{externalRequests:0},settings:{seed:20261027,errorBudget:.05},policyHash:'locked-policy',testReplayLocked:true,acceptance,calibration,costs:{summary:[]}};
  const text=renderStage3Summary(report);assert.match(text,/fixed finite dev frame/);assert.match(text,/No future 5% error guarantee/);assert.match(text,/Frozen CALIB|Fixed CALIB/);assert.match(text,/5\.0%/);assert.match(text,/frozen-saved60/);assert.match(text,/STOP before Stage 4/);assert.match(text,/unknown or unsupported accepted labels conservatively/);
  assert.throws(()=>renderStage3Summary({...report,testReplayLocked:false}),/locked policy/);assert.throws(()=>renderStage3Summary({...report,policyHash:''}),/locked policy/);
  assert.throws(()=>renderStage3Summary({...report,cloudCalls:1}),/zero cloud/);assert.throws(()=>renderStage3Summary({...report,spendUsd:.01}),/zero cloud/);assert.throws(()=>renderStage3Summary({...report,network:{externalRequests:1}}),/zero cloud/);
});
