import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {askRag as askRagActual} from '../src/rag/gateway.mjs';
import {questionBoundaryFixture} from './helpers/question-boundary.mjs';
import {ragConfig,screenForCloud,assertCloudRelease,callMuse,guardText} from '../src/server/gateway-models.mjs';
import {sha256} from '../src/rag/receipts.mjs';
import {LOCKED_POLICY_HASH} from '../src/rag/locked-routing.mjs';

const askRag=(question,options)=>askRagActual(question,{...options,dependencies:{...questionBoundaryFixture(),...options?.dependencies}});

async function directory(t){const p=await mkdtemp(path.join(os.tmpdir(),'handoff-flag-test-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(p)),path.resolve(os.tmpdir()));assert.ok(path.basename(p).startsWith('handoff-flag-test-'));await rm(p,{recursive:true,force:true});});return p;}
function liveAccess(t){for(const [key,value]of [['META_ACCESS_STATUS','live'],['HANDOFF_META_ACCESS_CONFIRMED','true']]){const before=process.env[key];process.env[key]=value;t.after(()=>{if(before===undefined)delete process.env[key];else process.env[key]=before;});}}
const chunks=[{chunkId:'product-one',file:'products/af100.md',text:'AF100 synthetic unit price is AUD 1.00.',score:.9},{chunkId:'shipping-one',file:'policies/shipping.md',text:'Synthetic standard shipping is AUD 35.',score:.8}].map(chunk=>({...chunk,hash:sha256(chunk.text)}));
const retrieve=async()=>({chunks,quality:.9,bestMatchScore:.9,latencyMs:1,embeddingModel:'synthetic-embedding',completeness:{score:1,requiredSources:chunks.map(c=>c.file),missingFacets:[]},queryPlan:{entities:['AF100'],requiredFacets:[{id:'product:AF100',kind:'product',sourceFiles:['products/af100.md']},{id:'shipping-policy',kind:'policy',sourceFiles:['policies/shipping.md']}]}});
const guard=safe=>({modelId:'synthetic-guard',safe,classification:safe?'safe':'unsafe',safetyCategories:safe?[]:['S7'],tokens:{input:20,output:1,total:21},latencyMs:1});
const local=(calls,confidence=.95)=>async(model,messages,options)=>{calls.push({model,messages,options});const check=Boolean(options.schema?.properties?.confidence);return{modelId:model,latencyMs:1,tokens:{input:50,output:25,total:75},settings:{maxTokens:options.maxTokens},doneReason:'stop',text:JSON.stringify(check?{confidence,evidenceSupported:true,answerComplete:true,issues:[]}:{claims:[{text:'The synthetic AF100 unit price is AUD 1.00.',citations:['product-one']}]})};};
const computed=()=>({status:'computed',arithmeticIntent:'subtotal',toolId:'deterministic-local-calculator',sourceChunkIds:chunks.map(c=>c.chunkId),calculations:[{result:2,sourceChunkIds:chunks.map(c=>c.chunkId),operands:[{value:1,sourceChunkIds:['product-one']},{value:2,origin:'question',sourceChunkIds:[]}]}],claims:[{text:'The subtotal for two synthetic AF100 products is AUD 2.00.',sourceChunkIds:chunks.map(c=>c.chunkId)}],latencyMs:1});
const countTokens=text=>Buffer.byteLength(text,'utf8');

test('the flag is off by default and omitted/false retains the previous Llama answer route',async t=>{
  assert.equal(ragConfig.lockedCompanyRoutingEnabled,false);assert.equal(ragConfig.localModel,'llama3.1:8b');
  const summaries=[];
  for(const options of [{},{lockedCompanyRouting:false}]){
    const calls=[];const result=await askRag('What is our synthetic AF100 product price?',{...options,dataDir:await directory(t),dependencies:{retrieve,countTokens,calculateLocal:async()=>({status:'not_applicable'}),localChat:local(calls),guardText:async()=>{throw Error('A local answer should not invoke Guard');},callMuse:async()=>{throw Error('Cloud is forbidden');}}});
    assert.equal(calls.length,2);assert.ok(calls.every(c=>c.model==='llama3.1:8b'));assert.equal(result.route,'local');assert.equal(result.lockedCompanyRoutingEnabled,false);summaries.push({answer:result.answer,route:result.route,confidence:result.confidence,citations:result.citations,outbound:result.outbound});
  }
  assert.deepEqual(summaries[0],summaries[1]);
});
test('flag on uses Gemma 12B and accepts a sourced tool answer only under the locked company threshold',async t=>{
  const calls=[];let guardCalls=0,cloudCalls=0;
  const result=await askRag('Calculate our AF100 product subtotal.',{dataDir:await directory(t),lockedCompanyRouting:true,dependencies:{retrieve,countTokens,calculateLocal:async()=>computed(),localChat:local(calls),guardText:async()=>{guardCalls++;return guard(true);},callMuse:async()=>{cloudCalls++;throw Error('A qualified answer must stay local');}}});
  assert.equal(calls.length,1);assert.equal(calls[0].model,'gemma3:12b');assert.equal(calls[0].options.maxTokens,128);assert.equal(result.route,'local');assert.equal(result.localModelId,'gemma3:12b');assert.equal(result.metrics.lockedPolicyHash,LOCKED_POLICY_HASH);assert.equal(result.metrics.lockedRouting.threshold,.03753558978644436);assert.ok(result.metrics.lockedRouting.predictedWrongness<result.metrics.lockedRouting.threshold);assert.equal(result.metrics.lockedRouting.futureCertified,false);assert.equal(guardCalls,0);assert.equal(cloudCalls,0);
});
test('a confident company answer above the locked risk threshold escalates through Guard without forwarding its draft',async t=>{
  const calls=[],inputs=[];let cloudCalls=0;
  const result=await askRag('What is our synthetic AF100 product price?',{dataDir:await directory(t),lockedCompanyRouting:true,offlineMeta:true,dependencies:{retrieve,countTokens,calculateLocal:async()=>({status:'not_applicable'}),localChat:local(calls,.99),guardText:async input=>{inputs.push(input);return guard(true);},callMuse:async()=>{cloudCalls++;throw Error('Dry run cannot call cloud');}}});
  assert.equal(calls.length,2);assert.ok(calls.every(c=>c.model==='gemma3:12b'));assert.equal(result.route,'deferred_cloud');assert.equal(inputs.length,1);assert.equal(result.metrics.wouldReleaseToCloud,true);assert.equal(result.metrics.localDraftSent,false);assert.equal(result.metrics.handoffVariant,'general-question-only');assert.ok(result.metrics.lockedRouting.predictedWrongness>=result.metrics.lockedRouting.threshold);assert.equal(cloudCalls,0);assert.equal(result.receipt.payload.actualChunksSent,0);
  const wire=JSON.parse(inputs[0]);assert.deepEqual(Object.keys(wire).sort(),['question','system']);assert.doesNotMatch(wire.question,/Draft \(unverified\)/);assert.equal(wire.question.includes('The synthetic AF100 unit price is AUD 1.00.'),false);
});
test('flag-on general questions skip local draft generation, redact PII, and do not send unrelated company chunks',async t=>{
  let models=0,cloudCalls=0;const inputs=[];
  const result=await askRag('Explain binary search. Email: private-person@example.invalid',{dataDir:await directory(t),lockedCompanyRouting:true,offlineMeta:true,dependencies:{retrieve,countTokens,calculateLocal:async()=>{throw Error('General task must not call a company calculator');},localChat:async()=>{models++;throw Error('The general policy abstains without a draft');},guardText:async input=>{inputs.push(input);return guard(true);},callMuse:async()=>{cloudCalls++;throw Error('Cloud is forbidden');}}});
  assert.equal(models,0);assert.equal(cloudCalls,0);assert.equal(result.route,'deferred_cloud');assert.equal(result.metrics.generationSkipped,true);assert.equal(result.localModelId,'code-policy-abstention');assert.equal(result.outbound.chunks.length,0);assert.equal(inputs.length,1);assert.doesNotMatch(inputs[0],/private-person@example\.invalid|unit price|shipping is/);assert.equal(inputs[0].includes('PII_EMAIL_'),false);assert.equal(result.metrics.piiItemsRedacted,1);
});
test('unsafe, invalid or inconsistent Guard verdicts cannot reach any cloud dependency even with live access flags',async t=>{
  liveAccess(t);
  for(const verdict of [{...guard(false)},{...guard(true),classification:'invalid'},{...guard(true),classification:'unsafe'},{...guard(false),classification:'safe'}]){
    let cloudCalls=0;
    const result=await askRag('Explain binary search.',{dataDir:await directory(t),lockedCompanyRouting:true,offlineMeta:false,dependencies:{retrieve,countTokens,guardText:async()=>verdict,callMuse:async()=>{cloudCalls++;throw Error('Blocked input must never reach cloud');}}});
    assert.equal(cloudCalls,0);assert.equal(result.route,'blocked_local');assert.equal(result.metrics.wouldReleaseToCloud,false);assert.equal(result.metrics.tokensSentToCloud,0);assert.deepEqual(result.outbound,{question:'',chunks:[]});
  }
});
test('trusted adversarial metadata remains local before payload preparation regardless of a permissive Guard',async t=>{
  liveAccess(t);let guardCalls=0,cloudCalls=0,modelCalls=0;
  const result=await askRag('Synthetic local-only boundary test.',{dataDir:await directory(t),lockedCompanyRouting:true,offlineMeta:false,task:{id:'known-adversarial',category:'company-data multi-doc',suite:'strongreject',safety:{kind:'harmful',cloudEligible:false}},dependencies:{retrieve,countTokens,localChat:async()=>{modelCalls++;throw Error('Code should refuse this task');},guardText:async()=>{guardCalls++;return guard(true);},callMuse:async()=>{cloudCalls++;throw Error('Harmful item must remain local');}}});
  assert.equal(result.route,'blocked_local');assert.equal(modelCalls,0);assert.equal(guardCalls,0);assert.equal(cloudCalls,0);assert.equal(result.receipt,undefined);assert.deepEqual(result.outbound,{question:'',chunks:[]});
});
test('flag-off trusted adversarial metadata prevents any handoff even when the local answer abstains and Guard would pass',async t=>{
  liveAccess(t);const calls=[];let guardCalls=0,cloudCalls=0;
  const result=await askRag('Synthetic local-only boundary test.',{dataDir:await directory(t),lockedCompanyRouting:false,offlineMeta:false,task:{id:'known-adversarial-legacy',category:'company-data multi-doc',suite:'strongreject',safety:{kind:'harmful',cloudEligible:false}},dependencies:{retrieve,countTokens,calculateLocal:async()=>({status:'not_applicable'}),localChat:local(calls,.1),guardText:async()=>{guardCalls++;return guard(true);},callMuse:async()=>{cloudCalls++;throw Error('Harmful item must remain local with the flag off');}}});
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.model==='llama3.1:8b'));assert.notEqual(result.route,'cloud');assert.equal(guardCalls,0);assert.equal(cloudCalls,0);assert.equal(result.receipt,undefined);assert.equal(result.metrics.tokensSentToCloud,0);assert.deepEqual(result.outbound,{question:'',chunks:[]});
});

test('cloud permits require exact safe classification and bind a single release to immutable redacted bytes',async t=>{
  const input='Synthetic redacted safe request.';
  for(const verdict of [{safe:true},{safe:true,classification:'invalid'},{safe:false,classification:'safe'}]){const blocked=await screenForCloud(input,{guard:async()=>verdict});assert.equal(blocked.wouldRelease,false);assert.equal(blocked.releasePermit,null);}
  const screened=await screenForCloud(input,{guard:async()=>guard(true)});assert.equal(screened.wouldRelease,true);assert.equal(screened.inputHash,sha256(input));assert.throws(()=>assertCloudRelease(input,{}),/Guard pass/);assert.throws(()=>assertCloudRelease(input+' altered',screened.releasePermit),/Guard pass/);assert.equal(assertCloudRelease(input,screened.releasePermit),true);assert.throws(()=>assertCloudRelease(input,screened.releasePermit),/Guard pass/);
  let guardCalls=0;await assert.rejects(screenForCloud('Email: raw@example.invalid',{guard:async()=>{guardCalls++;return guard(true);}}),/private-field/);assert.equal(guardCalls,0);
  liveAccess(t);let network=0;t.mock.method(globalThis,'fetch',async()=>{network++;throw Error('No actual network allowed');});await assert.rejects(callMuse(input,{offlineMeta:false,releasePermit:{}}),/Guard pass/);assert.equal(network,0);
});
test('the raw Guard transport marks truncated safe output invalid and extracts unsafe categories',async t=>{
  const cases=[{response:'safe',eval_count:40,done_reason:'length'},{response:'unsafe\nS7, S8',eval_count:5,done_reason:'stop'}];let count=0;
  t.mock.method(globalThis,'fetch',async()=>new Response(JSON.stringify({...cases[count++],prompt_eval_count:20}),{headers:{'Content-Type':'application/json'}}));
  const truncated=await guardText('Synthetic safe question.');assert.equal(truncated.safe,false);assert.equal(truncated.classification,'invalid');
  const unsafe=await guardText('Synthetic local-only test.');assert.equal(unsafe.safe,false);assert.equal(unsafe.classification,'unsafe');assert.deepEqual(unsafe.safetyCategories,['S7','S8']);
});
