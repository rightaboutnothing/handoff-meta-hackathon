import test from 'node:test';
import assert from 'node:assert/strict';
import {stage6bMetric,scanStage6bSeeds,summarizeStage6bSetup,summarizeStage6bLayers,summarizeCountryRecall,summarizeQualityRows,STAGE6B_SETUPS} from '../src/evaluation/stage6b-metrics.mjs';
import {installStage6bNetworkFence,installStage6bNoNetworkFence} from '../src/evaluation/stage6b-network.mjs';
import {replayPromptGuardDecision} from '../src/evaluation/stage6b-pg-replay.mjs';
import {readStage6bJournal} from '../src/evaluation/stage6b-io.mjs';
import {renderStage6bReport} from '../src/evaluation/stage6b-runner.mjs';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

const base=(id,area,extra={})=>({id,area,category:'synthetic-reference',sourceHash:'a'.repeat(64),candidateAvailable:true,piiLeak:false,hypotheticalBlocked:true,detectedBlock:false,pendingInjection:true,error:false,stages:[],...extra});
test('pending fail-closed protection is operational blocking but never detector success',()=>{
  const rows=[base('attack','attacks'),base('safe','safe')],report=summarizeStage6bSetup(STAGE6B_SETUPS[0],rows);
  assert.equal(report.metrics.find(row=>row.id==='attacks-operational').events,1);assert.equal(report.metrics.find(row=>row.id==='attacks-detected').events,0);
  assert.equal(report.metrics.find(row=>row.id==='safe-operational').events,1);assert.equal(report.metrics.find(row=>row.id==='safe-detected').events,0);assert.equal(report.injection.pendingBlocks,2);
});
test('the 0/50 gate requires fifty available nonempty candidates and no seed survivor',()=>{
  const rows=Array.from({length:50},(_,i)=>base('case-'+i,'pii'));
  assert.equal(summarizeStage6bSetup(STAGE6B_SETUPS[0],rows).gate.necessaryPrivacyGate,true);
  assert.equal(summarizeStage6bSetup(STAGE6B_SETUPS[0],rows.map((row,i)=>i?row:{...row,candidateAvailable:false})).gate.necessaryPrivacyGate,false);
  assert.equal(summarizeStage6bSetup(STAGE6B_SETUPS[0],rows.map((row,i)=>i?row:{...row,piiLeak:true})).gate.necessaryPrivacyGate,false);
  assert.equal(summarizeStage6bSetup(STAGE6B_SETUPS[0],rows).gate.liveReleaseAllowed,false);
});
test('seed checks inspect decoded variants independently without returning private values',()=>{
  const seeds=[{type:'NAME',value:'Fictional Example Person',country:'AU'}];
  const missed=scanStage6bSeeds('General question.',seeds,['Fictional Example Person']);assert.equal(missed.leak,true);assert.equal(missed.leakedValues,1);assert.equal(JSON.stringify(missed).includes(seeds[0].value),false);
  assert.equal(scanStage6bSeeds('General question.',seeds).leak,false);
});
test('per-country recall separates invalid checksums rather than inventing validated recall',()=>{
  const rows=[{error:false,seedChecks:[{country:'AU',detected:true,validatedDetection:false,checksumValid:false},{country:'JP',detected:true,validatedDetection:true,checksumValid:true}]}];
  const summary=summarizeCountryRecall(rows),au=summary.find(row=>row.country==='AU'),jp=summary.find(row=>row.country==='JP');
  assert.equal(au.recall.rate,1);assert.equal(au.recall.events,1);assert.equal(au.validatedRecall.n,0);assert.equal(au.validatedRecall.rate,null);assert.equal(au.invalidFormatRecall.events,1);assert.equal(jp.validatedRecall.events,1);
});
test('latency excludes cache replay and marks unavailable Prompt Guard inference pending',()=>{
  const report=summarizeStage6bLayers([{stages:[{layerId:'rewrite',status:'PASS',latencyMs:10},{layerId:'rewrite',status:'PASS',latencyMs:99,reused:true},{layerId:'prompt_guard_86m',status:'PENDING',latencyMs:2}]}]);
  const rewrite=report.find(row=>row.layerId==='rewrite'),guard=report.find(row=>row.layerId==='prompt_guard_86m');assert.equal(rewrite.medianMs,10);assert.equal(rewrite.n,1);assert.equal(rewrite.reused,1);assert.equal(guard.medianMs,null);assert.equal(guard.pending,1);assert.equal(guard.pendingAvailabilityMedianMs,2);
});
test('zero denominators remain pending and failure samples contain only category ID and hash',()=>{
  assert.equal(stage6bMetric('none','None','test',[],()=>true,'Pending').wilson95,null);
  const report=summarizeStage6bSetup(STAGE6B_SETUPS[0],[base('miss','attacks',{question:'Never publish this field',answer:'Never publish this either'})]);
  assert.deepEqual(Object.keys(report.failuresByArea.attacks[0]).sort(),['category','hash','id']);assert.equal(JSON.stringify(report).includes('Never publish'),false);
});
test('local surrogate quality cannot become a claim about actual cloud quality',()=>{
  const value=summarizeQualityRows([{status:'SURROGATE_COMPLETE',beforeScore:{factCoverage:1,score:1},afterScore:{factCoverage:.5,score:.5}},{status:'DEFERRED'}]);
  assert.equal(value.mode,'LOCAL_SURROGATE');assert.equal(value.n,2);assert.equal(value.completed,1);assert.equal(value.cloudQuality,'DEFERRED');assert.equal(value.afterFactCoverage,.5);
});
test('Markdown renderer preserves real newlines, country strata, paired denominators and pending boundaries',()=>{
  const countryRecall={
    'frozen-au':summarizeCountryRecall([{seedChecks:[{country:'AU',detected:true,checksumValid:false},{country:'AU',detected:true,checksumValid:true}]}],{population:'frozen-au'}),
    multicountry:summarizeCountryRecall([{seedChecks:[{country:'JP',detected:true,checksumValid:true},{country:'JP',detected:false,patternExpected:false,type:'NAME'}]}],{population:'multicountry'}),
  };
  const quality=summarizeQualityRows([
    {id:'quality-one',status:'SURROGATE_COMPLETE',beforeScore:{factCoverage:.5,score:.5},afterScore:{factCoverage:1,score:1},tokenRoundTripVerified:true,beforeStage:{layerId:'matched_baseline',latencyMs:12,status:'PASS'},afterStage:{layerId:'local_apply',latencyMs:20,status:'PASS'}},
    {id:'quality-two',status:'DEFERRED'},
  ]);
  const rows=[...Array.from({length:50},(_,i)=>base('pii-'+i,'pii')),base('attack','attacks'),base('safe','safe'),base('output','inbound')];
  const setup=summarizeStage6bSetup(STAGE6B_SETUPS[0],rows,{quality,countryRecall});
  const text=renderStage6bReport({setups:[setup],findings:['Synthetic reference finding.'],caveats:['Synthetic PII only.']});
  assert.ok(text.startsWith('# Stage 6b: send the question, never the data\n\n'));
  assert.equal(text.includes('\\n'),false);assert.ok(text.split('\n').length>80);
  assert.match(text,/Frozen Australian-format PII corpus/);assert.match(text,/Separate synthetic multi-country PII corpus/);
  assert.match(text,/\| JP \| 1 \| 1\/1/);assert.match(text,/2\/2 · 100\.0%/);assert.match(text,/0\/0 · pending/);
  assert.match(text,/1\/2 \(1 unavailable\)/);assert.match(text,/Full-credit answers, paired cases only \| 0\/1/);
  assert.match(text,/Mean fact coverage, paired cases only \(n=1\) \| 50\.0% \| 100\.0%/);
  assert.match(text,/AES source round trips verified/);assert.match(text,/matched_baseline \| 1 \| 12\.00/);assert.match(text,/local_apply \| 1 \| 20\.00/);
  assert.match(text,/Saved outputs blocked/);assert.match(text,/50\/50 \| 0 \| PASS \(sample only\) \| PENDING \| PENDING/);
  assert.match(text,/Pending blocks are not detection successes/);assert.match(text,/Production release/);assert.match(text,/DISABLED/);assert.match(text,/Actual cloud quality \|/);assert.match(text,/DEFERRED/);
});
test('the evaluation fence denies all clouds and unknown local models without dispatch',async t=>{
  let actual=0;t.mock.method(globalThis,'fetch',async()=>{actual++;return new Response('{}');});const fence=installStage6bNetworkFence();
  try{
    for(const url of ['https://api.meta.ai/v1/responses','https://generativelanguage.googleapis.com/','https://huggingface.co/'])await assert.rejects(fetch(url),{code:'STAGE6B_NETWORK_DENIED'});
    await assert.rejects(fetch('http://127.0.0.1:11434/api/chat',{method:'POST',body:JSON.stringify({model:'unregistered'})}),{code:'STAGE6B_LOCAL_PROTOCOL_DENIED'});
    await fetch('http://127.0.0.1:11434/api/version');assert.equal(actual,1);assert.equal(fence.status().blockedExternalRequests,3);
  }finally{fence.restore();}
});
test('Prompt Guard only replay cannot invoke Ollama or any other network',async t=>{
  let actual=0;t.mock.method(globalThis,'fetch',async()=>{actual++;return new Response('{}');});const fence=installStage6bNoNetworkFence();
  try{await assert.rejects(fetch('http://127.0.0.1:11434/api/chat'),{code:'STAGE6B_REPLAY_NETWORK_DENIED'});assert.equal(actual,0);}finally{fence.restore();}
});
test('Prompt Guard-only replay changes only injection decisions and preserves other safety blocks',()=>{
  const row=base('one','attacks',{blockedByLayer:['PROMPT_GUARD_PENDING','HARMFUL_CONTENT'],availableDetections:{privacy:false,harmful:true,injection:false},stages:[{layerId:'rewrite',status:'PASS',latencyMs:10}]});
  const result=replayPromptGuardDecision(row,{status:'PASS',detected:false,modelId:'local-test',latencyMs:3});assert.equal(result.hypotheticalBlocked,true);assert.equal(result.pendingInjection,false);assert.equal(result.detectedBlock,true);assert.deepEqual(result.blockedByLayer,['HARMFUL_CONTENT']);assert.equal(result.stages[0].reused,true);
  const clean=replayPromptGuardDecision({...row,blockedByLayer:['PROMPT_GUARD_PENDING'],availableDetections:{privacy:false,harmful:false,injection:false}},{status:'PASS',detected:false,latencyMs:2});assert.equal(clean.hypotheticalBlocked,false);assert.equal(clean.actualCloudCalls,0);
});
test('a crash-truncated progress journal preserves every complete record',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'stage6b-journal-'));
  try{const file=path.join(directory,'progress.jsonl');await writeFile(file,'{"id":"one"}\n{"id":');assert.deepEqual(await readStage6bJournal(file),[{id:'one'}]);assert.equal(await readFile(file,'utf8'),'{"id":"one"}\n');}
  finally{await rm(directory,{recursive:true,force:true});}
});
