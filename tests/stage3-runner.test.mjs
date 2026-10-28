import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {assertStage3BudgetUnset,assertLockedReplay,replayAfterPolicyLock,decorateAcceptance,projectableRow} from '../src/comparison/stage3.mjs';
import {sha256} from '../src/rag/receipts.mjs';
import {generateLocalAnswer} from '../src/comparison/local-answer.mjs';

test('Stage 3 leaves the cloud budget absent, even zero is rejected',()=>{
  assert.doesNotThrow(()=>assertStage3BudgetUnset({}));
  for(const value of ['0','1','',0])assert.throws(()=>assertStage3BudgetUnset({CLOUD_BUDGET_USD:value}),/remain unset/);
});
test('committed dev manifest and runtime use the same canonical settings hash',async()=>{
  const settings=JSON.parse(await readFile(new URL('../config/stage3.json',import.meta.url),'utf8')),manifest=JSON.parse(await readFile(new URL('../tasks/comparison/stage3-manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.settingsHash,sha256(settings));assert.equal(manifest.devTrainIDs.length,820);assert.equal(new Set(manifest.devTrainIDs).size,820);
  assert.equal(sha256([...manifest.devTrainIDs].sort()),manifest.partition.devIdsHash);
});
test('saved test loader cannot run before a durable unchanged dev policy lock',async()=>{
  const dir=await mkdtemp(path.join(os.tmpdir(),'handoff-stage3-'));
  try{
    const lockFile=path.join(dir,'lock.json'),calibration={thresholds:{company:.1,general:0}},lock={lockedAt:'fixed-time',policyHash:sha256(calibration),sourceHash:'source',partitionHash:'partition'};let opened=0;
    const options={lockFile,calibration,sourceHash:'source',partitionHash:'partition',loadReplay:async()=>{opened++;return 'saved-answers';}};
    await assert.rejects(replayAfterPolicyLock(options));assert.equal(opened,0);
    await writeFile(lockFile,JSON.stringify({...lock,policyHash:'other'}));await assert.rejects(replayAfterPolicyLock(options),/unchanged/);assert.equal(opened,0);
    await writeFile(lockFile,JSON.stringify(lock));assert.equal(await replayAfterPolicyLock(options),'saved-answers');assert.equal(opened,1);
    await assert.rejects(replayAfterPolicyLock({...options,loadReplay:async()=>{await writeFile(lockFile,JSON.stringify({...lock,lockedAt:'changed'}));}}),/changed/);
    assert.throws(()=>assertLockedReplay(lock,{thresholds:{company:.2,general:0}}),/unchanged/);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('two local steps feed real hard gates; reference changes cannot alter the runtime features',async()=>{
  const item={id:'company-test',groupId:'one',suite:'company-rag',category:'company-data single-doc',safety:{kind:'safe',cloudEligible:true}},prepared={question:'What is the weight?',retrievalScore:.9,completeness:{score:1},chunks:[{chunkId:'product-one',file:'product.md',hash:'hash',text:'The weight is 2 kg.'}]};let calls=0;
  const generated=await generateLocalAnswer('llama3.1:8b',prepared,{item,answerMaxTokens:768,requireClaimCitations:true,dependencies:{call:async(model,messages,options)=>{
    calls++;assert.equal(options.maxTokens,calls===1?768:128);
    return{modelId:model,text:JSON.stringify(calls===1?{claims:[{text:'The weight is 2 kg.',citations:['product-one']}]}:{confidence:.95,evidenceSupported:true,answerComplete:true,issues:[]}),tokens:{input:100,output:40},settings:{maxTokens:options.maxTokens},latencyMs:1};
  }}});
  const row={modelId:'llama3.1:8b',answer:generated.answer,rawAnswer:generated.rawAnswer,rawCheck:generated.rawCheck},decorated=decorateAcceptance(item,row,prepared,{role:'calib',population:'dev-calib'});
  assert.equal(calls,2);assert.equal(decorated.gate.eligible,true);
  const changed=decorateAcceptance({...item,reference:{answer:'WRONG_SECRET'}},{...row,scoring:{score:0}},prepared,{role:'calib',population:'dev-calib'});
  assert.deepEqual(changed.gate,decorated.gate);assert.deepEqual(changed.features,decorated.features);
  const truncated=decorateAcceptance(item,{...row,rawAnswer:{...row.rawAnswer,doneReason:'length'}},prepared);assert.equal(truncated.gate.eligible,false);
  const unsafe={...item,suite:'strongreject',safety:{kind:'harmful',cloudEligible:false}},blocked=decorateAcceptance(unsafe,row,prepared);assert.equal(blocked.gate.localOnly,true);assert.equal(projectableRow(blocked,unsafe,prepared).item.safety.kind,'harmful');
});
