import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sha256} from '../src/rag/receipts.mjs';
import {createPrivacyVault} from '../src/rag/privacy.mjs';
import {selectStage5Proposals,prepareStage5Proposal,inspectPrivateFieldMinimization,publicGuardResult,screenStage5Proposal,summarizeStage5,renderStage5Summary,installStage5NetworkBoundary} from '../src/evaluation/stage5-guard.mjs';

const settings={population:'frozen-saved60',localModelId:'gemma3:12b',expectedItems:11,expectedCompanyDocuments:3,expectedAdExports:8};
const safe={kind:'safe',cloudEligible:true};
function fixture(){
  const decisions=[],metadata=[],tokenRows=[],payloads=[];
  for(let i=0;i<11;i++){
    const id='synthetic-'+i,company=i<3,suite=company?'company-rag':'ad-privacy',category=company?'company-data multi-doc':'privacy',prompt=company?'A synthetic policy lookup '+i:`Analyse the safe synthetic campaign ${i}.\n${JSON.stringify({campaigns:[{spend:20}],customer_records:[{name:'Avery Chen',email:'avery@example.invalid',phone:'+61 400 000 001'}],private_account_id:'CANARY-FAKE-'+i})}`;
    const query=company?prompt:`Analyse the safe synthetic campaign ${i}.\n\n${JSON.stringify({campaigns:[{spend:20}]})}`,wire={system:'Answer briefly.',query,context:company?[{chunkId:'chunk-'+i,text:'Synthetic safe source.'}]:[],draft:null},payloadHash=sha256(wire);
    metadata.push({id,suite,category,prompt,safety:safe});decisions.push({id,suite,category,safety:safe,safe:true,accepted:false,population:settings.population,modelId:settings.localModelId});payloads.push({payloadHash,payload:{wire,payloadHash,variant:'question-only'}});
    for(const cloudId of ['gemini','muse-spark'])tokenRows.push({id,population:settings.population,modelId:settings.localModelId,cloudId,inputTokens:50,eligible:true,handedOff:true,accepted:false,variant:'question-only',payloadHash});
  }
  return{decisions,metadata,tokenRows,payloads,settings};
}
const select=data=>selectStage5Proposals(data);
const permit=()=>({});
const verdict=(classification='safe')=>({modelId:'llama-guard3:8b',text:classification==='safe'?'safe':'unsafe\nS7',classification,safe:classification==='safe',safetyCategories:classification==='safe'?[]:['S7'],wouldRelease:classification==='safe',releasePermit:classification==='safe'?permit():null,tokens:{input:30,output:2,total:32},latencyMs:3});
const prepared=()=>({id:'synthetic',suite:'company-rag',category:'company-data multi-doc',wire:{system:'Short.',query:'Safe question.',context:[],draft:null},input:'safe compiled input',payloadHash:'payloadhash',sourcePayloadHash:'sourcehash',inputHash:'inputhash',redactionsApplied:0,newRedactionsByType:{EMAIL:0,PHONE:0,NAME:0,SECRET:0},preexistingPlaceholderOccurrences:0,preexistingPlaceholdersByType:{EMAIL:0,PHONE:0,NAME:0,SECRET:0},privateFieldsExcluded:0,privateScalarValuesExcluded:0,minimizationVerified:true});
async function vaultTest(run){const dir=await mkdtemp(path.join(os.tmpdir(),'handoff-stage5-guard-'));try{return await run(await createPrivacyVault(dir));}finally{await rm(dir,{recursive:true,force:true});}}

test('the exact frozen 3-document/8-ad proposal slice is selected independently of cloud provider',()=>{
  const data=fixture(),rows=select(data);assert.equal(rows.length,11);assert.equal(new Set(rows.map(row=>row.id)).size,11);assert.equal(rows.filter(row=>row.suite==='company-rag').length,3);
  for(const patch of [{safety:{kind:'harmful',cloudEligible:true}},{harmful:true},{suite:'gpqa'},{category:'unknown'}]){const bad=fixture();Object.assign(bad.metadata[0],patch);assert.throws(()=>select(bad),/trusted safe/);}
  const bad=fixture();bad.decisions.push(bad.decisions[0]);assert.throws(()=>select(bad),/incomplete|Duplicate/);
});
test('saved wire hashes, provider identity and no-draft allowlist are required',()=>{
  const changed=fixture();changed.payloads[0].payload.wire.query+=' changed';assert.throws(()=>select(changed),/unchanged/);
  const providers=fixture();providers.tokenRows[0].payloadHash='another';assert.throws(()=>select(providers),/identity/);
  const draft=fixture();draft.payloads[0].payload.wire.draft='A local draft';assert.throws(()=>select(draft),/draft-free/);
});
test('local re-redaction records new and existing occurrences without exposing originals',()=>vaultTest(async vault=>{
  const p=select(fixture())[0];p.wire={...p.wire,query:'Contact: avery@example.invalid'};
  const result=prepareStage5Proposal(p,vault);assert.equal(result.redactionsApplied,1);assert.equal(result.newRedactionsByType.EMAIL,1);assert.equal(result.preexistingPlaceholderOccurrences,0);assert.doesNotMatch(result.input,/avery@example\.invalid/);
  const again=prepareStage5Proposal({...p,wire:result.wire},vault);assert.equal(again.redactionsApplied,0);assert.equal(again.preexistingPlaceholderOccurrences,1);assert.equal(again.preexistingPlaceholdersByType.EMAIL,1);
}));
test('earlier ad minimization is verified separately from zero new PII replacements',()=>vaultTest(async vault=>{
  const proposals=select(fixture()),rows=proposals.map(row=>prepareStage5Proposal(row,vault));
  assert.equal(rows.filter(row=>row.privateFieldsExcluded>0).length,8);assert.equal(rows.reduce((sum,row)=>sum+row.privateFieldsExcluded,0),16);assert.equal(rows.reduce((sum,row)=>sum+row.privateScalarValuesExcluded,0),32);assert.ok(rows.every(row=>row.redactionsApplied===0));
  assert.throws(()=>inspectPrivateFieldMinimization(proposals[3].item,{...proposals[3].wire,query:'Unverified export'},vault),/minimization/);
}));
test('only an exact valid safe verdict can be released and opaque permits never enter reports',()=>{
  const p=prepared(),good=publicGuardResult(p,verdict());assert.equal(good.wouldRelease,true);assert.equal(good.verdict,'safe');assert.equal(Object.hasOwn(good,'releasePermit'),false);
  for(const patch of [{safe:false},{classification:'invalid'},{text:'safe\nextra text'},{doneReason:'length'},{tokens:{output:40}},{wouldRelease:false}])assert.equal(publicGuardResult(p,{...verdict(),...patch}).wouldRelease,false);
  const blocked=publicGuardResult(p,verdict('unsafe'));assert.equal(blocked.verdict,'unsafe');assert.deepEqual(blocked.safetyCategories,['S7']);assert.equal(blocked.releaseStatus,'blocked_local');
});
test('invalid/unavailable results retry at most three times with backoff then stay blocked',async()=>{
  const delays=[],retries=[];let calls=0;
  const row=await screenStage5Proposal(prepared(),{screen:async()=>{calls++;throw Error('Unavailable');},sleep:async ms=>delays.push(ms),onRetry:async e=>retries.push(e)});
  assert.equal(calls,4);assert.equal(row.attempts,4);assert.equal(row.wouldRelease,false);assert.equal(row.verdict,'unavailable');assert.deepEqual(delays,[1000,2000,4000]);assert.equal(retries.length,3);
  calls=0;const unsafe=await screenStage5Proposal(prepared(),{screen:async()=>{calls++;return verdict('unsafe');},sleep:async()=>{throw Error('Unsafe does not retry');}});assert.equal(calls,1);assert.equal(unsafe.verdict,'unsafe');
  const attempts=[];await screenStage5Proposal(prepared(),{screen:async()=>verdict(),onAttempt:async value=>attempts.push(value)});assert.equal(attempts.length,1);assert.equal(attempts[0].text,'safe');assert.equal(attempts[0].inputHash,'inputhash');assert.equal(Object.hasOwn(attempts[0],'releasePermit'),false);
});
test('network fence permits only pinned local Guard protocol and blocks every cloud/other model',async()=>{
  const original=globalThis.fetch;let forwarded=0;globalThis.fetch=async()=>{forwarded++;return{ok:true};};const fence=installStage5NetworkBoundary();
  const options={method:'POST',body:JSON.stringify({model:'llama-guard3:8b',raw:true,stream:false,keep_alive:-1,options:{temperature:0,seed:20261027,num_ctx:4096,num_predict:40}})};
  try{
    await fetch('http://127.0.0.1:11434/api/generate',options);await fetch('http://localhost:11434/api/tags');assert.equal(forwarded,2);
    for(const url of ['https://api.meta.ai/v1/responses','https://generativelanguage.googleapis.com/v1','http://127.0.0.1:9999/api/generate'])await assert.rejects(fetch(url,options),/denied/);
    await assert.rejects(fetch('http://localhost:11434/api/chat',options),/pinned/);await assert.rejects(fetch('http://localhost:11434/api/generate',{...options,body:options.body.replace('llama-guard3:8b','gemma3:12b')}),/pinned/);
    assert.equal(forwarded,2);assert.equal(fence.status().externalRequests,0);assert.equal(fence.status().guardCalls,1);
  }finally{fence.restore();globalThis.fetch=original;}
});
test('public summaries count safe releases, unsafe blocks and errors honestly with no payload text',()=>{
  const items=[publicGuardResult(prepared(),verdict()),publicGuardResult({...prepared(),id:'unsafe'},verdict('unsafe')),publicGuardResult({...prepared(),id:'error'},{classification:'unavailable',safe:false})],summary=summarizeStage5(items);
  assert.equal(summary.items,3);assert.equal(summary.screened,2);assert.equal(summary.released,1);assert.equal(summary.blocked,2);assert.equal(summary.errors,1);assert.equal(summary.actualCloudCalls,0);
  const report={summary,items,certification:{finiteDevUpperRisk:.036585365853658534,auditOnlyUpperRisk:.15789473684210525}},text=renderStage5Summary(report);assert.match(text,/Zero cloud calls/);assert.match(text,/not delivered/);assert.match(text,/3\.66%/);assert.doesNotMatch(text,/safe compiled input|Safe question/);
});
