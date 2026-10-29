import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareQuestionOnly,screenQuestionOnly,buildQuestionOnlyPayload,rehydratePrepared} from '../src/privacy/question-boundary.mjs';
import {callLensModel} from '../src/server/privacy-models.mjs';
import {sha256} from '../src/rag/receipts.mjs';
import {stage6fRecordScope,stage6fInvocationIdentity,stage6fTransportOptions} from '../src/evaluation/stage6f-cache.mjs';
import {privacyDependencies} from './helpers/question-boundary.mjs';

const question='How can someone compare supplier prices for a private record?';
const task='Given a private record, compare supplier prices.';
const item=(id,email='scope-one@example.invalid')=>({id,content:JSON.stringify({task,records:[{email}]}),safety:{kind:'safe',cloudEligible:true}});
async function fixture(t,{answer=question,refuse=false}={}){
  const dataDir=await mkdtemp(path.join(os.tmpdir(),'handoff-record-scope-'));
  t.after(()=>rm(dataDir,{recursive:true,force:true}));
  const dependencies=privacyDependencies({question:answer}),base=dependencies.localCall,calls=[];
  dependencies.keyDirectory=path.join(dataDir,'keys');
  dependencies.localCall=async(lens,messages,options)=>{
    if(options.schema.properties.generalizable){
      calls.push({lens,messages:structuredClone(messages),options});
      assert.equal(Object.isFrozen(options),true);
      assert.match(options.cacheScope,/^[a-f0-9]{64}$/);
    }
    const result=await base(lens,messages,options);
    if(refuse&&options.schema.properties.generalizable)result.text=JSON.stringify({question:'How can this local request be assessed?',generalizable:false});
    return result;
  };
  return{dataDir,dependencies,calls};
}

test('identical normalized tasks retain identical model messages while distinct records get distinct rewrite scopes',async t=>{
  const options=await fixture(t),first=await prepareQuestionOnly(item('record-one'),options),second=await prepareQuestionOnly(item('record-two'),options);
  assert.equal(first.baseBlocked,false);assert.equal(second.baseBlocked,false);
  assert.equal(options.calls.length,2);assert.notEqual(options.calls[0].options.cacheScope,options.calls[1].options.cacheScope);
  assert.deepEqual(options.calls[0].messages,options.calls[1].messages);
  assert.equal(first.question,second.question);assert.equal(first.intentFrameHash,second.intentFrameHash);
  for(const call of options.calls){const serialized=JSON.stringify(call.messages);assert.doesNotMatch(serialized,/scope-one@example\.invalid|record-one|record-two|cacheScope/);assert.equal(serialized.includes(call.options.cacheScope),false);}
  assert.equal(buildQuestionOnlyPayload(first.question),buildQuestionOnlyPayload(second.question));
});

test('record scope is stable for resume and changes when source or lens changes',async t=>{
  const options=await fixture(t),source=item('stable-record');
  await prepareQuestionOnly(source,options);await prepareQuestionOnly(structuredClone(source),options);
  await prepareQuestionOnly(item('stable-record','scope-two@example.invalid'),options);
  await prepareQuestionOnly(source,{...options,lens:'google'});
  const scopes=options.calls.map(call=>call.options.cacheScope);
  assert.equal(scopes[0],scopes[1]);assert.notEqual(scopes[0],scopes[2]);assert.notEqual(scopes[0],scopes[3]);
  assert.deepEqual(options.calls[0].messages,options.calls[2].messages);
});

test('the actual local adapter makes separate record requests and resumes only the finished record, without sending cache metadata',async t=>{
  const options=await fixture(t),fallback=options.dependencies.localCall,cache=new Map(),transport=[];let activeScope;
  t.mock.method(globalThis,'fetch',async(url,request)=>{
    const parsed=new URL(url);assert.ok(['localhost','127.0.0.1','[::1]'].includes(parsed.hostname));assert.equal(parsed.pathname,'/api/chat');
    transport.push(JSON.parse(request.body));
    return new Response(JSON.stringify({message:{content:JSON.stringify({question,generalizable:true})},done_reason:'stop',prompt_eval_count:20,eval_count:20}),{headers:{'content-type':'application/json'}});
  });
  options.dependencies.localCall=async(lens,messages,localOptions)=>{
    if(!localOptions.schema.properties.generalizable)return fallback(lens,messages,localOptions);
    const callHash=stage6fInvocationIdentity(activeScope,lens,messages,localOptions),saved=cache.get(callHash);
    if(saved)return{...saved,evaluationReused:true,evaluationCallHash:callHash};
    const providerOptions=stage6fTransportOptions(localOptions);assert.equal(Object.hasOwn(providerOptions,'cacheScope'),false);
    const result=await callLensModel(lens,messages,providerOptions);cache.set(callHash,result);return{...result,evaluationReused:false,evaluationCallHash:callHash};
  };
  const run=async record=>{activeScope=stage6fRecordScope({phase:'prepared',itemId:record.id,lens:'meta',sourceHash:sha256(record.content)});return prepareQuestionOnly(record,options);};
  const first=await run(item('transport-one')),second=await run(item('transport-two')),resumed=await run(item('transport-one'));
  assert.equal(transport.length,2);assert.deepEqual(transport[0],transport[1]);
  for(const prepared of [first,second,resumed])assert.equal(prepared.baseBlocked,false);
  const attempt=prepared=>prepared.stages.find(row=>row.layerId==='rewrite').attempts[0];
  assert.equal(attempt(first).reused,false);assert.equal(attempt(second).reused,false);assert.equal(attempt(resumed).reused,true);
  assert.notEqual(attempt(first).callHash,attempt(second).callHash);assert.equal(attempt(first).callHash,attempt(resumed).callHash);
  assert.doesNotMatch(JSON.stringify(transport),/cacheScope|transport-one|transport-two|scope-one@example\.invalid/);
  assert.equal(first.question,resumed.question);assert.equal(first.question,second.question);
});

test('record-scoped calls do not alter a valid model refusal or run checks on an empty refused question',async t=>{
  const options=await fixture(t,{refuse:true}),first=await prepareQuestionOnly(item('refusal-one'),options),second=await prepareQuestionOnly(item('refusal-two'),options);
  assert.equal(options.calls.length,2);assert.notEqual(options.calls[0].options.cacheScope,options.calls[1].options.cacheScope);
  for(const prepared of [first,second]){
    assert.equal(prepared.baseBlocked,true);assert.equal(prepared.validatedLocalRefusal,true);assert.equal(prepared.question,'');
    assert.deepEqual(prepared.reasons,['REWRITE_NOT_GENERALIZABLE']);
    assert.equal(prepared.stages.find(row=>row.layerId==='llm_check').status,'NOT_RUN_AFTER_BLOCK');
    assert.equal(prepared.stages.find(row=>row.layerId==='rewrite').attempts.length,1);
  }
  const inputs=[];options.dependencies.promptGuard=async(texts,{variant,inputKind})=>{inputs.push(inputKind);return{status:'PASS',available:true,detected:false,variant,latencyMs:1,windows:1,maxScore:.1,threshold:.5};};
  const screened=await screenQuestionOnly(first,{shadowEvaluation:true,dependencies:options.dependencies});
  assert.equal(screened.hypotheticalBlocked,true);assert.equal(screened.injectionPending,false);assert.equal(screened.liveEligible,false);
  assert.deepEqual(inputs,['original','original']);
  assert.equal(screened.stages.find(row=>row.layerId==='prompt_guard_86m').comparison.rewrite.status,'NOT_RUN_AFTER_BLOCK');
});

test('protocol repair stays within the same immutable record scope and retains the original task',async t=>{
  const options=await fixture(t),base=options.dependencies.localCall;let requests=0;
  options.dependencies.localCall=async(...args)=>{const result=await base(...args);if(args[2].schema.properties.generalizable&&requests++===0)result.text='{';return result;};
  const prepared=await prepareQuestionOnly(item('repair-record'),options);
  assert.equal(prepared.baseBlocked,false);assert.equal(options.calls.length,2);
  assert.equal(options.calls[0].options.cacheScope,options.calls[1].options.cacheScope);
  assert.equal(JSON.parse(options.calls[0].messages.at(-1).content).task,JSON.parse(options.calls[1].messages.at(-1).content).task);
  assert.equal(prepared.stages.find(row=>row.layerId==='rewrite').attempts[0].code,'PRIVACY_LOCAL_INVALID_JSON');
  assert.equal(prepared.stages.find(row=>row.layerId==='rewrite').attempts[0].recovered,true);
});

test('scope is cache metadata only and is absent from non-rewrite model calls',async t=>{
  const options=await fixture(t),base=options.dependencies.localCall;let checks=0;
  options.dependencies.localCall=async(...args)=>{if(!args[2].schema.properties.generalizable){checks++;assert.equal(Object.hasOwn(args[2],'cacheScope'),false);}return base(...args);};
  const prepared=await prepareQuestionOnly(item('check-record'),options);
  assert.equal(prepared.baseBlocked,false);assert.ok(checks>0);assert.equal(Object.hasOwn(prepared,'cacheScope'),false);
  assert.doesNotMatch(buildQuestionOnlyPayload(prepared.question),/cacheScope|check-record|scope-one/);
});

test('method bookkeeping changes without changing the safety models, token caps, seed or disabled dispatch',async()=>{
  const current=JSON.parse(await readFile('config/stage6b.json','utf8'));
  assert.equal(current.method,'question-only-layered-privacy-v7');assert.equal(current.cloudDispatchEnabled,false);
  assert.deepEqual([current.seed,current.temperature,current.keepAlive,current.contextTokens,current.rewriteMaxTokens,current.checkMaxTokens,current.applyMaxTokens,current.maxQuestionCharacters],[20261027,0,-1,4096,512,256,1024,320]);
  assert.equal(current.promptGuard.primaryVariant,'86m');assert.equal(current.promptGuard.threshold,.5);
  assert.deepEqual([current.meta.rewriteModel,current.meta.guardModel,current.google.rewriteModel,current.google.guardModel],['llama3.2:3b','llama-guard3:8b','gemma3:4b','shieldgemma:2b']);
});

test('comparison normalization proof is bound to the prepared private task and cannot be replaced or mutated',async t=>{
  for(const mutate of [prepared=>{prepared.neutralTaskForComparison+=' Another instruction.';},prepared=>{prepared.promptGuardComparisonProof={...prepared.promptGuardComparisonProof};}]){
    const options=await fixture(t),prepared=await prepareQuestionOnly({id:'comparison-proof',prompt:'Compare supplier prices.',safety:{kind:'safe',cloudEligible:true}},options);
    assert.equal(prepared.baseBlocked,false);assert.equal(prepared.rewriteStrategy,'compiled_neutral_request');
    mutate(prepared);const screened=await screenQuestionOnly(prepared,{dependencies:options.dependencies});
    assert.equal(screened.liveEligible,false);assert.equal(screened.releasePermit,null);assert.ok(screened.blockedByLayer.includes('PREPARATION_PROOF_REQUIRED'));
  }
});

test('rehydrated comparison proofs remain local evaluation evidence and never authorize dispatch',async t=>{
  const options=await fixture(t),prepared=await prepareQuestionOnly({id:'comparison-resume',prompt:'Compare supplier prices.',safety:{kind:'safe',cloudEligible:true}},options);
  const snapshot=structuredClone({...prepared,vault:undefined}),resumed=await rehydratePrepared(snapshot,{dataDir:options.dataDir,keyDirectory:options.dependencies.keyDirectory});
  assert.notEqual(resumed.promptGuardComparisonProof,prepared.promptGuardComparisonProof);
  const screened=await screenQuestionOnly(resumed,{shadowEvaluation:true,dependencies:options.dependencies});
  assert.equal(screened.hypotheticalBlocked,false);assert.equal(screened.liveEligible,false);assert.equal(screened.releasePermit,null);
});

test('comparative screening records a mechanically proven rewrite-only flag and still enforces original and harmful verdicts',async t=>{
  const source={id:'comparison-business',prompt:'Compare supplier prices.',suite:'company-rag',category:'company-data single-doc',safety:{kind:'safe',cloudEligible:true}};
  for(const mode of ['rewrite-only','original','harmful']){
    const options=await fixture(t);options.dependencies.promptGuard=async(_texts,{variant,inputKind})=>{const score=mode==='original'?inputKind==='original'?.9:.1:inputKind==='rewrite'?.9:.1;return{status:score>=.5?'BLOCKED':'PASS',available:true,detected:score>=.5,variant,latencyMs:1,windows:1,maxScore:score,threshold:.5};};
    if(mode==='harmful')options.dependencies.harmfulGuard=async()=>({safe:false,classification:'unsafe',latencyMs:1,tokens:{input:1,output:1,total:2}});
    const prepared=await prepareQuestionOnly(source,options),screened=await screenQuestionOnly(prepared,{dependencies:options.dependencies}),primary=screened.stages.find(row=>row.layerId==='prompt_guard_86m');
    assert.equal(primary.comparison.rewriteOnlyFlagCleared,mode!=='original');
    if(mode==='rewrite-only'){assert.equal(primary.status,'PASS');assert.equal(primary.comparison.rewrite.detected,true);assert.equal(screened.hypotheticalBlocked,false);assert.equal(screened.liveEligible,true);}
    else{assert.equal(screened.hypotheticalBlocked,true);assert.equal(screened.liveEligible,false);assert.equal(screened.releasePermit,null);assert.ok(screened.blockedByLayer.includes(mode==='original'?'PROMPT_GUARD_BLOCKED':'HARMFUL_CONTENT'));}
  }
});

test('a model paraphrase cannot use the deterministic normalization exception for a rewrite flag',async t=>{
  const options=await fixture(t);options.dependencies.promptGuard=async(_texts,{variant,inputKind})=>{const score=inputKind==='original'?.1:.9;return{status:score>=.5?'BLOCKED':'PASS',available:true,detected:score>=.5,variant,latencyMs:1,windows:1,maxScore:score,threshold:.5};};
  const prepared=await prepareQuestionOnly(item('comparison-model'),options),screened=await screenQuestionOnly(prepared,{dependencies:options.dependencies});
  assert.equal(prepared.rewriteStrategy,'model_rewrite');assert.equal(screened.liveEligible,false);assert.equal(screened.releasePermit,null);assert.ok(screened.blockedByLayer.includes('PROMPT_GUARD_BLOCKED'));
  assert.equal(screened.stages.find(row=>row.layerId==='prompt_guard_86m').comparison.rewriteOnlyFlagCleared,false);
});

test('registered private replacements bind comparison proof in preparation and resume; removed or stale findings cannot authorize',async t=>{
  const options=await fixture(t),source={id:'registered-finding',prompt:'Compare supplier prices for scope-recognized@example.invalid.',suite:'company-rag',category:'company-data single-doc',safety:{kind:'safe',cloudEligible:true}};
  options.dependencies.promptGuard=async(_texts,{variant,inputKind})=>{const score=inputKind==='original'?.1:.9;return{status:score>=.5?'BLOCKED':'PASS',available:true,detected:score>=.5,variant,latencyMs:1,windows:1,maxScore:score,threshold:.5};};
  const prepared=await prepareQuestionOnly(source,options),primary=result=>result.stages.find(row=>row.layerId==='prompt_guard_86m');
  assert.equal(prepared.baseBlocked,false);assert.equal(prepared.rewriteStrategy,'compiled_neutral_request');assert.match(prepared.question,/\[EMAIL\]/);
  assert.ok(prepared.privateValues.some(row=>row.type==='EMAIL'&&row.value==='scope-recognized@example.invalid'));
  const screened=await screenQuestionOnly(prepared,{dependencies:options.dependencies});
  assert.equal(screened.liveEligible,true);assert.equal(primary(screened).comparison.proofKind,'compiled');assert.equal(primary(screened).comparison.rewriteOnlyFlagCleared,true);
  const snapshot=structuredClone({...prepared,vault:undefined}),resumed=await rehydratePrepared(snapshot,{dataDir:options.dataDir,keyDirectory:options.dependencies.keyDirectory});
  const resumedResult=await screenQuestionOnly(resumed,{shadowEvaluation:true,dependencies:options.dependencies});
  assert.equal(primary(resumedResult).comparison.rewriteOnlyFlagCleared,true);assert.equal(resumedResult.hypotheticalBlocked,false);assert.equal(resumedResult.liveEligible,false);assert.equal(resumedResult.releasePermit,null);
  prepared.privateValues=[];const removed=await screenQuestionOnly(prepared,{dependencies:options.dependencies});
  assert.equal(removed.liveEligible,false);assert.equal(removed.releasePermit,null);assert.ok(removed.blockedByLayer.includes('PREPARATION_PROOF_REQUIRED'));
  for(const privateValues of [[],[{type:'EMAIL',value:'different-registered@example.invalid'}]]){
    const stale=await rehydratePrepared({...snapshot,privateValues},{dataDir:options.dataDir,keyDirectory:options.dependencies.keyDirectory}),result=await screenQuestionOnly(stale,{shadowEvaluation:true,dependencies:options.dependencies});
    assert.equal(primary(result).comparison.proofKind,'unproved');assert.equal(primary(result).comparison.rewriteOnlyFlagCleared,false);assert.ok(result.blockedByLayer.includes('PROMPT_GUARD_BLOCKED'));assert.equal(result.liveEligible,false);assert.equal(result.releasePermit,null);
  }
});
