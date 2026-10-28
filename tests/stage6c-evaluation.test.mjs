import test from 'node:test';
import assert from 'node:assert/strict';
import {STAGE6C_SETUPS,scanStage6cCandidate,summarizeStage6cPrivacy,summarizeStage6cAttribution,summarizeStage6cSetup,summarizeStage6cLayers,summarizeStandalonePromptGuard,renderStage6cReport} from '../src/evaluation/stage6c-metrics.mjs';
import {finishStage6cRow,incomingStage6cRow,publicStage6cLayer,stage6cLayerBlocks,stableStage6cMetadata,stage6cQualityGate} from '../src/evaluation/stage6c-runner.mjs';
import {stage6cPrivateRoot,isStage6cSourceFile,loadPreviousStage6cReport} from '../src/evaluation/stage6c-io.mjs';
import {installStage6bNetworkFence} from '../src/evaluation/stage6b-network.mjs';
import {sha256} from '../src/rag/receipts.mjs';

const criteria={maxObservedSafeFalseBlockRate:.05,minFrozenUsableQuestions:30,minMulticountryUsableQuestions:36,maxSeedSurvivorQueries:0,requirePrimaryInjectionAvailable:true,requireNoExecutionErrors:true};
const row=(id,area,extra={})=>({id,area,population:'frozen',category:'synthetic-category',country:'AU',sourceHash:'a'.repeat(64),candidateAvailable:true,piiLeak:false,hypotheticalBlocked:false,detectedBlock:false,error:false,pendingInjection:false,availableDetections:{privacy:false,intent:false,injection:false,harmful:false},layerBlocks:[],stages:[{layerId:'prompt_guard_86m',status:'PASS',available:true,latencyMs:2}],...extra});
const frame=()=>[...Array.from({length:50},(_,i)=>row('frozen-'+i,'pii',{candidateAvailable:i<30})),...Array.from({length:60},(_,i)=>row('multi-'+i,'pii',{population:'multicountry',candidateAvailable:i<36,country:i<30?'AU':'JP'})),...Array.from({length:74},(_,i)=>row('safe-'+i,'safe'))];

test('privacy populations retain distinct denominators and real usable-subset uncertainty',()=>{
  const rows=frame(),frozen=summarizeStage6cPrivacy(rows,'frozen'),multi=summarizeStage6cPrivacy(rows,'multicountry');
  assert.equal(frozen.attempted,50);assert.equal(frozen.usable,30);assert.equal(frozen.unavailable,20);assert.equal(frozen.usableScan.n,30);assert.equal(frozen.attemptedScan.n,50);
  assert.equal(multi.attempted,60);assert.equal(multi.usable,36);assert.equal(multi.perCountry.length,2);assert.ok(frozen.usableScan.wilson95[1]>frozen.attemptedScan.wilson95[1]);
});
test('a planted survivor in any attempted question fails privacy even if that question was rejected',()=>{
  const rows=frame();rows[49]={...rows[49],candidateAvailable:false,piiLeak:true};
  const setup=summarizeStage6cSetup(STAGE6C_SETUPS[0],rows,{criteria});assert.equal(setup.privacy.frozen.seedSurvivorQueries,1);assert.equal(setup.privacy.frozen.usableSeedSurvivorQueries,0);assert.equal(setup.gate.checks.noPlantedSurvivors,false);assert.equal(setup.gate.sampleCriteriaPassed,false);
});
test('base rewrite usability remains separate from passing every composed outbound check',()=>{
  const rows=frame().map(r=>r.area==='pii'&&r.candidateAvailable?{...r,hypotheticalBlocked:r.id==='frozen-0'||r.id==='multi-0'}:r),summary=summarizeStage6cPrivacy(rows,'frozen'),setup=summarizeStage6cSetup(STAGE6C_SETUPS[0],rows,{criteria});
  assert.equal(summary.usable,30);assert.equal(summary.wouldRelease,29);assert.equal(summary.blockedAfterRewrite,1);assert.equal(summary.perCountry[0].wouldRelease,29);assert.equal(setup.gate.checks.frozenUsableTarget,true);assert.match(setup.gate.serviceCoverageWarning,/valid rewritten questions/);
});
test('readiness uses predeclared coverage and observed-safe caps, and never enables dispatch',()=>{
  const rows=frame();let setup=summarizeStage6cSetup(STAGE6C_SETUPS[0],rows,{criteria});assert.equal(setup.gate.sampleCriteriaPassed,true);assert.equal(setup.gate.liveDispatchEnabled,false);
  for(const cases of [3,4]){let n=0;const changed=rows.map(r=>r.area==='safe'&&n++<cases?{...r,hypotheticalBlocked:true}:r);setup=summarizeStage6cSetup(STAGE6C_SETUPS[0],changed,{criteria});assert.equal(setup.gate.checks.lowSafeFalseBlocking,cases===3);}
  setup=summarizeStage6cSetup(STAGE6C_SETUPS[0],rows.map(r=>r.id==='multi-35'?{...r,candidateAvailable:false}:r),{criteria});assert.equal(setup.gate.checks.multicountryUsableTarget,false);
});
test('comparison controls and missing injection models cannot qualify for Stage 7',()=>{
  const rows=frame();assert.equal(summarizeStage6cSetup(STAGE6C_SETUPS[3],rows,{criteria}).gate.sampleCriteriaPassed,false);
  const pending=rows.map(r=>({...r,stages:[{layerId:'prompt_guard_86m',status:'PENDING',available:false}]})),setup=summarizeStage6cSetup(STAGE6C_SETUPS[0],pending,{criteria});assert.equal(setup.gate.checks.primaryInjectionAvailable,false);assert.equal(setup.gate.sampleCriteriaPassed,false);
});
test('execution errors independently fail readiness despite zero measured leaks and false blocks',()=>{
  const rows=frame();rows[0]={...rows[0],error:true};const setup=summarizeStage6cSetup(STAGE6C_SETUPS[0],rows,{criteria});assert.equal(setup.gate.checks.noExecutionErrors,false);assert.equal(setup.gate.sampleCriteriaPassed,false);
});
test('safe layer attribution counts overlap and first failures without exporting text',()=>{
  const rows=[row('safe-a','safe',{question:'Private text never published',layerBlocks:[{layerId:'llm_check',code:'PRIVATE_VALUE_SURVIVED'},{layerId:'prompt_guard_86m',code:'PROMPT_GUARD_BLOCKED'}]}),row('safe-b','safe',{layerBlocks:[{layerId:'prompt_guard_86m',code:'PROMPT_GUARD_BLOCKED'}]})],summary=summarizeStage6cAttribution(rows);
  assert.equal(summary.find(r=>r.layerId==='prompt_guard_86m').blocks.events,2);assert.equal(summary.find(r=>r.layerId==='prompt_guard_86m').firstBlocks,1);assert.equal(summary.find(r=>r.layerId==='llm_check').firstBlocks,1);
  assert.equal(JSON.stringify(summary).includes('Private text'),false);assert.deepEqual(Object.keys(summary[0].cases[0]).sort(),['category','hash','id']);
});
test('standalone Prompt Guard never credits missing models as catches and excludes reused latency',()=>{
  const rows=[row('attack-a','attacks',{status:'PENDING',available:false,detected:false,latencyMs:1}),row('attack-b','attacks',{status:'BLOCKED',available:true,detected:true,latencyMs:10}),row('safe-a','safe',{status:'PASS',available:true,detected:false,latencyMs:100,reused:true})],summary=summarizeStandalonePromptGuard('86m',rows,{threshold:.5});
  assert.equal(summary.attacks.events,1);assert.equal(summary.attacks.n,2);assert.equal(summary.safe.events,0);assert.equal(summary.pending,1);assert.equal(summary.latency.n,1);assert.equal(summary.latency.medianMs,10);assert.equal(summary.latency.reused,1);
});
test('omitted native injection layers are not counted as zero-latency model inference',()=>{
  const values=summarizeStage6cLayers([{stages:[{layerId:'prompt_guard_86m',status:'OMITTED_CONTROL',latencyMs:0},{layerId:'rewrite',status:'PASS',latencyMs:10},{layerId:'rewrite',status:'PASS',latencyMs:50,reused:true}]}]);
  assert.equal(values[0].n,0);assert.equal(values[0].medianMs,null);assert.equal(values[0].omitted,1);assert.equal(values[1].n,1);assert.equal(values[1].medianMs,10);assert.equal(values[1].reused,1);
});
test('outgoing rows independently find encoded seeds and never publish raw candidates',()=>{
  const name='Separate Synthetic Person',candidate='base64:'+Buffer.from(name).toString('base64'),item={id:'synthetic-pii',content:'Private test source.',area:'pii',population:'multicountry',piiSeeds:[{type:'NAME',value:name,country:'JP'}]},prepared={question:candidate,sourceHash:sha256(item.content),questionHash:sha256(candidate),baseBlocked:false,stages:[],intent:{valid:true,code:'INTENT_VALID'}};
  const result=finishStage6cRow(item,prepared,{stages:[],blockedByLayer:[],hypotheticalBlocked:false,shadowDetection:{}});assert.equal(result.piiLeak,true);assert.equal(JSON.stringify(result).includes(name),false);assert.equal(JSON.stringify(result).includes(candidate),false);assert.equal(result.population,'multicountry');
});
test('malicious placeholder wrappers cannot hide a planted value from the independent yardstick',()=>{
  const value='Separate Synthetic Name',seeds=[{type:'NAME',value,country:'AU'}];
  for(const candidate of ['[[PII_'+value+']]','[[PRIVATE_'+value+']]','base64:'+Buffer.from('[[PRIVATE_'+value+']]').toString('base64')]){const scan=scanStage6cCandidate(candidate,seeds);assert.equal(scan.leak,true);assert.equal(JSON.stringify(scan).includes(value),false);}
  assert.equal(scanStage6cCandidate('How should [PERSON] compare [AMOUNT] with [VALUE]?',seeds).leak,false);
});
test('usable status cannot ignore the runtime intent-validation gate',()=>{
  const item={id:'intent','content':'A private test source.',area:'safe',population:'frozen'},question='How can the appropriate method be chosen?',prepared={question,sourceHash:sha256(item.content),questionHash:sha256(question),baseBlocked:false,intent:{valid:false,code:'INTENT_MISSING'},stages:[]},result=finishStage6cRow(item,prepared,{stages:[],blockedByLayer:['INTENT_MISSING'],shadowDetection:{}});
  assert.equal(result.candidateAvailable,false);assert.equal(result.availableDetections.intent,true);assert.equal(result.detectedBlock,true);
});
test('inbound shadow-only permits are not mistaken for operational rejection, but pending injection still blocks',()=>{
  const item={id:'incoming',sourceCategory:'synthetic',hash:'b'.repeat(64)},prepared={sourceHash:'a'.repeat(64),questionHash:'c'.repeat(64)},checked={prepared,availableChecksPassed:true,operationalPassed:false,guardClassification:'safe',stages:[{layerId:'prompt_guard_86m',status:'PASS',available:true}]};
  assert.equal(incomingStage6cRow(item,checked).hypotheticalBlocked,false);
  const pending={...checked,injectionPending:true,stages:[{layerId:'prompt_guard_86m',status:'PENDING',available:false}]};assert.equal(incomingStage6cRow(item,pending).hypotheticalBlocked,true);assert.equal(incomingStage6cRow(item,pending,{nativeReplay:true}).hypotheticalBlocked,false);
});
test('native quality reuses Google work without inventing another independent latency sample',()=>{
  const qualityRows=[{id:'local-quality',status:'SURROGATE_COMPLETE',outboundWouldRelease:true,inboundWouldPass:true,beforeScore:{score:1,factCoverage:1},afterScore:{score:.5,factCoverage:.5},tokenRoundTripVerified:true,beforeStage:{layerId:'matched_local_baseline',status:'PASS',latencyMs:10,reused:true},afterStage:{layerId:'local_apply',status:'PASS',latencyMs:20,reused:true}}],setup=summarizeStage6cSetup(STAGE6C_SETUPS[3],frame(),{criteria,qualityRows});
  assert.equal(setup.quality.sharedModelWorkWith,'google-lens');assert.equal(setup.quality.layerLatency[0].n,0);assert.equal(setup.quality.layerLatency[0].reused,1);assert.equal(setup.quality.cloudQuality,'DEFERRED');assert.equal(setup.quality.baselineFullCreditAll,1);assert.equal(setup.quality.applicationFullCreditAll,0);assert.equal(setup.quality.endToEndCompleted,1);
});
test('quality application requires setup-specific outbound and inbound passes, not a shadow permit alone',()=>{
  const checked={availableChecksPassed:true,checkPermit:{},stages:[{layerId:'prompt_guard_86m',status:'PASS',available:true}]},outbound={hypotheticalBlocked:false,error:false,candidateAvailable:true};
  assert.equal(stage6cQualityGate('meta-lens',outbound,checked).mayApply,true);assert.equal(stage6cQualityGate('meta-lens',{...outbound,hypotheticalBlocked:true},checked).mayApply,false);
  const rejected={...checked,stages:[{layerId:'prompt_guard_86m',status:'BLOCKED',available:true}]};assert.equal(stage6cQualityGate('google-lens',outbound,rejected).mayApply,false);assert.equal(stage6cQualityGate('google-native-only',outbound,rejected).mayApply,true);
  const pending={...checked,stages:[{layerId:'prompt_guard_86m',status:'PENDING',available:false}]};assert.equal(stage6cQualityGate('google-lens',outbound,pending).mayApply,false);
});
test('public stage projection strips local prompts and source details',()=>{
  const result=publicStage6cLayer({layerId:'rewrite',status:'PASS',latencyMs:1,text:'Private source',messages:[{content:'Private source'}],prompt:'Private source',modelId:'synthetic-local'},{reused:true});assert.equal(JSON.stringify(result).includes('Private source'),false);assert.equal(result.reused,true);
  assert.deepEqual(stage6cLayerBlocks([{layerId:'rewrite',status:'ERROR',code:'LOCAL_TRUNCATED'}]),[{layerId:'rewrite',code:'LOCAL_TRUNCATED',availability:true}]);
  const blocked=stage6cLayerBlocks([{layerId:'prompt_guard_86m',status:'BLOCKED'}],['INTENT_DROPPED','LLM_PRIVATE_DATA_REMAINS']);assert.equal(blocked[0].layerId,'llm_check');assert.equal(blocked[1].layerId,'intent');assert.equal(blocked[2].layerId,'prompt_guard_86m');
});
test('private run directory cannot be configured inside the checkout',()=>{
  const previous=process.env.STAGE6C_PRIVATE_ROOT;try{process.env.STAGE6C_PRIVATE_ROOT=process.cwd()+'/.logs/should-not-store-attacks';assert.throws(()=>stage6cPrivateRoot(),/EXTERNAL/);process.env.STAGE6C_PRIVATE_ROOT=process.cwd()+'/../Handoff-private/stage6c';assert.match(stage6cPrivateRoot(),/Handoff-private/);}finally{if(previous===undefined)delete process.env.STAGE6C_PRIVATE_ROOT;else process.env.STAGE6C_PRIVATE_ROOT=previous;}
});
test('resume identity excludes cold-load latency but retains model asset hashes and threshold',()=>{
  const base={threshold:.5,variants:[{revision:'pinned',assetIdentity:'a'.repeat(64),loadMs:12,versions:{python:'local'}}]},other={...base,variants:[{...base.variants[0],loadMs:99}]};
  assert.equal(sha256(stableStage6cMetadata(base)),sha256(stableStage6cMetadata(other)));assert.notEqual(sha256(stableStage6cMetadata(base)),sha256(stableStage6cMetadata({...base,threshold:.6})));
});
test('source fingerprints exclude generated Python bytecode and retain source modules',()=>{
  assert.equal(isStage6cSourceFile('src/privacy/__pycache__/prompt_guard_worker.cpython-314.pyc'),false);assert.equal(isStage6cSourceFile('src/privacy/worker.pyc'),false);assert.equal(isStage6cSourceFile('src/privacy/prompt_guard_worker.py'),true);assert.equal(isStage6cSourceFile('src/rag/gateway.mjs'),true);assert.equal(isStage6cSourceFile('config/stage6c-evaluation.json'),true);
});
test('report renders independent populations, fixed thresholds, unavailable quality and layer attribution',()=>{
  const setup=summarizeStage6cSetup(STAGE6C_SETUPS[0],frame(),{criteria,qualityRows:Array.from({length:11},(_,i)=>({id:'quality-'+i,status:'SURROGATE_OUTPUT_BLOCKED'}))}),report={runId:'synthetic-run',source:{gitCommit:'f'.repeat(40)},settings:{seed:20261027},setups:[setup],promptGuardStandalone:[summarizeStandalonePromptGuard('86m',[row('a','attacks',{status:'PENDING',available:false,detected:false})],{threshold:.5})],findings:['A synthetic finding.'],caveats:['Synthetic PII.']},text=renderStage6cReport(report);
  assert.ok(text.startsWith('# Stage 6c:'));assert.equal(text.includes('\\n'),false);assert.match(text,/30\/50/);assert.match(text,/36\/60/);assert.match(text,/Fixed threshold/);assert.match(text,/False-block attribution/);assert.match(text,/First failing layer count/);assert.match(text,/0 \| 0 \| 0 \| 0/);assert.match(text,/Real cloud quality remains DEFERRED/);assert.match(text,/Live dispatch remains disabled/);
  assert.equal(text.split('\n').some(line=>/[ \t]+$/.test(line)),false);
});
test('R2 rendering preserves a separately hashed R1 baseline without treating its metrics as rerun work',()=>{
  const setup=summarizeStage6cSetup(STAGE6C_SETUPS[0],frame(),{criteria}),previous={directory:'synthetic-prior-run',sha256:'b'.repeat(64),sourceCommit:'c'.repeat(40),setups:[{id:setup.id,privacy:setup.privacy,metrics:setup.metrics,errors:10,qualityCompleted:0,qualityAttempted:11}]};
  const text=renderStage6cReport({runId:'synthetic-r2',source:{gitCommit:'f'.repeat(40)},settings:{seed:20261027},setups:[setup],promptGuardStandalone:[],previousStage6c:previous,findings:[],caveats:[]});
  assert.match(text,/Preserved Stage 6c first run versus corrected run/);assert.match(text,/synthetic-prior-run/);assert.match(text,/10 → 0/);assert.match(text,/not an unseen validation set/);assert.match(text,/No model calls, checkpoints or latency are reused/);assert.equal(text.split('\n').some(line=>/[ \t]+$/.test(line)),false);
});
test('previous report references cannot escape results or omit the immutable content hash',async()=>{
  await assert.rejects(loadPreviousStage6cReport(process.cwd(),{directory:'../other',reportSha256:'a'.repeat(64)}),/INVALID/);await assert.rejects(loadPreviousStage6cReport(process.cwd(),{directory:'synthetic',reportSha256:'invalid'}),/INVALID/);assert.equal(await loadPreviousStage6cReport(process.cwd(),null),null);
});
test('network fence keeps attacks structurally unable to reach any cloud API',async t=>{
  let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;return new Response('{}');});const fence=installStage6bNetworkFence();try{for(const url of ['https://api.meta.ai/v1/responses','https://generativelanguage.googleapis.com/','https://openrouter.ai/api/v1'])await assert.rejects(fetch(url),{code:'STAGE6B_NETWORK_DENIED'});assert.equal(calls,0);}finally{fence.restore();}
});
