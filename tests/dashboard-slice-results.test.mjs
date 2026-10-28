import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {readStage4Results} from '../dashboard/server/stage4-results.mjs';
const hash=text=>createHash('sha256').update(text).digest('hex');
async function fixture(run){const base=await mkdtemp(path.join(os.tmpdir(),'handoff-slice-api-'));try{await mkdir(path.join(base,'study'));return await run(base);}finally{await rm(base,{recursive:true,force:true});}}
async function publish(base,report){const text=JSON.stringify(report);await writeFile(path.join(base,'study','report.json'),text);await writeFile(path.join(base,'stage4-latest.json'),JSON.stringify({schemaVersion:1,directory:'study',reportSha256:hash(text)}));}
const report=()=>({schemaVersion:1,kind:'stage4-slice-report',runId:'study',tier:0,cloudCalls:0,modelCalls:0,spendUsd:0,models:[],slices:[],rows:[{modelId:'local',acceptedAccuracy:{estimate:null},items:1}],privacy:[{actualCloudCalls:0,guardScreened:null}],summaryParagraph:'A saved local result.'});
test('slice aggregate loader has no inference dependency and keeps pending/zero distinct',()=>fixture(async base=>{
  assert.equal(await readStage4Results({resultsDir:base}),null);await publish(base,report());
  const old=globalThis.fetch;let calls=0;globalThis.fetch=async()=>{calls++;throw Error('network not permitted');};
  try{const value=await readStage4Results({resultsDir:base});assert.equal(value.rows[0].acceptedAccuracy.estimate,null);assert.equal(value.privacy[0].actualCloudCalls,0);assert.equal(value.privacy[0].guardScreened,null);assert.equal(calls,0);}finally{globalThis.fetch=old;}
}));
test('slice endpoint requires confined paths, integrity hashes and a Tier 0 aggregate schema',()=>fixture(async base=>{
  for(const pointer of [{schemaVersion:1,directory:'../outside',reportSha256:'a'.repeat(64)},{schemaVersion:1,directory:'study'},{schemaVersion:1,directory:'.logs',reportSha256:'a'.repeat(64)}]){await writeFile(path.join(base,'stage4-latest.json'),JSON.stringify(pointer));await assert.rejects(readStage4Results({resultsDir:base}),/reference/);}
  await publish(base,report());await writeFile(path.join(base,'study','report.json'),'{}');await assert.rejects(readStage4Results({resultsDir:base}),/hash mismatch/);
  for(const patch of [{kind:'raw-answers'},{tier:1},{cloudCalls:1},{modelCalls:1},{spendUsd:1}]){await publish(base,{...report(),...patch});await assert.rejects(readStage4Results({resultsDir:base}),/Unsupported/);}
}));
test('slice endpoint exposes aggregates and removes nested raw responses, text and private payloads',()=>fixture(async base=>{
  const value={...report(),raw:{answer:'SECRET_A'},privatePayloads:['SECRET_B'],rows:[{modelId:'local',accepted:1,rawAnswer:{text:'SECRET_C'},answerText:'SECRET_D',payload:{query:'SECRET_E'},draft:'SECRET_F',costs:{gemini:{inputTokens:123}}}]};
  await publish(base,value);const loaded=await readStage4Results({resultsDir:base});assert.doesNotMatch(JSON.stringify(loaded),/SECRET_[A-F]/);assert.equal(loaded.rows[0].accepted,1);assert.equal(loaded.rows[0].costs.gemini.inputTokens,123);
}));
