import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, rm, readdir } from 'node:fs/promises';
import path from 'node:path';
import { acquireRunLock } from '../src/comparison/run-lock.mjs';
import { latestResults, shouldResumeResult, orderPipelines, stageIdentity, checkedCache, cumulativeCloudAccounting } from '../src/comparison/resume.mjs';
import { buildPipelineMatrix, comparisonConfig } from '../src/comparison/matrix.mjs';
import { ensureSyntheticCorpus } from '../src/comparison/corpus.mjs';
import { sourceFingerprint } from '../src/comparison/runner.mjs';
import { sha256 } from '../src/rag/receipts.mjs';
import { createCloudBudget } from '../src/comparison/budget.mjs';

const directories=[];
async function temporary(){const base=path.resolve('.cache/comparison-resume-tests');await mkdir(base,{recursive:true});const directory=await mkdtemp(path.join(base,'test-'));directories.push(directory);return directory;}
test.after(async()=>{for(const directory of directories)await rm(directory,{recursive:true,force:true});});

test('lifetime lock excludes live owners, releases only itself and recovers confirmed dead owners',async()=>{
  const directory=await temporary(),lock=path.join(directory,'run.lock');
  const release=await acquireRunLock(lock);
  await assert.rejects(acquireRunLock(lock),{code:'COMPARISON_LOCK_BUSY'});
  await release();await release();
  await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:99999999,token:'dead-owner'}));
  const recovered=await acquireRunLock(lock,{isAlive:pid=>pid===99999999?false:true});
  assert.equal(JSON.parse(await readFile(path.join(lock,'owner.json'))).pid,process.pid);
  assert.ok((await readdir(directory)).includes('run.lock.stale-dead-owner'));
  await release(); // An old cleanup must not remove the replacement owner.
  await assert.rejects(acquireRunLock(lock),{code:'COMPARISON_LOCK_BUSY'});
  await recovered();
});
test('two dead-lock reclaimers cannot both acquire; unknown owners fail closed',async()=>{
  const directory=await temporary(),lock=path.join(directory,'run.lock');
  await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:99999999,token:'one-dead-token'}));
  const results=await Promise.allSettled([acquireRunLock(lock,{isAlive:pid=>pid===99999999?false:true}),acquireRunLock(lock,{isAlive:pid=>pid===99999999?false:true})]);
  assert.equal(results.filter(row=>row.status==='fulfilled').length,1);
  for(const row of results)if(row.status==='fulfilled')await row.value();
  const active=await acquireRunLock(lock);
  await assert.rejects(acquireRunLock(lock,{isAlive:()=>null}),{code:'COMPARISON_LOCK_BUSY'});await active();
});
test('budget transaction uses recoverable ownership without losing prior reservations',async()=>{
  const directory=await temporary(),ledger=createCloudBudget({directory,capUsd:1});
  await ledger.reserve({requestId:'one',cloudId:'gemini',upperBoundUsd:.1});
  const lock=path.join(directory,'cloud-budget.json.lock');await mkdir(lock);await writeFile(path.join(lock,'owner.json'),JSON.stringify({pid:2147483647,token:'dead-budget-token'}));
  assert.equal((await ledger.status()).reservedUsd,.1);
});
test('deferred Meta queue resumes only after access restoration; successful work is not repeated',()=>{
  const deferred={pipelineId:'meta',id:'one',status:'deferred_cloud',cloudStatus:'deferred_meta'};
  assert.equal(shouldResumeResult(deferred,{tier:1,metaEnabled:false}),false);
  assert.equal(shouldResumeResult(deferred,{tier:1,metaEnabled:true}),true);
  assert.equal(shouldResumeResult({...deferred,cloudStatus:'deferred_tier0'},{tier:0,metaEnabled:true}),false);
  assert.equal(shouldResumeResult({status:'ok'},{tier:1,hasCloudReply:true}),false);
  assert.equal(shouldResumeResult({status:'error'},{tier:1,hasCloudReply:true}),true);
  assert.equal(shouldResumeResult({status:'error'},{tier:1,hasCloudReply:false}),false);
});
test('last checkpoint wins while unique successful request costs survive postprocessing replacement',()=>{
  const before={pipelineId:'meta',id:'one',status:'deferred_cloud'};
  const success={...before,status:'error',cloudStatus:'ok',cloudRequestId:'paid-once',metrics:{actualCloudSpendUsd:null,cloudCostUnknown:true,meteredCloudSpendUsd:.01,tokensSentToCloud:10}};
  const resumed={...success,status:'ok'};
  assert.deepEqual(latestResults([before,success,resumed]),[resumed]);
  const accounting=cumulativeCloudAccounting([before,success,resumed]);
  assert.equal(accounting.successfulRequests,1);assert.equal(accounting.meteredUsd.total,.01);assert.equal(accounting.providerReportedUsd.total,null);assert.equal(accounting.tokensSent.total,10);
});
test('every control remains grouped with its local model; cloud-only controls run last',()=>{
  const ordered=orderPipelines(buildPipelineMatrix(),comparisonConfig.localModels);
  assert.equal(ordered.length,23);
  let offset=0;for(const model of comparisonConfig.localModels){const expected=ordered.filter(row=>row.localModelId===model.modelId);assert.equal(expected.length,7);assert.ok(ordered.slice(offset,offset+7).every(row=>row.localModelId===model.modelId));offset+=7;}
  assert.ok(ordered.slice(21).every(row=>row.kind==='cloud-only'));
});
test('cache identities reject changed model, input, source, settings and original pipeline decisions',()=>{
  const args={stage:'cloud-answer',item:{id:'one',prompt:'Question'},input:'redacted',modelId:'muse-spark-1.3',settings:{temperature:0},sourceHash:'source',corpusHash:'corpus'};
  const identity=stageIdentity(args),record={modelId:args.modelId,cacheIdentity:identity,text:'Original answer'};
  assert.equal(checkedCache(record,identity).text,'Original answer');
  for(const mutation of [{input:'changed'},{modelId:'different'},{sourceHash:'changed'},{settings:{temperature:1}},{corpusHash:'changed'}])assert.throws(()=>checkedCache(record,stageIdentity({...args,...mutation})),/Cached model stage/);
  assert.throws(()=>checkedCache({...record,modelId:'wrong'},identity),/model ID changed/);
});
test('paid corpus uses verified synthetic bytes in a dedicated pinned index and detects contamination',async()=>{
  const root=await temporary(),source=path.join(root,'demo_data');await mkdir(source);const text='SYNTHETIC company policy only';await writeFile(path.join(source,'policy.md'),text);
  const manifest={companyCorpus:{synthetic:true,files:[{file:'policy.md',sha256:sha256(text)}]}};
  let ingests=0,hash='index-original';const dependencies={ingest:async(folder,options)=>{ingests++;assert.notEqual(options.dataDir,path.join(root,'.handoff'));assert.equal(options.embeddingProvider,'ollama');assert.equal(options.embeddingOptions.model,'nomic-embed-text:v1.5');assert.equal(await readFile(path.join(folder,'policy.md'),'utf8'),text);},status:()=>({ready:true,indexFingerprint:'fingerprint',embeddingModel:{provider:'ollama',model:'nomic-embed-text:v1.5',dimensions:1}}),contentsHash:async()=>hash};
  const directory=path.join(root,'isolated');const first=await ensureSyntheticCorpus({root,manifest,directory,dependencies});const second=await ensureSyntheticCorpus({root,manifest,directory,dependencies});assert.equal(ingests,1);assert.equal(first.indexContentHash,second.indexContentHash);
  hash='foreign-index';await assert.rejects(ensureSyntheticCorpus({root,manifest,directory,dependencies}),/index changed/);
  hash='index-original';await writeFile(path.join(source,'real-company.md'),'Unexpected data');await assert.rejects(ensureSyntheticCorpus({root,manifest,directory,dependencies}),/file list differs/);
});
test('fingerprint covers the retrieval, privacy, receipt, journal and dependency implementation',async()=>{
  const fingerprint=await sourceFingerprint();
  for(const name of ['src/rag/documents.mjs','src/rag/ingest.mjs','src/rag/privacy.mjs','src/rag/receipts.mjs','src/comparison/receipt-journal.mjs','src/comparison/resume.mjs','package-lock.json'])assert.ok(fingerprint.files[name]);
});
