import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import {runPromptGuard,inspectPromptGuardAssets} from '../src/privacy/prompt-guard.mjs';

test('the fixed primary and comparison asset manifest pins inference files and semantic source',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../config/prompt-guard-artifacts.json',import.meta.url),'utf8'));
  assert.equal(manifest.threshold,.5);assert.equal(manifest.labelMapping['1'],'MALICIOUS');assert.equal(manifest.labelMapping['0'],'BENIGN');
  assert.match(manifest.mappingSource,/meta-llama\/PurpleLlama/);
  for(const variant of ['86m','22m']){const model=manifest.variants[variant];assert.match(model.revision,/^[0-9a-f]{40}$/);assert.deepEqual(Object.keys(model.files).sort(),['config.json','model.safetensors','special_tokens_map.json','tokenizer.json','tokenizer_config.json']);assert.ok(Object.values(model.files).every(hash=>/^[0-9a-f]{64}$/.test(hash)));}
});

test('missing local weights stay closed even when machine runtime has downloaded models',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'handoff-pg-missing-'));
  try{const result=await runPromptGuard(['Please summarize a public document.'],{modelDirectory:path.join(directory,'missing')});assert.equal(result.status,'PENDING');assert.equal(result.available,false);assert.equal(result.detected,false);}
  finally{await rm(directory,{recursive:true,force:true});}
});

test('unknown or tampered local asset bytes fail before a worker can load a model',async()=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'handoff-pg-tampered-'));
  try{for(const file of ['config.json','model.safetensors','special_tokens_map.json','tokenizer.json','tokenizer_config.json'])await writeFile(path.join(directory,file),'unapproved fixture');await assert.rejects(inspectPromptGuardAssets({directory}),/PG_ASSET_HASH_MISMATCH/);}
  finally{await rm(directory,{recursive:true,force:true});}
});

test('binary score threshold is fixed and equality blocks; request data is never returned',async()=>{
  for(const [score,status]of [[0,'PASS'],[.499,'PASS'],[.5,'BLOCKED'],[1,'BLOCKED']]){const result=await runPromptGuard(['Public development fixture.'],{variant:'22m',predict:async()=>({status:'READY',localOnly:true,windows:2,maxScore:score,inferenceMs:7,tokenizeMs:1,loadMs:0})});assert.equal(result.status,status);assert.equal(result.threshold,.5);assert.equal(result.windows,2);assert.equal(result.inferenceMs,7);assert.equal(JSON.stringify(result).includes('Public development fixture.'),false);}
});

test('invalid model results cannot pass and empty or overlong input is blocked',async()=>{
  for(const value of [{status:'READY',localOnly:false,windows:1,maxScore:0},{status:'READY',localOnly:true,windows:0,maxScore:0},{status:'READY',localOnly:true,windows:1,maxScore:NaN},{status:'READY',localOnly:true,windows:1,maxScore:-1},{status:'READY',localOnly:true,windows:1,maxScore:1.01}]){const result=await runPromptGuard(['Public development fixture.'],{predict:async()=>value});assert.equal(result.status,'PENDING');assert.equal(result.available,false);}
  let calls=0;for(const input of [[],['a'.repeat(65537)],[null]]){const result=await runPromptGuard(input,{predict:async()=>{calls++;}});assert.equal(result.status,'BLOCKED');}assert.equal(calls,0);
});

test('pure worker windowing covers long inputs including the tail without exceeding 512 tokens',()=>{
  const script="import importlib.util,json; s=importlib.util.spec_from_file_location('pg','src/privacy/prompt_guard_worker.py'); m=importlib.util.module_from_spec(s);s.loader.exec_module(m);print(json.dumps({str(n):m.window_offsets(n) for n in [0,1,510,511,1000,2000]}))";
  const result=JSON.parse(execFileSync(process.env.HANDOFF_TEST_PYTHON??'python',['-c',script],{encoding:'utf8',windowsHide:true}));
  for(const [size,windows]of Object.entries(result)){assert.equal(windows[0][0],0);assert.equal(windows.at(-1)[1],Number(size));assert.ok(windows.every(([start,end])=>end-start<=510));for(let index=1;index<windows.length;index++)assert.equal(windows[index][0],windows[index-1][1]-64);}
});

test('worker socket networking is denied before any connection is attempted',()=>{
  const script="import importlib.util,json,socket;s=importlib.util.spec_from_file_location('pg','src/privacy/prompt_guard_worker.py');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);denied=False\ntry: socket.create_connection(('127.0.0.1',9))\nexcept RuntimeError as error: denied=str(error)=='NETWORK_DISABLED'\nprint(json.dumps({'networkDenied':denied}))";
  const result=JSON.parse(execFileSync(process.env.HANDOFF_TEST_PYTHON??'python',['-c',script],{encoding:'utf8',windowsHide:true}));assert.equal(result.networkDenied,true);
});

test('worker uses native overflow and the maximum malicious score over every window and text',()=>{
  const result=JSON.parse(execFileSync(process.env.HANDOFF_TEST_PYTHON??'python',['tests/helpers/prompt_guard_worker_test.py'],{encoding:'utf8',windowsHide:true}));
  assert.equal(result.status,'READY');assert.equal(result.windows,4);assert.equal(result.maxScore,.8);assert.equal(result.calls,4);assert.equal(result.networkDisabled,true);
});
