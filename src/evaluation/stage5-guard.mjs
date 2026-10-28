import {readFile,mkdir,writeFile,open,rename} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import os from 'node:os';
import {execFileSync} from 'node:child_process';
import {performance} from 'node:perf_hooks';
import {createPrivacyVault,assertNoResidualPii} from '../rag/privacy.mjs';
import {assertLeanWire,semanticLeanWireText} from '../comparison/handoff-payload.mjs';
import {isCloudEligible} from '../comparison/policy.mjs';
import {acquireRunLock} from '../comparison/run-lock.mjs';
import {sha256} from '../rag/receipts.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
export const STAGE5_KIND='stage5-guard-report';
const privateKey=/private|customer|contact|email|e[-_]?mail|phone|mobile|telephone|canary|(?:^|_)account_id$|(?:^|_)person(?:al)?(?:_|$)/i;
const isCompany=row=>/^company-data(?:[ -]|$)/.test(String(row.category));
const placeholder=/\[\[PII_(EMAIL|PHONE|NAME|SECRET)_[a-f0-9]{16}\]\]/g;
const types=['EMAIL','PHONE','NAME','SECRET'];
const counts=text=>Object.fromEntries(types.map(type=>[type,[...String(text).matchAll(placeholder)].filter(match=>match[1]===type).length]));
const total=record=>Object.values(record).reduce((sum,value)=>sum+value,0);
const readJson=async file=>JSON.parse(await readFile(file,'utf8'));
async function optional(file){try{return await readJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
async function atomicJson(file,value){await mkdir(path.dirname(file),{recursive:true});const temp=`${file}.${process.pid}.tmp`,handle=await open(temp,'w',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}await rename(temp,file);}
async function append(file,value){await mkdir(path.dirname(file),{recursive:true});const handle=await open(file,'a',0o600);try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}}
async function journal(file){let text;try{text=await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return[];throw error;}if(text&&!text.endsWith('\n')){const end=text.lastIndexOf('\n')+1,handle=await open(file,'r+');try{await handle.truncate(Buffer.byteLength(text.slice(0,end)));await handle.sync();}finally{await handle.close();}text=text.slice(0,end);}return text.split('\n').filter(Boolean).map(JSON.parse);}

/** Select only the 11 safe business-data proposals from the locked primary
 * Gemma 12B replay. Raw task text is never returned to the publisher. */
export function selectStage5Proposals({decisions,tokenRows,payloads,metadata,settings}){
  const meta=new Map(metadata.map(item=>[item.id,item])),wires=new Map(payloads.map(value=>[value.payloadHash,value])),seen=new Set();
  const selected=decisions.filter(row=>row.population===settings.population&&row.modelId===settings.localModelId&&row.safe===true&&row.accepted===false&&(isCompany(row)||row.suite==='ad-privacy'));
  if(selected.length!==settings.expectedItems||selected.filter(isCompany).length!==settings.expectedCompanyDocuments||selected.filter(row=>row.suite==='ad-privacy').length!==settings.expectedAdExports)throw new Error('The frozen eleven-proposal business slice is incomplete');
  return selected.map(row=>{
    if(seen.has(row.id))throw new Error('Duplicate frozen proposal');seen.add(row.id);const item=meta.get(row.id);
    if(!item||!isCloudEligible(item)||item.suite==='gpqa'||item.suite!==row.suite||item.category!==row.category||!isCloudEligible(row))throw new Error('Only trusted safe non-GPQA business proposals may reach Guard screening');
    const counters=tokenRows.filter(count=>count.id===row.id&&count.population===settings.population&&count.modelId===settings.localModelId);
    if(counters.length!==2||new Set(counters.map(count=>count.cloudId)).size!==2||counters.some(count=>!['gemini','muse-spark'].includes(count.cloudId)||!count.eligible||!count.handedOff||count.accepted||count.variant!=='question-only')||counters[0].payloadHash!==counters[1].payloadHash)throw new Error('Frozen per-provider payload identity or handoff decision changed');
    const saved=wires.get(counters[0].payloadHash),wire=assertLeanWire(saved?.payload?.wire);
    if(wire.draft!==null||saved.payload.variant!=='question-only'||sha256(wire)!==saved.payloadHash||saved.payload.payloadHash!==saved.payloadHash)throw new Error('Potential cloud payload must be unchanged, redacted and draft-free');
    return{id:row.id,suite:item.suite,category:item.category,item,wire,sourcePayloadHash:saved.payloadHash,sourceTokenCounts:counters.map(({cloudId,inputTokens})=>({cloudId,inputTokens}))};
  });
}

/** Reconstruct the earlier ad export minimization for counts and identity only.
 * Removed field values never leave this function or enter the result report. */
export function inspectPrivateFieldMinimization(item,wire,vault){
  if(item.suite!=='ad-privacy')return{privateFieldsExcluded:0,privateScalarValuesExcluded:0,minimizationVerified:true};
  const start=item.prompt.indexOf('{');if(start<0)throw new Error('Synthetic ad export is malformed');
  const original=JSON.parse(item.prompt.slice(start));let fields=0,scalars=0;
  const leaves=value=>Array.isArray(value)?value.reduce((sum,item)=>sum+leaves(item),0):value&&typeof value==='object'?Object.values(value).reduce((sum,item)=>sum+leaves(item),0):value==null?0:1;
  const strip=value=>Array.isArray(value)?value.map(strip):value&&typeof value==='object'?Object.fromEntries(Object.entries(value).filter(([name,entry])=>{if(privateKey.test(name)){fields++;scalars+=leaves(entry);return false;}return true;}).map(([name,entry])=>[name,strip(entry)])):value;
  const minimized=`${item.prompt.slice(0,start).trim()}\n\n${JSON.stringify(strip(original))}`;
  if(vault.redact(minimized).text.trim()!==wire.query.trim())throw new Error('Saved ad wire does not match verified private-field minimization');
  return{privateFieldsExcluded:fields,privateScalarValuesExcluded:scalars,minimizationVerified:true};
}

export function prepareStage5Proposal(proposal,vault){
  const before=[proposal.wire.system,proposal.wire.query,...proposal.wire.context.map(chunk=>chunk.text)].join('\n'),preexistingPlaceholdersByType=counts(before),newRedactionsByType=Object.fromEntries(types.map(type=>[type,0]));let redactionsApplied=0;
  const redact=text=>{const result=vault.redact(text),old=counts(text),next=counts(result.text);redactionsApplied+=result.count;for(const type of types)newRedactionsByType[type]+=Math.max(0,next[type]-old[type]);return result.text;};
  const wire=assertLeanWire({system:redact(proposal.wire.system),query:redact(proposal.wire.query),context:proposal.wire.context.map(({chunkId,text})=>({chunkId,text:redact(text)})),draft:null});
  const input=semanticLeanWireText(wire);assertNoResidualPii(input,vault);
  const minimized=inspectPrivateFieldMinimization(proposal.item,proposal.wire,vault);
  return{...proposal,wire,input,payloadHash:sha256(wire),inputHash:sha256(input),redactionsApplied,newRedactionsByType,preexistingPlaceholdersByType,preexistingPlaceholderOccurrences:total(preexistingPlaceholdersByType),...minimized};
}

/** The only allowed network activity is one local Guard model plus its local
 * metadata. Every external URL, other model and unexpected route fails closed. */
export function installStage5NetworkBoundary({guardModelId='llama-guard3:8b'}={}){
  const original=globalThis.fetch;let localRequests=0,guardCalls=0,metadataRequests=0,blockedExternalRequests=0,blockedOtherLocalRequests=0;
  globalThis.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url),method=String(options.method??'GET').toUpperCase();
    if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='11434'||url.username||url.password){blockedExternalRequests++;throw new Error('Stage 5 external network request denied');}
    let allowed=method==='GET'&&['/api/tags','/api/version'].includes(url.pathname);
    if(method==='POST'&&['/api/generate','/api/show'].includes(url.pathname)){
      let body;try{body=JSON.parse(options.body);}catch{}
      allowed=body?.model===guardModelId&&(url.pathname==='/api/show'||body.raw===true&&body.stream===false&&body.options?.temperature===0&&body.options?.seed===20261027&&body.options?.num_ctx===4096&&body.options?.num_predict===40&&body.keep_alive===-1);
    }
    if(!allowed||url.search){blockedOtherLocalRequests++;throw new Error('Stage 5 permits the pinned local Guard protocol only');}
    localRequests++;if(url.pathname==='/api/generate')guardCalls++;else metadataRequests++;
    return original(input,{...options,redirect:'error'});
  };
  return{restore(){globalThis.fetch=original;},status:()=>({externalRequests:0,localRequests,guardCalls,metadataRequests,blockedExternalRequests,blockedOtherLocalRequests})};
}

export function publicGuardResult(proposal,result,{attempts=1,latencyMs=result?.latencyMs??0}={}){
  const raw=result?.guardResult??result,classification=raw?.classification;
  const safe=classification==='safe'&&raw.safe===true&&/^safe$/i.test(String(raw.text??'').trim())&&raw.doneReason!=='length'&&(raw.tokens?.output??0)<40;
  const verdict=safe?'safe':classification==='unsafe'&&raw.safe===false?'unsafe':['unavailable','invalid'].includes(classification)?classification:'invalid';
  const categories=[...new Set((raw?.safetyCategories??raw?.categories??[]).filter(value=>/^S(?:[1-9]|1[0-4])$/.test(value)))];
  const wouldRelease=safe&&result?.wouldRelease!==false;
  return{id:proposal.id,suite:proposal.suite,category:proposal.category,guardModelId:raw?.modelId??'llama-guard3:8b',verdict,safetyCategories:categories,wouldRelease,releaseStatus:wouldRelease?'would_release':'blocked_local',screened:['safe','unsafe'].includes(verdict),redactionsApplied:proposal.redactionsApplied,newRedactionsByType:proposal.newRedactionsByType,preexistingPlaceholderOccurrences:proposal.preexistingPlaceholderOccurrences,preexistingPlaceholdersByType:proposal.preexistingPlaceholdersByType,privateFieldsExcluded:proposal.privateFieldsExcluded,privateScalarValuesExcluded:proposal.privateScalarValuesExcluded,minimizationVerified:proposal.minimizationVerified,sourcePayloadHash:proposal.sourcePayloadHash,payloadHash:proposal.payloadHash,inputHash:proposal.inputHash,chunkCount:proposal.wire.context.length,draftIncluded:false,attempts,latencyMs,tokens:raw?.tokens??{input:0,output:0,total:0},policyProtocol:raw?.policyProtocol??null,policyTemplateHash:raw?.policyTemplateHash??null,error:['safe','unsafe'].includes(verdict)?null:`GUARD_${verdict.toUpperCase()}`,actualCloudCalls:0};
}

export async function screenStage5Proposal(proposal,{screen,maxRetries=3,backoffMs=[1000,2000,4000],onRetry=async()=>{},onAttempt=async()=>{},sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms))}={}){
  if(typeof screen!=='function'||maxRetries!==3||backoffMs.length!==3)throw new Error('The shared Guard screen and three retry backoffs are required');
  const started=performance.now();let last;
  for(let attempt=0;attempt<=maxRetries;attempt++){
    try{const result=await screen(proposal.input);last=publicGuardResult(proposal,result,{attempts:attempt+1});const raw=result.guardResult??result;await onAttempt({attempt:attempt+1,id:proposal.id,inputHash:proposal.inputHash,text:raw.text??'',classification:raw.classification??'invalid',safe:raw.safe===true,safetyCategories:raw.safetyCategories??[],tokens:raw.tokens??null,policyProtocol:raw.policyProtocol??null,policyTemplateHash:raw.policyTemplateHash??null});}
    catch{last=publicGuardResult(proposal,{classification:'unavailable',safe:false,text:'',modelId:'llama-guard3:8b'},{attempts:attempt+1});}
    if(last.screened||attempt===maxRetries)break;
    await onRetry({attempt:attempt+1,backoffMs:backoffMs[attempt]});await sleep(backoffMs[attempt]);
  }
  return{...last,latencyMs:performance.now()-started};
}

export function summarizeStage5(items){
  const sum=name=>items.reduce((value,row)=>value+(row[name]??0),0),released=items.filter(row=>row.wouldRelease).length;
  return{items:items.length,screened:items.filter(row=>row.screened).length,released,wouldRelease:released,blocked:items.length-released,unsafe:items.filter(row=>row.verdict==='unsafe').length,errors:items.filter(row=>row.error).length,redactionsApplied:sum('redactionsApplied'),redactedItems:items.filter(row=>row.redactionsApplied>0).length,preexistingPlaceholderOccurrences:sum('preexistingPlaceholderOccurrences'),alreadyRedactedItems:items.filter(row=>row.preexistingPlaceholderOccurrences>0).length,privateFieldsExcluded:sum('privateFieldsExcluded'),privateScalarValuesExcluded:sum('privateScalarValuesExcluded'),privateFieldMinimizedItems:items.filter(row=>row.privateFieldsExcluded>0).length,companyDocuments:items.filter(isCompany).length,adExports:items.filter(row=>row.suite==='ad-privacy').length,actualCloudCalls:0,actualBusinessCloudCalls:0,spendUsd:0,guardTokens:items.reduce((sum,row)=>({input:sum.input+(row.tokens.input??0),output:sum.output+(row.tokens.output??0),total:sum.total+(row.tokens.total??0)}),{input:0,output:0,total:0})};
}
export function renderStage5Summary(report){
  const table=['| Item ID | Suite | Guard verdict | Unsafe categories | Would release | New PII replacements | Earlier private fields / values removed | Guard ms |','|---|---|---|---|---|---:|---:|---:|',...report.items.map(row=>`| ${row.id} | ${row.suite} | ${row.verdict} | ${row.safetyCategories.join(', ')||'—'} | ${row.wouldRelease?'Yes · dry run':'No · blocked locally'} | ${row.redactionsApplied} | ${row.privateFieldsExcluded} / ${row.privateScalarValuesExcluded} | ${row.latencyMs.toFixed(1)} |`)];
  return`# Stage 5: measured local Guard screening\n\n**Dry run: ${report.summary.screened}/${report.summary.items} valid Guard verdicts; ${report.summary.released} would release; ${report.summary.blocked} blocked. Zero cloud calls and $0 cloud spend.**\n\n${table.join('\n')}\n\nEvery proposal was rechecked/redacted locally before the same server-side boundary used by live routing. Only exact safe verdicts can create a hash-bound release permit. Released means eligible to send in a future enabled request, not delivered in this dry run. Unsafe, invalid and unavailable results stay blocked locally. Harmful/adversarial items are structurally ineligible for cloud release regardless of Guard.\n\nNew replacements: ${report.summary.redactionsApplied}; preexisting placeholder occurrences: ${report.summary.preexistingPlaceholderOccurrences}. Earlier ad-export preparation removed ${report.summary.privateFieldsExcluded} private field groups containing ${report.summary.privateScalarValuesExcluded} scalar values, across ${report.summary.privateFieldMinimizedItems} proposals. Zero new replacements does not imply private data never existed: the saved source inputs were already minimized. Counts are structural/removal checks, not universal anonymization.\n\nThe 11 proposals comprise ${report.summary.companyDocuments} company-document questions and ${report.summary.adExports} synthetic ad exports. Would-send snapshots are retained privately; public rows contain only IDs, classifications, counts, hashes, token usage and latency. Proposed question-only requests contain no local draft; minimum redacted context can accompany the question. New inbound Guard results remain pending because no cloud answer was requested. Warm-up is recorded separately and excluded from item timing.\n\nThe ${ (report.certification.finiteDevUpperRisk*100).toFixed(2)}% error bound covers the fixed accepted dev frame only. Future company traffic, unseen families and the test population remain uncertified. The separate AUDIT-only bound is ${(report.certification.auditOnlyUpperRisk*100).toFixed(1)}%. Screening does not certify answer correctness or universal privacy.\n\nThe new routing flag remains off by default. This stage did not enable Meta access, make a cloud model request, retune thresholds or start a new benchmark.\n`;
}

async function fingerprint(settings){
  const names=['config/stage5.json','config/rag.json','src/evaluation/stage5-guard.mjs','src/server/gateway-models.mjs','src/server/comparison-models.mjs','src/comparison/handoff-payload.mjs','src/rag/privacy.mjs'];
  const files={};for(const name of names)files[name]=sha256((await readFile(path.join(root,name),'utf8')).replace(/\r\n/g,'\n'));
  return{hash:sha256(files),files,settingsHash:sha256(settings),gitCommit:execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8',cwd:root,windowsHide:true}).trim()};
}
async function environment(guardModelId){
  const [tags,version,show]=await Promise.all([fetch('http://127.0.0.1:11434/api/tags').then(r=>r.json()),fetch('http://127.0.0.1:11434/api/version').then(r=>r.json()),fetch('http://127.0.0.1:11434/api/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:guardModelId})}).then(r=>r.json())]);
  const model=tags.models?.find(row=>row.name===guardModelId);if(!model?.digest)throw new Error('Pinned local Guard is not installed');
  let gpu=null;try{gpu=execFileSync('nvidia-smi',['--query-gpu=name,memory.total,driver_version','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim();}catch{}
  return{profile:'SMB-class local workstation',nodeVersion:process.version,ollamaVersion:version.version,guardModelId,guardDigest:model.digest,guardTemplateHash:sha256(show.template??''),cpu:os.cpus()[0]?.model??null,ramGiB:Number((os.totalmem()/2**30).toFixed(2)),gpu};
}
export async function runStage5Guard({runId='2026-10-28-stage5-guard',dependencies={},log=event=>console.error(JSON.stringify(event))}={}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(runId))throw new Error('Invalid Stage 5 run ID');
  const settings=await readJson(path.join(root,'config/stage5.json')),privateDir=path.join(root,'.logs/stage5',runId),publicDir=path.join(root,'results',runId);
  const release=await acquireRunLock(path.join(privateDir,'run.lock'),{owner:{runId,purpose:'stage5-local-guard-only'}}),boundary=installStage5NetworkBoundary(settings);
  const progress=async event=>{const value={at:new Date().toISOString(),runId,cloudCalls:0,spendUsd:0,...event};await append(path.join(privateDir,'progress.jsonl'),value);log(value);};
  try{
    if(process.env.CLOUD_BUDGET_USD!==undefined)throw new Error('Stage 5 requires the cloud budget to remain unset');
    const sourcePrivate=path.join(root,'.logs/stage3',settings.sourceRun),stage4File=path.join(root,'results',settings.sourceStage4Run,'report.json'),sourceNames={decisions:path.join(sourcePrivate,'decisions.json'),tokenRows:path.join(sourcePrivate,'token-counts.json'),payloads:path.join(sourcePrivate,'potential-cloud-payloads.json'),dataset:path.join(root,'tasks/comparison/items.jsonl'),sourcePolicy:path.join(root,'results',settings.sourceRun,'policy.json')};
    const stage4Text=await readFile(stage4File,'utf8'),stage4=JSON.parse(stage4Text),stage4Pointer=await readJson(path.join(root,'results/stage4-latest.json')),sourceText=Object.fromEntries(await Promise.all(Object.entries(sourceNames).map(async([key,file])=>[key,await readFile(file,'utf8')])));
    if(stage4Pointer.directory!==settings.sourceStage4Run||stage4Pointer.reportSha256!==sha256(stage4Text)||stage4.kind!=='stage4-slice-report')throw new Error('Stage 4 source report pointer or hash changed');
    for(const [key,text]of Object.entries(sourceText))if(stage4.sourceHashes[key]!==sha256(text))throw new Error('Frozen Stage 4 source hashes changed');
    if(stage4.cloudCalls!==0||stage4.sourcePolicyHash!==settings.policyHash||stage4.primaryPopulation!==settings.population)throw new Error('Unexpected frozen source policy');
    const policy=JSON.parse(sourceText.sourcePolicy);if(policy.policyHash!==settings.policyHash||sha256(policy.calibration)!==settings.policyHash)throw new Error('Stage 3 policy lock mismatch');
    const metadata=sourceText.dataset.trim().split(/\r?\n/).map(JSON.parse),proposals=selectStage5Proposals({decisions:JSON.parse(sourceText.decisions),tokenRows:JSON.parse(sourceText.tokenRows),payloads:JSON.parse(sourceText.payloads),metadata,settings});
    const source=await fingerprint(settings),hardware=await environment(settings.guardModelId),sourceHashes=Object.fromEntries(Object.entries(sourceText).map(([key,value])=>[key,sha256(value)])),identity={sourceHash:source.hash,sourceHashes,stage4Hash:sha256(stage4Text),guardDigest:hardware.guardDigest,settingsHash:sha256(settings)};
    const stateFile=path.join(privateDir,'study.json'),oldState=await optional(stateFile);if(oldState&&sha256(oldState.identity)!==sha256(identity))throw new Error('Stage 5 resume refused after frozen input/code/model change');await atomicJson(stateFile,{identity,source,settings,environment:hardware});
    const vault=await createPrivacyVault(path.join(root,'.handoff')),prepared=proposals.map(proposal=>prepareStage5Proposal(proposal,vault));await vault.save();
    const screen=dependencies.screen??(await import('../server/gateway-models.mjs')).screenForCloud;
    if(typeof screen!=='function')throw new Error('Shared server Guard boundary is unavailable');
    if(process.env.CLOUD_BUDGET_USD!==undefined)throw new Error('Stage 5 cloud budget must remain unset');
    const routingConfig=await readJson(path.join(root,'config/rag.json'));if(routingConfig.lockedCompanyRoutingEnabled!==false)throw new Error('The production routing flag must remain off during this dry run');
    const warmFile=path.join(privateDir,'warmup.json'),warmJournal=path.join(privateDir,'warmups.jsonl'),warmups=await journal(warmJournal),cached=await Promise.all(prepared.map(proposal=>optional(path.join(privateDir,'items',sha256(proposal.id)+'.json'))));let warm=warmups.at(-1)??await optional(warmFile);
    if(cached.some(row=>!row)){const input='A harmless synthetic company warranty lookup.',wire={system:'',query:input,context:[],draft:null};const result=await screenStage5Proposal({id:'warmup',suite:'warmup',category:'warmup',wire,input,inputHash:sha256(input),payloadHash:sha256(wire)},{screen,onRetry:event=>progress({phase:'warmup-retry',...event})});warm={...result,at:new Date().toISOString(),excludedFromTimings:true};warmups.push(warm);await append(warmJournal,warm);await atomicJson(warmFile,warm);await progress({phase:'warm-up',...warm});}
    if(!warm)throw new Error('Measured Guard rows have no warm-up provenance');
    const items=[];
    for(const proposal of prepared){
      const rowFile=path.join(privateDir,'items',sha256(proposal.id)+'.json');let row=await optional(rowFile);
      if(row&&(row.inputHash!==proposal.inputHash||row.payloadHash!==proposal.payloadHash))throw new Error('Saved proposal input changed during resume');
      if(row?.wouldRelease){const snapshot=await optional(path.join(privateDir,'would-send',sha256(proposal.id)+'.json'));if(!snapshot||snapshot.inputHash!==sha256(snapshot.compiledInput)||snapshot.inputHash!==proposal.inputHash||snapshot.payloadHash!==sha256(snapshot.wire)||snapshot.payloadHash!==proposal.payloadHash)throw new Error('Retained would-send snapshot failed verification');}
      if(!row){
        row=await screenStage5Proposal(proposal,{screen,maxRetries:settings.maxRetries,backoffMs:settings.retryBackoffMs,onRetry:event=>progress({phase:'retry',id:proposal.id,...event}),onAttempt:attempt=>atomicJson(path.join(privateDir,'guard-attempts',`${sha256(proposal.id)}-${attempt.attempt}.json`),attempt)});
        if(row.wouldRelease)await atomicJson(path.join(privateDir,'would-send',sha256(proposal.id)+'.json'),{id:proposal.id,wire:proposal.wire,compiledInput:proposal.input,inputHash:proposal.inputHash,payloadHash:proposal.payloadHash,dryRun:true,actualCloudCalls:0,spendUsd:0});
        await atomicJson(rowFile,row);await append(path.join(privateDir,'items.jsonl'),row);
      }
      items.push(row);await progress({phase:'screened',id:row.id,completed:items.length,total:prepared.length,verdict:row.verdict,wouldRelease:row.wouldRelease});
    }
    if((await fingerprint(settings)).hash!==source.hash)throw new Error('Stage 5 Guard/runtime code changed during measurement');
    const stats=boundary.status();if(stats.blockedExternalRequests||stats.blockedOtherLocalRequests)throw new Error('Unexpected network attempt prevented during Guard measurement');
    const cert=policy.calibration.models[settings.localModelId].slices.company.certificate,summary=summarizeStage5(items),report={schemaVersion:1,kind:STAGE5_KIND,runId,timestamp:new Date().toISOString(),tier:0,status:summary.errors?'COMPLETE_WITH_GUARD_ERRORS':'COMPLETE',sourceRun:settings.sourceRun,sourceStage4Run:settings.sourceStage4Run,population:settings.population,localModelId:settings.localModelId,guardModelId:settings.guardModelId,dryRun:true,routingFlagDefault:false,cloudCalls:0,modelAnswerCalls:0,guardCalls:items.reduce((sum,row)=>sum+row.attempts,0)+warmups.reduce((sum,row)=>sum+(row.attempts??1),0),spendUsd:0,providerDeliveries:0,inboundStatus:'pending',summary,items,settings,source,provenance:{sourceHashes,stage4ReportHash:sha256(stage4Text),policyHash:settings.policyHash},environment:hardware,network:stats,warmup:warm,warmupRuns:warmups.length,certification:{finiteDevUpperRisk:cert.upperRisk,auditOnlyUpperRisk:cert.unsampled.upperRisk,scope:cert.scope,futureCertified:false},notes:['Only the 11 trusted safe primary Gemma 12B business-data proposals were screened.','Released means would send in a dry run, not cloud delivery. No new inbound Guard result exists.','New replacements and earlier private-field minimization are distinct counts.','Question-only excludes local drafts; minimum redacted source context may be included.','Every harmful/adversarial item remains local by independent policy, even if a Guard could pass it.','The flag stays off by default, and the fixed dev-frame certificate does not cover future traffic.']};
    await atomicJson(path.join(publicDir,'report.json'),report);await writeFile(path.join(publicDir,'summary.md'),renderStage5Summary(report));const body=await readFile(path.join(publicDir,'report.json'),'utf8');await atomicJson(path.join(root,'results/stage5-latest.json'),{schemaVersion:1,directory:runId,reportSha256:sha256(body)});await progress({phase:'complete',summary});return report;
  }finally{boundary.restore();await release();}
}
