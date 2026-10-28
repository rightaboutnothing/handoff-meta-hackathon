import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {STAGE6D_SETUPS,summarizeStage6dSetup,summarizeStage6dErrorAttempts,compareStage6dSafeRules,renderStage6dReport} from '../src/evaluation/stage6d-metrics.mjs';
import {publicStage6dLayer,publicStage6dApplication,unresolvedStage6dError,stage6dQualityGate,stableStage6dMetadata,assertStage6dLockedSettings} from '../src/evaluation/stage6d-runner.mjs';
import {stage6dPrivateRoot,loadStage6dInputs,loadPreviousStage6dReport} from '../src/evaluation/stage6d-io.mjs';
import {sha256} from '../src/rag/receipts.mjs';

const criteria={maxObservedSafeFalseBlockRate:.05,minFrozenUsableQuestions:30,minMulticountryUsableQuestions:36,maxSeedSurvivorQueries:0,requirePrimaryInjectionAvailable:true,requireNoExecutionErrors:true},target={setupId:'meta-lens',minCompleted:8,totalItems:11};
const row=(id,area,extra={})=>({id,area,population:'frozen',category:'synthetic-category',country:'AU',sourceHash:'a'.repeat(64),candidateAvailable:true,piiLeak:false,hypotheticalBlocked:false,detectedBlock:false,error:false,pendingInjection:false,availableDetections:{privacy:false,intent:false,injection:false,harmful:false},layerBlocks:[],stages:[{layerId:'prompt_guard_86m',status:'PASS',available:true,latencyMs:2}],...extra});
const frame=()=>[...Array.from({length:50},(_,i)=>row('pii-'+i,'pii')),...Array.from({length:60},(_,i)=>row('multi-'+i,'pii',{population:'multicountry'})),...Array.from({length:74},(_,i)=>row('safe-'+i,'safe'))];
const quality=(completed=8)=>Array.from({length:11},(_,i)=>({id:'quality-'+i,status:i<completed?'SURROGATE_COMPLETE':'OUTBOUND_BLOCKED',applicationCompleted:i<completed,outboundWouldRelease:i<completed,inboundWouldPass:i<completed,completionKnown:i<completed,beforeScore:{score:.5,factCoverage:.5},afterScore:i<completed?{score:.25,factCoverage:.25}:null,tokenRoundTripVerified:i<completed,afterStage:i<completed?{layerId:'local_apply',status:'PASS',latencyMs:5,tokens:{input:0,output:0,total:0},localTool:'synthetic-calculator'}:null,application:i<completed?{method:'local_calculator',localTool:'synthetic-calculator',completionKnown:true,attempts:[]}:null}));

test('Stage6d preserves the exact locked criteria and adds a separate completion-only Meta target',async()=>{
  const old=JSON.parse(await readFile('config/stage6c-evaluation.json','utf8')),current=JSON.parse(await readFile('config/stage6d-evaluation.json','utf8'));
  assert.deepEqual(current.stage7Criteria,old.stage7Criteria);assert.equal(current.applicationTarget.minCompleted,8);assert.equal(current.qualityMaxTokens,1024);
  const result=summarizeStage6dSetup(STAGE6D_SETUPS[0],frame(),{criteria,applicationTarget:target,qualityRows:quality(8)});
  assert.equal(result.gate.sampleCriteriaPassed,true);assert.equal(result.applicationTarget.passed,true);assert.equal(result.applicationTarget.fullCreditAnswers,0);assert.equal(result.stage6dReadiness.passed,true);assert.equal(result.gate.liveDispatchEnabled,false);
});
test('preflight and run refuse changes to primary PG, threshold, seed, model IDs or original gate',async()=>{
  const settings=JSON.parse(await readFile('config/stage6d-evaluation.json','utf8')),boundary=JSON.parse(await readFile('config/stage6b.json','utf8'));assert.equal(assertStage6dLockedSettings(settings,boundary),true);
  assert.throws(()=>assertStage6dLockedSettings(settings,{...boundary,promptGuard:{...boundary.promptGuard,primaryVariant:'22m'}}),/PROMPT_GUARD_CHANGED/);assert.throws(()=>assertStage6dLockedSettings(settings,{...boundary,promptGuard:{...boundary.promptGuard,threshold:.6}}),/PROMPT_GUARD_CHANGED/);assert.throws(()=>assertStage6dLockedSettings({...settings,seed:1},boundary),/EXECUTION_SETTINGS_CHANGED/);assert.throws(()=>assertStage6dLockedSettings({...settings,stage7Criteria:{...settings.stage7Criteria,maxObservedSafeFalseBlockRate:.5}},boundary),/GATE_CHANGED/);assert.throws(()=>assertStage6dLockedSettings(settings,{...boundary,meta:{...boundary.meta,guardModel:'other'}}),/MODEL_IDS_CHANGED/);
});
test('seven completions fail the new target without changing the old safety/privacy gate',()=>{
  const result=summarizeStage6dSetup(STAGE6D_SETUPS[0],frame(),{criteria,applicationTarget:target,qualityRows:quality(7)});
  assert.equal(result.gate.sampleCriteriaPassed,true);assert.equal(result.applicationTarget.passed,false);assert.equal(result.stage6dReadiness.passed,false);assert.equal(result.gate.stage7Allowed,false);
});
test('completed application can count independently of unavailable matched baseline',()=>{
  const items=quality(8);items[0]={...items[0],status:'APPLICATION_COMPLETE_BASELINE_UNAVAILABLE',beforeScore:null,applicationCompleted:true};
  const result=summarizeStage6dSetup(STAGE6D_SETUPS[0],frame(),{criteria,applicationTarget:target,qualityRows:items});assert.equal(result.applicationTarget.completed,8);assert.equal(result.quality.completed,7);assert.equal(result.quality.perItemScores[0].scoreBefore,null);assert.equal(result.quality.perItemScores[0].scoreAfter,.25);
});
test('unknown completion and a missing outbound pass cannot count as valid applications',()=>{
  const items=quality(8);items[0]={...items[0],completionKnown:false};items[1]={...items[1],outboundWouldRelease:false};const result=summarizeStage6dSetup(STAGE6D_SETUPS[0],frame(),{criteria,applicationTarget:target,qualityRows:items});assert.equal(result.applicationTarget.completed,6);assert.equal(result.applicationTarget.passed,false);
});
test('Google retains its original production gate while the extra Meta target is not applicable',()=>{
  const result=summarizeStage6dSetup(STAGE6D_SETUPS[1],frame(),{criteria,applicationTarget:target,qualityRows:quality(0)});assert.equal(result.applicationTarget.appliesToThisSetup,false);assert.equal(result.stage6dReadiness.applicationTargetPassed,null);assert.equal(result.gate.stage7Allowed,true);
  const control=summarizeStage6dSetup(STAGE6D_SETUPS[3],frame(),{criteria,applicationTarget:target,qualityRows:quality(11)});assert.equal(control.gate.stage7Allowed,false);
});
test('recovered malformed attempts remain counted with codes and tokens but are not unresolved errors',()=>{
  const attempts=[{attempt:1,status:'ERROR',code:'PRIVACY_LOCAL_INVALID_SPAN',recovered:true,latencyMs:10,tokens:{input:3,output:2,total:5}},{attempt:2,status:'PASS',recovered:false,latencyMs:12,tokens:{input:3,output:2,total:5}}],rows=[row('recovered','safe',{stages:[{layerId:'llm_check',status:'PASS',recovered:true,attempts}]})],summary=summarizeStage6dErrorAttempts(rows);
  assert.equal(summary.operationsWithInitialError,1);assert.equal(summary.totalErrorAttempts,1);assert.equal(summary.recoveredErrorAttempts,1);assert.equal(summary.unresolvedOperations,0);assert.equal(summary.attempts[0].tokens.total,5);
});
test('ordinary privacy or Guard policy blocks are not relabelled as execution errors',()=>{
  const summary=summarizeStage6dErrorAttempts([row('policy','safe',{hypotheticalBlocked:true,stages:[{layerId:'harmful_content',status:'BLOCKED',attempts:[{attempt:1,status:'BLOCKED',code:'HARMFUL_CONTENT',valid:false}]}]})]);assert.equal(summary.totalErrorAttempts,0);assert.equal(summary.unresolvedOperations,0);
});
test('unresolved attempts remain visible and fail the unchanged final-error criterion',()=>{
  const rows=frame();rows[0]={...rows[0],error:true,stages:[{layerId:'rewrite',status:'ERROR',attempts:[{attempt:1,status:'ERROR',code:'PRIVACY_LOCAL_TRUNCATED',recovered:false}]}]};const result=summarizeStage6dSetup(STAGE6D_SETUPS[0],rows,{criteria,applicationTarget:target,qualityRows:quality(11)});assert.equal(result.errorAttempts.unresolvedOperations,1);assert.equal(result.errorAttempts.unresolvedErrorAttempts,1);assert.equal(result.gate.checks.noExecutionErrors,false);assert.equal(result.stage6dReadiness.passed,false);
});
test('application error attempts are counted once, not duplicated from application metadata',()=>{
  const attempts=[{attempt:1,status:'ERROR',code:'LOCAL_APPLICATION_CITATION_INVALID',recovered:true},{attempt:2,status:'PASS'}],items=quality(8);items[0]={...items[0],application:{method:'model_answer',attempts},afterStage:{layerId:'local_apply',status:'PASS',attempts,recovered:true,latencyMs:7}};
  const result=summarizeStage6dSetup(STAGE6D_SETUPS[0],frame(),{criteria,applicationTarget:target,qualityRows:items});assert.equal(result.quality.errorAttempts.totalErrorAttempts,1);assert.equal(result.quality.errorAttempts.recoveredErrorAttempts,1);
});
test('a recovered top-level failure requires a later validated PASS from the same layer',()=>{
  const first={layerId:'rewrite',status:'ERROR',recovered:true};assert.equal(unresolvedStage6dError(first,0,[first]),true);assert.equal(unresolvedStage6dError(first,0,[first,{layerId:'rewrite',status:'PASS'}]),false);assert.equal(unresolvedStage6dError(first,0,[first,{layerId:'other',status:'PASS'}]),true);
});
test('per-ID before attribution uses detailed authored subrules instead of inventing explanations',()=>{
  const before={safeRules:[{id:'safe-0',blocked:true,layerBlocks:[{layerId:'tokenize',code:'QUESTION_INTENT_LOST'}],diagnosis:{firstBlockingLayer:'tokenize',subrules:[{code:'CONDITIONAL_EXPLANATION_WRAPPER',why:'The outer explanation wrapper was mistaken for an additional task action.',missingActions:['explain'],missingConstraints:[]}]}}]},comparisons=compareStage6dSafeRules([row('safe-0','safe')],before);
  assert.equal(comparisons[0].change,'CLEARED_PREVIOUS_BLOCK');assert.equal(comparisons[0].beforeDiagnosis.subrules[0].code,'CONDITIONAL_EXPLANATION_WRAPPER');assert.match(comparisons[0].beforeWhy[0],/outer explanation wrapper/);assert.equal(JSON.stringify(comparisons).includes('prompt'),false);
});
test('stage and application projection strips private raw data while retaining tool and attempt provenance',()=>{
  const stage=publicStage6dLayer({layerId:'local_apply',status:'PASS',text:'Private sentinel',attempts:[{attempt:1,status:'ERROR',code:'LOCAL_APPLICATION_CITATION_INVALID',raw:'Private sentinel',tokens:{total:4}}],localTool:'local-calculator'}),application=publicStage6dApplication({method:'local_calculator',sourceRecordHash:'b'.repeat(64),raw:'Private sentinel',calculator:{status:'supported',toolId:'local',traceHash:'c'.repeat(64),sourceChunkIds:['synthetic-id'],operands:'Private sentinel'}});
  assert.equal(JSON.stringify(stage).includes('Private sentinel'),false);assert.equal(JSON.stringify(application).includes('Private sentinel'),false);assert.equal(stage.localTool,'local-calculator');assert.equal(application.calculator.toolId,'local');
});
test('quality path still requires composed outbound and inbound passes and a genuine permit',()=>{
  const checked={availableChecksPassed:true,checkPermit:{},stages:[{layerId:'prompt_guard_86m',status:'PASS',available:true}]},outbound={hypotheticalBlocked:false,error:false,candidateAvailable:true};assert.equal(stage6dQualityGate('meta-lens',outbound,checked).mayApply,true);assert.equal(stage6dQualityGate('meta-lens',{...outbound,hypotheticalBlocked:true},checked).mayApply,false);assert.equal(stage6dQualityGate('meta-lens',outbound,{...checked,checkPermit:null}).mayApply,false);
});
test('new source/cache roots cannot overwrite old run directories or use generated model-load times as identity',()=>{
  assert.match(stage6dPrivateRoot(),/stage6d$/);assert.equal(sha256(stableStage6dMetadata({asset:'a',loadMs:1})),sha256(stableStage6dMetadata({asset:'a',loadMs:99})));
});
test('Stage6d rendering has correctly aligned readiness columns, all safe IDs and item scores',()=>{
  const setup=summarizeStage6dSetup(STAGE6D_SETUPS[0],frame(),{criteria,applicationTarget:target,qualityRows:quality(8)}),report={runId:'synthetic-stage6d',source:{gitCommit:'d'.repeat(40)},settings:{seed:20261027},setups:[setup],promptGuardStandalone:[],findings:[],caveats:[],stage7Allowed:true},text=renderStage6dReport(report);
  assert.match(text,/Meta Stage 7 sample readiness PASS/);assert.match(text,/safe-73/);assert.match(text,/quality-10/);assert.match(text,/0\.25/);assert.match(text,/local-calculator|Local application/);assert.match(text,/Recovered errors are retained/);assert.equal(text.split('\n').some(line=>/[ \t]+$/.test(line)),false);
  const header=text.split('\n').find(line=>line.startsWith('| Setup | Locked')),separator=text.split('\n')[text.split('\n').indexOf(header)+1];assert.equal(header.split('|').length,separator.split('|').length);
});
test('locked input identities and pinned previous report remain readable without inference',async()=>{
  const settings=JSON.parse(await readFile('config/stage6d-evaluation.json','utf8'));assert.equal(settings.previousStage6cRun.reportSha256,'4c71bbe6c9087549623f8a9861ca5d7ef88233d7701855140d284f33d7c7cf71');
  await assert.rejects(loadPreviousStage6dReport(process.cwd(),{directory:'../escape',reportSha256:'a'.repeat(64)}),/INVALID/);
});
