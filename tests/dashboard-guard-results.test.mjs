import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readStage5Results} from '../dashboard/server/stage5-results.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
async function fixture(run){const base=await mkdtemp(path.join(os.tmpdir(),'handoff-guard-api-'));try{await mkdir(path.join(base,'study'));return await run(base);}finally{await rm(base,{recursive:true,force:true});}}
const report=()=>({schemaVersion:1,kind:'stage5-guard-report',runId:'study',tier:0,dryRun:true,cloudCalls:0,modelAnswerCalls:0,spendUsd:0,summary:{items:1,screened:1,released:1,blocked:0,redactionsApplied:0},items:[{id:'fake-one',verdict:'safe',safetyCategories:[],screened:true,wouldRelease:true,releaseStatus:'would_release',redactionsApplied:0}],certification:{finiteDevUpperRisk:3/82,futureCertified:false}});
async function publish(base,value){const text=JSON.stringify(value);await writeFile(path.join(base,'study/report.json'),text);await writeFile(path.join(base,'stage5-latest.json'),JSON.stringify({schemaVersion:1,directory:'study',reportSha256:hash(text)}));}
test('Guard loader preserves real verdicts and measured zeros without network calls',()=>fixture(async base=>{
  assert.equal(await readStage5Results({resultsDir:base}),null);await publish(base,report());
  const original=globalThis.fetch;globalThis.fetch=()=>{throw Error('No network allowed');};try{const value=await readStage5Results({resultsDir:base});assert.equal(value.summary.screened,1);assert.equal(value.summary.redactionsApplied,0);assert.equal(value.items[0].wouldRelease,true);assert.equal(value.cloudCalls,0);}finally{globalThis.fetch=original;}
}));
test('Guard loader confines its reference, requires the content hash and rejects cloud-call reports',()=>fixture(async base=>{
  await writeFile(path.join(base,'stage5-latest.json'),JSON.stringify({schemaVersion:1,directory:'../private',reportSha256:'a'.repeat(64)}));await assert.rejects(readStage5Results({resultsDir:base}),/reference/);
  await publish(base,report());await writeFile(path.join(base,'study/report.json'),'{}');await assert.rejects(readStage5Results({resultsDir:base}),/hash mismatch/);
  for(const patch of [{tier:1},{cloudCalls:1},{spendUsd:1},{modelAnswerCalls:1},{dryRun:false},{kind:'raw-payloads'}]){await publish(base,{...report(),...patch});await assert.rejects(readStage5Results({resultsDir:base}),/Unsupported/);}
  const inconsistent=report();inconsistent.items[0].verdict='unsafe';await publish(base,inconsistent);await assert.rejects(readStage5Results({resultsDir:base}),/disagrees/);
}));
test('Guard loader removes would-send contents, raw responses and private mappings',()=>fixture(async base=>{
  const value=report();value.wouldSendSnapshots=[{query:'PRIVATE_A'}];value.items[0]={...value.items[0],wire:{query:'PRIVATE_B'},rawGuard:'PRIVATE_C',prompt:'PRIVATE_D',piiMap:{value:'PRIVATE_E'}};
  await publish(base,value);const loaded=await readStage5Results({resultsDir:base});assert.doesNotMatch(JSON.stringify(loaded),/PRIVATE_[A-E]/);assert.equal(loaded.items[0].verdict,'safe');
}));
