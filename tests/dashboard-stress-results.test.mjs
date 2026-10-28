import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readStage6Results} from '../dashboard/server/stage6-results.mjs';

const hash=text=>createHash('sha256').update(text).digest('hex');
async function fixture(t,run){const base=await mkdtemp(path.join(os.tmpdir(),'handoff-stress-api-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(base)),path.resolve(os.tmpdir()));assert.ok(path.basename(base).startsWith('handoff-stress-api-'));await rm(base,{recursive:true,force:true});});await mkdir(path.join(base,'study'));return run(base);}
const metric=(changes={})=>({id:'attacks',area:'attacks',label:'Attacks blocked',n:10,events:8,rate:.8,wilson95:[.49,.94],errors:0,...changes});
const report=()=>({schemaVersion:1,kind:'stage6-guard-stress-report',runId:'study',tier:0,cloudCalls:0,modelAnswerCalls:0,spendUsd:0,guardModelId:'llama-guard3:8b',metrics:[metric()],failuresByArea:{attacks:[{id:'attack-fixture',category:'S1',hash:'a'.repeat(64)}]}});
async function publish(base,value){const text=JSON.stringify(value);await writeFile(path.join(base,'study/report.json'),text);await writeFile(path.join(base,'stage6-latest.json'),JSON.stringify({schemaVersion:1,directory:'study',reportSha256:hash(text)}));}

test('stress loader preserves measured counts and missing intervals without network calls',t=>fixture(t,async base=>{
  assert.equal(await readStage6Results({resultsDir:base}),null);const value=report();value.metrics.push(metric({id:'pending',n:0,events:0,rate:null,wilson95:null}));await publish(base,value);
  const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('No network allowed');};try{const loaded=await readStage6Results({resultsDir:base});assert.equal(loaded.metrics[0].rate,.8);assert.equal(loaded.metrics[1].rate,null);assert.equal(loaded.cloudCalls,0);assert.equal(loaded.readiness,null);}finally{globalThis.fetch=original;}
}));
test('stress loader confines its pointer and requires the content hash',t=>fixture(t,async base=>{
  await writeFile(path.join(base,'stage6-latest.json'),JSON.stringify({schemaVersion:1,directory:'../private',reportSha256:'a'.repeat(64)}));await assert.rejects(readStage6Results({resultsDir:base}),/reference/);
  await publish(base,report());await writeFile(path.join(base,'study/report.json'),'{}');await assert.rejects(readStage6Results({resultsDir:base}),/hash mismatch/);
}));
test('stress loader rejects nonlocal execution and inconsistent statistical counts',t=>fixture(t,async base=>{
  for(const changes of [{cloudCalls:1},{modelAnswerCalls:1},{spendUsd:1},{tier:1},{kind:'raw-attacks'},{runId:'different'}]){await publish(base,{...report(),...changes});await assert.rejects(readStage6Results({resultsDir:base}),/Unsupported/);}
  for(const changes of [{events:11},{rate:.9},{wilson95:[.9,.1]},{n:0,events:0,rate:0,wilson95:null}]){const value=report();value.metrics=[metric(changes)];await publish(base,value);await assert.rejects(readStage6Results({resultsDir:base}),/metric counts|rates|pending/);}
  const duplicate=report();duplicate.metrics.push(metric());await publish(base,duplicate);await assert.rejects(readStage6Results({resultsDir:base}),/Duplicate/);
}));
test('stress publisher exposes only category ID and hash failures, never item contents',t=>fixture(t,async base=>{
  const value=report();value.items=[{prompt:'PRIVATE_A',output:'PRIVATE_B'}];value.payloads=[{input:'PRIVATE_C'}];value.metrics[0].prompt='PRIVATE_D';value.summary={count:2,prompt:'PRIVATE_E'};
  value.failuresByArea.attacks=Array.from({length:8},(_,index)=>({id:`failure-${index}`,category:'S1',hash:'b'.repeat(64),prompt:'PRIVATE_F',text:'PRIVATE_G',rawGuard:'PRIVATE_H'}));
  value.sources=[{id:'source',licence:'MIT',prompt:'PRIVATE_I'}];await publish(base,value);const loaded=await readStage6Results({resultsDir:base});assert.doesNotMatch(JSON.stringify(loaded),/PRIVATE_[A-I]/);assert.equal(loaded.failuresByArea.attacks.length,5);assert.deepEqual(Object.keys(loaded.failuresByArea.attacks[0]).sort(),['category','hash','id']);assert.equal(loaded.items,undefined);
}));
test('readiness keeps nonzero reasoning cost and rejects sent runs or missing checks',t=>fixture(t,async base=>{
  const value=report();value.readiness={schemaVersion:1,kind:'stage6-live-readiness',tier:0,dryRun:true,runId:'study',preparedItems:11,cloudCalls:0,spendUsd:0,projectedCostUsd:.02,reservedUpperUsd:.04,tokens:{input:100,visibleOutput:200,reasoning:300,total:600},checks:[{id:'parser',label:'Nonempty Responses parser',pass:true,detail:'Mocked reasoning-heavy response.',prompt:'PRIVATE_READY'}],raw:{content:'PRIVATE_READY'}};
  await publish(base,value);let loaded=await readStage6Results({resultsDir:base});assert.equal(loaded.readiness.tokens.reasoning,300);assert.equal(loaded.readiness.projectedCostUsd,.02);assert.doesNotMatch(JSON.stringify(loaded),/PRIVATE_READY/);
  for(const changes of [{cloudCalls:1},{spendUsd:1},{runId:'stale'},{kind:'different'},{dryRun:false},{checks:null},{tokens:{reasoning:{raw:'PRIVATE'}}},{checks:[{id:'bad',label:'Bad',pass:'yes'}]}]){await publish(base,{...value,readiness:{...value.readiness,...changes}});await assert.rejects(readStage6Results({resultsDir:base}),/readiness/);}
}));
test('stress metadata cannot smuggle nested private contents through descriptive fields',t=>fixture(t,async base=>{
  for(const changes of [{notes:[{rawGuard:'PRIVATE'}]},{limitations:[{payload:'PRIVATE'}]},{sources:[{name:{prompt:'PRIVATE'}}]},{metrics:[metric({definition:{rawGuard:'PRIVATE'}})]}]){await publish(base,{...report(),...changes});await assert.rejects(readStage6Results({resultsDir:base}),/metadata|metric counts/);}
}));
