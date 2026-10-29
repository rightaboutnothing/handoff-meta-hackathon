import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {wilsonInterval} from '../../src/comparison/metrics.mjs';
import {canonicalJSON} from '../../src/rag/receipts.mjs';

const defaultRoot=fileURLToPath(new URL('../../results/',import.meta.url));
const stages=['6b','6c','6d','6f'];
const labels={'meta-lens':'Meta lens','google-lens':'Google lens','google-native-only':'Google native-only','presidio-baseline':'Presidio'};
const attributionLabels={tokenize_lost_intent:'Tokenize lost-intent',question_validation:'Question validation',prompt_guard:'Prompt Guard',harmful_content:'Harmful content',rewrite:'Rewrite refusal / contract',other:'Other checks'};
const checkLabels={frozenPopulationComplete:'Frozen population complete',multicountryPopulationComplete:'Country population complete',noPlantedSurvivors:'No planted PII survivors',frozenUsableTarget:'Frozen usability target',multicountryUsableTarget:'Country usability target',safePopulationComplete:'Safe population complete',lowSafeFalseBlocking:'Safe false-block limit',primaryInjectionAvailable:'Primary injection detector available',noExecutionErrors:'No unresolved execution errors',applicationTarget:'Local application target',productionCandidate:'Complete production-candidate pipeline'};
const sha=value=>createHash('sha256').update(value).digest('hex');
const isHash=value=>typeof value==='string'&&/^[a-f0-9]{64}$/.test(value);
const integer=value=>Number.isSafeInteger(value)&&value>=0;
const fail=()=>{throw new Error('PRIVACY_RESULTS_INVALID_METADATA');};
function counts(events,n,errors=0){
  if(!integer(n)||!integer(events)||events>n||!integer(errors)||errors>n)fail();
  return{n,events,rate:n?events/n:null,wilson95:wilsonInterval(events,n),errors};
}
function metric(value){
  if(value==null)return null;
  const out=counts(value.events,value.n,value.errors??0);
  if(value.rate!==undefined&&(out.rate===null?value.rate!==null:!Number.isFinite(value.rate)||Math.abs(value.rate-out.rate)>1e-8))fail();
  if(value.wilson95!==undefined){
    if(out.wilson95===null){if(value.wilson95!==null)fail();}
    else if(!Array.isArray(value.wilson95)||value.wilson95.length!==2||value.wilson95.some((x,i)=>!Number.isFinite(x)||Math.abs(x-out.wilson95[i])>1e-8))fail();
  }
  return out;
}
function findMetric(setup,id){return metric(setup.metrics?.find(row=>row.id===id));}
function timestamp(value){if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(value)||!Number.isFinite(Date.parse(value)))fail();return value;}
function awst(value){return new Intl.DateTimeFormat('en-AU',{timeZone:'Australia/Perth',year:'numeric',month:'short',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(new Date(value))+' AWST (Perth)';}
async function regular(file,parent,max=8*1024*1024){
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>max)throw new Error('PRIVACY_RESULTS_UNSAFE_FILE');
  const resolved=await realpath(file);if(path.dirname(resolved).toLowerCase()!==parent.toLowerCase())throw new Error('PRIVACY_RESULTS_UNSAFE_FILE');
  return readFile(resolved,'utf8');
}
async function published(base,stage){
  let raw;try{raw=await regular(path.join(base,`stage${stage}-latest.json`),base,4096);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  let pointer;try{pointer=JSON.parse(raw);}catch{fail();}
  if(pointer?.schemaVersion!==1||typeof pointer.directory!=='string'||!new RegExp(`^\\d{4}-\\d{2}-\\d{2}-stage${stage}-question-boundary(?:-r\\d+)?$`).test(pointer.directory)||!isHash(pointer.reportSha256))fail();
  const folder=path.join(base,pointer.directory),info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('PRIVACY_RESULTS_UNSAFE_FILE');
  const resolved=await realpath(folder);if(path.dirname(resolved).toLowerCase()!==base.toLowerCase())throw new Error('PRIVACY_RESULTS_UNSAFE_FILE');
  const text=await regular(path.join(resolved,'report.json'),resolved);if(sha(text)!==pointer.reportSha256)throw new Error('PRIVACY_RESULTS_HASH_MISMATCH');
  let report;try{report=JSON.parse(text);}catch{fail();}
  if(report.schemaVersion!==1||report.kind!==`stage${stage}-question-boundary-report`||report.runId!==pointer.directory||report.tier!==0||report.dryRun!==true||report.cloudCalls!==0||report.spendUsd!==0||report.liveDispatchEnabled===true||report.settings?.cloudCallsAllowed!==false||report.boundarySettings?.cloudDispatchEnabled!==false||report.network?.externalRequests!==0||!isHash(report.source?.hash)||!/^[a-f0-9]{40}$/.test(report.source?.gitCommit??'')||!integer(report.settings?.seed)||!Array.isArray(report.setups))throw new Error('PRIVACY_RESULTS_OFFLINE_IDENTITY_REQUIRED');
  if(!report.source.files||Array.isArray(report.source.files)||!Object.keys(report.source.files).length||Object.values(report.source.files).some(value=>!isHash(value))||sha(canonicalJSON(report.source.files))!==report.source.hash)throw new Error('PRIVACY_RESULTS_SOURCE_HASH_MISMATCH');
  timestamp(report.timestamp);
  if(new Set(report.setups.map(setup=>setup.id)).size!==report.setups.length||report.setups.some(setup=>!Object.hasOwn(labels,setup.id)))fail();
  const complete=stage==='6b'?['COMPLETE_LOCAL_ONLY','COMPLETE_WITH_PENDING_INJECTION'].includes(report.status):report.status==='COMPLETE_LOCAL_ONLY';
  return{stage,pointer,report,complete};
}
function privacy(setup,population){
  const value=setup.privacy?.[population];if(value){
    const pii=metric(value.attemptedScan??{n:value.attempted,events:value.seedSurvivorQueries,errors:value.errors??0});
    return{pii,usable:counts(value.usable,value.attempted,value.errors??0)};
  }
  if(population==='frozen'&&setup.candidateCoverage){const coverage=setup.candidateCoverage;return{pii:findMetric(setup,'candidate-pii'),usable:counts(coverage.available,coverage.attempted,coverage.errors??0)};}
  return{pii:null,usable:null};
}
function gate(setup){
  const checks=[];
  for(const [id,label]of Object.entries(checkLabels)){if(id==='applicationTarget'||id==='productionCandidate')continue;const pass=setup.gate?.checks?.[id];if(pass!==undefined){if(typeof pass!=='boolean')fail();checks.push({id,label,pass});}}
  if(setup.applicationTarget?.appliesToThisSetup===true){if(typeof setup.applicationTarget.passed!=='boolean')fail();checks.push({id:'applicationTarget',label:checkLabels.applicationTarget,pass:setup.applicationTarget.passed});}
  if(typeof setup.productionCandidate!=='boolean')fail();checks.push({id:'productionCandidate',label:checkLabels.productionCandidate,pass:setup.productionCandidate});
  const recorded=setup.stage6fReadiness?.passed??setup.stage6dReadiness?.passed??setup.gate?.stage7Allowed??setup.gate?.liveReleaseAllowed;
  if(recorded!==undefined&&typeof recorded!=='boolean')fail();
  if(recorded===true&&checks.some(row=>row.pass===false))throw new Error('PRIVACY_RESULTS_GATE_CONTRADICTION');
  const status=setup.productionCandidate===false||recorded===false?'FAIL':recorded===true?'PASS':'PENDING';
  return{status,checks,reasons:checks.filter(row=>row.pass===false).map(row=>row.label)};
}
function attribution(setup,safe,gaps){
  const source=setup.falsePositiveAttribution;
  const bucketRows=Object.fromEntries(Object.keys(attributionLabels).map(id=>[id,[]]));
  if(!Array.isArray(source))return Object.entries(attributionLabels).map(([layerId,label])=>({layerId,label,firstBlocks:null,overlapping:null}));
  for(const row of source){
    const measured=metric(row.blocks);if(!safe||measured.n!==safe.n||!integer(row.firstBlocks)||row.firstBlocks>measured.events)fail();
    let bucket=row.layerId==='question_validation'?'question_validation':/^prompt_guard_/.test(row.layerId)?'prompt_guard':row.layerId==='harmful_content'?'harmful_content':row.layerId==='rewrite'?'rewrite':'other';
    if(row.layerId==='tokenize'&&row.reasons?.includes('QUESTION_INTENT_LOST')){
      const substantive=(row.reasons??[]).filter(reason=>reason!=='LAYER_POLICY_BLOCK');
      if(substantive.every(reason=>reason==='QUESTION_INTENT_LOST'))bucket='tokenize_lost_intent';
      else gaps.push('Mixed tokenisation causes cannot be separated into lost-intent and other checks from the saved aggregate.');
    }
    bucketRows[bucket].push({...row,measured});
  }
  const totalFirst=source.reduce((sum,row)=>sum+row.firstBlocks,0);if(safe&&totalFirst!==safe.events)throw new Error('PRIVACY_RESULTS_ATTRIBUTION_MISMATCH');
  return Object.entries(attributionLabels).map(([layerId,label])=>{
    const rows=bucketRows[layerId],firstBlocks=rows.reduce((sum,row)=>sum+row.firstBlocks,0);let events=rows.reduce((sum,row)=>sum+row.measured.events,0);
    if(rows.length>1){if(rows.every(row=>Array.isArray(row.cases)&&row.cases.length===row.measured.events&&row.cases.every(item=>typeof item.id==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(item.id))))events=new Set(rows.flatMap(row=>row.cases.map(item=>item.id))).size;else{gaps.push('Overlapping causes grouped as other checks lack complete identities for deduplication.');return{layerId,label,firstBlocks,overlapping:null};}}
    return{layerId,label,firstBlocks,overlapping:safe?counts(events,safe.n):null};
  });
}
function normalizeSetup(setup,gaps){
  const frozen=privacy(setup,'frozen'),country=privacy(setup,'multicountry'),safe=findMetric(setup,'safe-operational');
  let complete=null,fullCredit=null;
  if(setup.id!=='presidio-baseline'&&setup.quality&&integer(setup.quality.n)){
    const n=setup.applicationTarget?.attempted??setup.quality.n,done=setup.applicationTarget?.completed??setup.quality.endToEndCompleted??setup.quality.completed,full=setup.quality.applicationFullCreditAll??setup.quality.fullCreditAfter;
    if(integer(done))complete=counts(done,n);if(integer(full))fullCredit=counts(full,n);if(complete&&fullCredit&&fullCredit.events>complete.events)fail();
  }
  return{id:setup.id,label:labels[setup.id],productionCandidate:setup.productionCandidate,pii:{frozen:frozen.pii,multicountry:country.pii},usable:{frozen:frozen.usable,multicountry:country.usable},attacks:findMetric(setup,'attacks-detected'),safe,applications:{complete,fullCredit,mode:'local-surrogate'},gate:gate(setup),errors:integer(setup.summary?.errors)?setup.summary.errors:null,attribution:attribution(setup,safe,gaps)};
}
function detector(value){
  if(!['86m','22m'].includes(value.variant)||!Number.isFinite(value.threshold)||value.threshold<0||value.threshold>1||!integer(value.attempted)||!integer(value.available)||value.available>value.attempted||!integer(value.errors))fail();
  let latency=null;if(value.latency){const l=value.latency;if(!integer(l.n)||[l.medianMs,l.p95Ms].some(x=>x!==null&&(!Number.isFinite(x)||x<0))||l.medianMs!==null&&l.p95Ms!==null&&l.p95Ms<l.medianMs)fail();latency={n:l.n,medianMs:l.medianMs,p95Ms:l.p95Ms};}
  return{variant:value.variant,threshold:value.threshold,attempted:value.attempted,available:value.available,errors:value.errors,jailbreak:metric(value.bySource?.find(row=>row.category==='jailbreak')?.attacks),injection:metric(value.bySource?.find(row=>row.category==='prompt-injection')?.attacks),safe:metric(value.safe),latency};
}
/** Only trusted labels, validated numeric aggregates and provenance leave this
 * module. Per-item identities, any report prose, prompt/output text, request
 * payloads and token/key material are structurally absent from the public DTO. */
export async function readPrivacyResults({resultsDir=defaultRoot}={}){
  let base;try{base=await realpath(resultsDir);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  const runs=await Promise.all(stages.map(stage=>published(base,stage))),chosen=[runs[3],runs[2],runs[1]].find(value=>value?.complete);
  if(!chosen)return null;
  const gaps=[];for(let i=0;i<runs.length;i++)if(!runs[i]?.complete)gaps.push(`Stage ${stages[i]} has no completed, published measurement.`);
  const report=chosen.report,setups=Object.keys(labels).map(id=>{const setup=report.setups.find(row=>row.id===id);if(!setup)fail();return normalizeSetup(setup,gaps);});
  if(Array.isArray(report.promptGuardStandalone)&&new Set(report.promptGuardStandalone.map(row=>row.variant)).size!==report.promptGuardStandalone.length)fail();
  if(!runs[0]?.report.setups.every(setup=>setup.privacy?.multicountry))gaps.push('Stage 6b did not publish the separate multi-country population.');
  if(setups.some(setup=>setup.id==='presidio-baseline'&&!setup.applications.complete))gaps.push('Local answer application is not applicable to the Presidio comparison.');
  if(!Array.isArray(report.promptGuardStandalone)||!report.promptGuardStandalone.length)gaps.push('Standalone Prompt Guard jailbreak, injection and latency measurements are pending.');
  const progress=runs.slice(0,chosen.stage==='6f'?4:3).map((run,index)=>{
    if(!run?.complete)return{stage:stages[index],runId:null,timestamp:null,timestampAwst:null,sourceHash:null,reportSha256:null,setups:[]};
    const value=run.report;return{stage:stages[index],runId:value.runId,timestamp:value.timestamp,timestampAwst:awst(value.timestamp),sourceHash:value.source.hash,reportSha256:run.pointer.reportSha256,setups:Object.keys(labels).map(id=>{const setup=value.setups.find(row=>row.id===id);if(!setup)fail();return{id,label:labels[id],usableFrozen:privacy(setup,'frozen').usable,usableMulticountry:privacy(setup,'multicountry').usable,safeOperational:findMetric(setup,'safe-operational'),safeDetected:findMetric(setup,'safe-detected')};})};
  });
  const notes=['All figures come from hash-verified local result files. Wilson intervals are derived from the recorded counts.','PII survivors are per query with any planted value retained. Zero survivors with no usable questions is not successful service.','Stage 6b operational false blocks include the pending injection layer; available-check detections are a separate series. The methods differ between stages.','False-block first causes are exclusive. Overlapping layer flags can affect the same query and must not be added.','Attack blocks include privacy, intent and safety checks, not isolated injection detection. Application completion and full-credit correctness are separate.','The evaluation frame is known and synthetic variants are correlated. Intervals are descriptive, not future-traffic or compliance certification.'];
  for(const setup of setups)if(setup.usable.frozen?.n>0&&setup.usable.frozen.events===0)notes.push(`${setup.label} has no usable frozen candidates; zero observed survivors does not establish usable private service.`);
  for(const setup of report.setups)if(setup.repairTarget?.applies===true){const goal=setup.repairTarget;if(![goal.usable,goal.attempted,goal.target].every(integer)||goal.usable>goal.attempted||goal.target>goal.attempted||typeof goal.passed!=='boolean'||goal.passed!==(goal.usable>=goal.target))fail();if(!goal.passed)notes.push(`${labels[setup.id]} full frozen usability repair target is unmet: ${goal.usable}/${goal.attempted} usable, requested ${goal.target}. This is separate from the unchanged release gate.`);}
  return{schemaVersion:1,kind:'privacy-results-dashboard',stage:chosen.stage,runId:report.runId,timestamp:report.timestamp,timestampAwst:awst(report.timestamp),sourceHash:report.source.hash,sourceCommit:report.source.gitCommit,reportSha256:chosen.pointer.reportSha256,seed:report.settings.seed,cloudCalls:report.cloudCalls,spendUsd:report.spendUsd,liveDispatchEnabled:false,setups,progress,promptGuard:(report.promptGuardStandalone??[]).map(detector),gaps:[...new Set(gaps)],notes};
}
