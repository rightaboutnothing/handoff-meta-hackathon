import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile,symlink} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readPrivacyResults} from '../dashboard/server/privacy-results.mjs';
import {wilsonInterval} from '../src/comparison/metrics.mjs';

const hash=value=>createHash('sha256').update(value).digest('hex');
const metric=(events,n=10)=>({events,n,rate:n?events/n:null,wilson95:wilsonInterval(events,n),errors:0});
const id=stage=>`2026-10-29-stage${stage}-question-boundary-r9`;
const sourceFiles={'src/authored-fixture.mjs':'a'.repeat(64)};
function setup(setupId='meta-lens'){
  const productionCandidate=['meta-lens','google-lens'].includes(setupId),presidio=setupId==='presidio-baseline';
  return{id:setupId,label:'IGNORED_UNTRUSTED_LABEL',productionCandidate,metrics:[{id:'attacks-detected',...metric(8)},{id:'safe-operational',...metric(0)},{id:'safe-detected',...metric(0)}],privacy:{frozen:{attempted:10,usable:9,errors:0,seedSurvivorQueries:0,attemptedScan:metric(0)},multicountry:{attempted:8,usable:8,errors:0,seedSurvivorQueries:0,attemptedScan:metric(0,8)}},quality:presidio?{n:11,completed:0}:{n:7,completed:5,endToEndCompleted:5,applicationFullCreditAll:4},summary:{errors:0},falsePositiveAttribution:[],gate:{checks:{noPlantedSurvivors:true,frozenUsableTarget:true,multicountryUsableTarget:true,lowSafeFalseBlocking:true,primaryInjectionAvailable:productionCandidate,noExecutionErrors:true},stage7Allowed:productionCandidate}};
}
function report(stage='6d'){
  return{schemaVersion:1,kind:`stage${stage}-question-boundary-report`,runId:id(stage),timestamp:'2026-10-29T01:49:44.126Z',status:'COMPLETE_LOCAL_ONLY',tier:0,dryRun:true,cloudCalls:0,spendUsd:0,liveDispatchEnabled:false,settings:{seed:20261027,cloudCallsAllowed:false},boundarySettings:{cloudDispatchEnabled:false},network:{externalRequests:0},source:{hash:hash(JSON.stringify(sourceFiles)),gitCommit:'a'.repeat(40),files:sourceFiles},setups:['meta-lens','google-lens','google-native-only','presidio-baseline'].map(setup),promptGuardStandalone:['86m','22m'].map(variant=>({variant,threshold:.5,attempted:20,available:20,errors:0,safe:metric(0),latency:{n:20,medianMs:17,p95Ms:31},bySource:[{category:'jailbreak',attacks:metric(7)},{category:'prompt-injection',attacks:metric(2)}]}))};
}
async function fixture(t){const base=await mkdtemp(path.join(os.tmpdir(),'handoff-privacy-ui-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(base)),path.resolve(os.tmpdir()));assert.ok(path.basename(base).startsWith('handoff-privacy-ui-'));await rm(base,{recursive:true,force:true});});return base;}
async function publish(base,value,stage=value.kind.match(/^stage(6[bcdf])-/)[1]){await mkdir(path.join(base,value.runId),{recursive:true});const text=JSON.stringify(value);await writeFile(path.join(base,value.runId,'report.json'),text);await writeFile(path.join(base,`stage${stage}-latest.json`),JSON.stringify({schemaVersion:1,directory:value.runId,reportSha256:hash(text)}));}

test('privacy loader prefers the completed locked 6d result and derives Wilson intervals from exact counts',async t=>{
  const base=await fixture(t);await publish(base,report('6c'));const d=report();d.setups[0].privacy.frozen.usable=0;await publish(base,d);
  const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('NO_NETWORK');};try{const out=await readPrivacyResults({resultsDir:base});assert.equal(out.stage,'6d');assert.equal(out.runId,id('6d'));assert.equal(out.sourceHash,d.source.hash);assert.equal(out.seed,d.settings.seed);assert.equal(out.timestampAwst,'29 Oct 2026, 09:49:44 AWST (Perth)');assert.deepEqual(out.setups[0].usable.frozen,metric(0));assert.deepEqual(out.setups[0].applications.complete,metric(5,7));assert.deepEqual(out.setups[0].applications.fullCredit,metric(4,7));assert.equal(out.setups[3].applications.complete,null);assert.ok(out.notes.some(note=>note.includes('Meta lens has no usable frozen candidates')));assert.equal(out.cloudCalls,0);}finally{globalThis.fetch=original;}
});
test('privacy loader falls back to 6c only for absent or valid incomplete 6d, with fixed missing-stage records',async t=>{
  const base=await fixture(t);assert.equal(await readPrivacyResults({resultsDir:base}),null);await publish(base,report('6c'));let out=await readPrivacyResults({resultsDir:base});assert.equal(out.stage,'6c');assert.deepEqual(out.progress.map(row=>row.stage),['6b','6c','6d']);assert.equal(out.progress[2].runId,null);assert.deepEqual(out.progress[2].setups,[]);
  const pending=report();pending.status='RUNNING';await publish(base,pending);out=await readPrivacyResults({resultsDir:base});assert.equal(out.stage,'6c');assert.ok(out.gaps.some(gap=>gap.includes('Stage 6d')));
});
test('privacy loader never falls back past a tampered latest 6d hash',async t=>{
  const base=await fixture(t);await publish(base,report('6c'));const d=report();await publish(base,d);await writeFile(path.join(base,d.runId,'report.json'),'{}');await assert.rejects(readPrivacyResults({resultsDir:base}),/HASH_MISMATCH/);
});
test('privacy loader rejects nonoffline, mismatched run and invalid measurement-source identities',async t=>{
  const base=await fixture(t);for(const change of [{cloudCalls:1},{spendUsd:1},{tier:1},{dryRun:false},{liveDispatchEnabled:true},{network:{externalRequests:1}},{boundarySettings:{cloudDispatchEnabled:true}},{settings:{seed:20261027,cloudCallsAllowed:true}},{kind:'raw-private-items'},{source:{hash:'b'.repeat(64),gitCommit:'a'.repeat(40),files:sourceFiles}}]){await publish(base,{...report(),...change},'6d');await assert.rejects(readPrivacyResults({resultsDir:base}),/OFFLINE_IDENTITY|SOURCE_HASH/);}
  await publish(base,report());const raw=JSON.parse(await readFile(path.join(base,'stage6d-latest.json'),'utf8'));raw.directory='../private';await writeFile(path.join(base,'stage6d-latest.json'),JSON.stringify(raw));await assert.rejects(readPrivacyResults({resultsDir:base}),/INVALID_METADATA/);
});
test('privacy normalization rejects contradictory intervals, impossible counts and pass flags',async t=>{
  const base=await fixture(t);for(const alter of [s=>{s.metrics[0].events=99;},s=>{s.metrics[0].rate=.1;},s=>{s.metrics[0].wilson95=[0,1];},s=>{s.quality.applicationFullCreditAll=6;},s=>{s.gate.checks.noPlantedSurvivors=false;}]){const value=report();alter(value.setups[0]);await publish(base,value);await assert.rejects(readPrivacyResults({resultsDir:base}),/INVALID_METADATA|GATE_CONTRADICTION/);}
});
test('privacy public projection excludes report prose, per-item material, tokens and credential-like labels',async t=>{
  const base=await fixture(t),value=report();value.findings=['PRIVATE_FINDING'];value.notes=['PRIVATE_NOTE'];value.environment={key:'PRIVATE_ENV'};value.settings.surrogateModelId='PRIVATE_MODEL';value.payloads=[{prompt:'PRIVATE_PROMPT',content:'PRIVATE_CONTENT',output:'PRIVATE_OUTPUT'}];value.setups[0].label='sk-'+ 'x'.repeat(32);value.setups[0].quality.items=[{prompt:'PRIVATE_QUALITY'}];value.setups[0].quality.tokens={input:999};value.promptGuardStandalone[0].bySource[0].attacks.definition='PRIVATE_DEFINITION';await publish(base,value);const out=await readPrivacyResults({resultsDir:base}),text=JSON.stringify(out);assert.doesNotMatch(text,/PRIVATE_|sk-xxx|"tokens"|"prompt"|"content"|"output"/);assert.equal(out.setups[0].label,'Meta lens');
});
test('privacy progress preserves 6b operational pending-layer blocks separately from available-check detections',async t=>{
  const base=await fixture(t),b=report('6b');b.status='COMPLETE_WITH_PENDING_INJECTION';delete b.setups[0].privacy;b.setups[0].candidateCoverage={attempted:10,available:2,errors:0};b.setups[0].metrics=[{id:'candidate-pii',...metric(0)},{id:'safe-operational',...metric(10)},{id:'safe-detected',...metric(4)}];await publish(base,b);await publish(base,report());const out=await readPrivacyResults({resultsDir:base}),row=out.progress[0].setups[0];assert.equal(row.usableFrozen.events,2);assert.equal(row.usableMulticountry,null);assert.equal(row.safeOperational.events,10);assert.equal(row.safeDetected.events,4);assert.ok(out.gaps.some(gap=>gap.includes('separate multi-country')));
});
test('privacy attribution exposes exclusive first causes and overlapping flags without adding duplicate queries',async t=>{
  const base=await fixture(t),value=report(),s=value.setups[0];s.metrics[1]={id:'safe-operational',...metric(3)};s.falsePositiveAttribution=[{layerId:'tokenize',firstBlocks:1,reasons:['QUESTION_INTENT_LOST','LAYER_POLICY_BLOCK'],blocks:metric(2),cases:[{id:'a'},{id:'b'}]},{layerId:'question_validation',firstBlocks:0,reasons:['NOT_GENERAL_QUESTION'],blocks:metric(1),cases:[{id:'a'}]},{layerId:'prompt_guard_86m',firstBlocks:1,reasons:['PROMPT_GUARD_BLOCKED'],blocks:metric(1),cases:[{id:'c'}]},{layerId:'harmful_content',firstBlocks:1,reasons:['HARMFUL_CONTENT'],blocks:metric(2),cases:[{id:'b'},{id:'d'}]}];await publish(base,value);const out=await readPrivacyResults({resultsDir:base}),rows=out.setups[0].attribution;assert.equal(rows.find(row=>row.layerId==='tokenize_lost_intent').overlapping.events,2);assert.equal(rows.find(row=>row.layerId==='question_validation').firstBlocks,0);assert.equal(rows.find(row=>row.layerId==='harmful_content').overlapping.events,2);assert.equal(rows.reduce((sum,row)=>sum+row.firstBlocks,0),3);
});
test('privacy attribution deduplicates other layers by metadata identities and rejects missing first causes',async t=>{
  const base=await fixture(t),value=report(),s=value.setups[0];s.metrics[1]={id:'safe-operational',...metric(2)};s.falsePositiveAttribution=[{layerId:'llm_check',firstBlocks:1,reasons:['INVALID'],blocks:metric(2),cases:[{id:'a'},{id:'b'}]},{layerId:'decode',firstBlocks:1,reasons:['INVALID'],blocks:metric(1),cases:[{id:'b'}]}];await publish(base,value);let out=await readPrivacyResults({resultsDir:base});assert.equal(out.setups[0].attribution.find(row=>row.layerId==='other').overlapping.events,2);s.falsePositiveAttribution[1].firstBlocks=0;await publish(base,value);await assert.rejects(readPrivacyResults({resultsDir:base}),/ATTRIBUTION_MISMATCH/);
});
test('privacy detector panel uses per-source jailbreak/injection counts and keeps absent measurements pending',async t=>{
  const base=await fixture(t),value=report();value.promptGuardStandalone[1].bySource=[];await publish(base,value);const out=await readPrivacyResults({resultsDir:base});assert.equal(out.promptGuard[0].jailbreak.events,7);assert.equal(out.promptGuard[0].injection.events,2);assert.equal(out.promptGuard[0].latency.medianMs,17);assert.equal(out.promptGuard[1].injection,null);value.promptGuardStandalone.push(value.promptGuardStandalone[0]);await publish(base,value);await assert.rejects(readPrivacyResults({resultsDir:base}),/INVALID_METADATA/);
});
test('privacy loader rejects report-directory symlinks before reading contents',async t=>{
  const base=await fixture(t),outside=await fixture(t),value=report();await publish(outside,value);try{await symlink(path.join(outside,value.runId),path.join(base,value.runId),'junction');}catch(error){if(['EPERM','EACCES'].includes(error.code)){t.skip('Creating a junction is not permitted in this test environment');return;}throw error;}
  await writeFile(path.join(base,'stage6d-latest.json'),await readFile(path.join(outside,'stage6d-latest.json')));await assert.rejects(readPrivacyResults({resultsDir:base}),/UNSAFE_FILE/);
});
test('actual latest privacy projection verifies its run hash and never exposes retired or private per-item fields',async()=>{
  const out=await readPrivacyResults(),pointer=JSON.parse(await readFile(new URL(`../results/stage${out.stage}-latest.json`,import.meta.url),'utf8')),saved=JSON.parse(await readFile(new URL('../results/'+pointer.directory+'/report.json',import.meta.url),'utf8'));assert.equal(out.runId,pointer.directory);assert.equal(out.reportSha256,pointer.reportSha256);assert.equal(out.setups.length,saved.setups.length);assert.deepEqual(out.progress.map(row=>row.stage),out.stage==='6f'?['6b','6c','6d','6f']:['6b','6c','6d']);assert.equal(out.promptGuard.length,saved.promptGuardStandalone.length);for(const row of out.setups){const source=saved.setups.find(s=>s.id===row.id);assert.equal(row.usable.frozen.events,source.privacy.frozen.usable);assert.equal(row.safe.events,source.metrics.find(s=>s.id==='safe-operational').events);assert.equal(row.gate.status,(source.stage6fReadiness??source.stage6dReadiness).passed?'PASS':'FAIL');if(row.applications.complete)assert.equal(row.applications.complete.events,source.applicationTarget.completed);}assert.doesNotMatch(JSON.stringify(out),/"(?:items|records|messages|payloads|tokens|prompt|output|content|piiMap|findings)"|sk-[A-Za-z0-9_-]{24,}|hf_[A-Za-z0-9]{24,}/);
});

test('completed Stage 6f takes priority while preserving each historical series and its gate verdict',async t=>{
  const base=await fixture(t);for(const stage of ['6b','6c','6d'])await publish(base,report(stage));const latest=report('6f');latest.setups[0].stage6fReadiness={passed:false};latest.setups[0].repairTarget={applies:true,usable:9,attempted:10,target:10,passed:false};await publish(base,latest);const out=await readPrivacyResults({resultsDir:base});assert.equal(out.stage,'6f');assert.equal(out.runId,latest.runId);assert.deepEqual(out.progress.map(row=>row.stage),['6b','6c','6d','6f']);assert.equal(out.progress[2].runId,id('6d'));assert.equal(out.setups[0].gate.status,'FAIL');assert.ok(out.notes.some(note=>note.includes('9/10')&&note.includes('requested 10')));
});
test('an unfinished Stage 6f falls back to completed Stage 6d without fabricating a fourth point',async t=>{
  const base=await fixture(t);await publish(base,report());await publish(base,{...report('6f'),status:'RUNNING'});const out=await readPrivacyResults({resultsDir:base});assert.equal(out.stage,'6d');assert.equal(out.progress.length,3);assert.ok(out.gaps.some(gap=>gap.includes('Stage 6f')));
});
test('a tampered Stage 6f cannot silently present an older successful run',async t=>{
  const base=await fixture(t);await publish(base,report());const latest=report('6f');await publish(base,latest);await writeFile(path.join(base,latest.runId,'report.json'),'{}');await assert.rejects(readPrivacyResults({resultsDir:base}),/HASH_MISMATCH/);
});
test('repair-target notes accept only consistent numeric aggregates, never report prose',async t=>{
  const base=await fixture(t),latest=report('6f');latest.setups[0].repairTarget={applies:true,usable:9,attempted:10,target:'PRIVATE_GOAL_DO_NOT_PUBLISH',passed:false};await publish(base,latest);await assert.rejects(readPrivacyResults({resultsDir:base}),/INVALID_METADATA/);latest.setups[0].repairTarget={applies:true,usable:9,attempted:10,target:8,passed:false};await publish(base,latest);await assert.rejects(readPrivacyResults({resultsDir:base}),/INVALID_METADATA/);
});
