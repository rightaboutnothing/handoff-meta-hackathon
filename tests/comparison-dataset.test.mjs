import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { COMPARISON_CATEGORIES, assignComparisonSplits, loadComparisonDataset, loadComparisonManifest } from '../src/comparison/dataset.mjs';
import { extractDocument, chunkText, stableChunkId } from '../src/rag/documents.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root=fileURLToPath(new URL('../',import.meta.url));
const digest=value=>createHash('sha256').update(value).digest('hex');
const all=await loadComparisonDataset({hydrateGpqa:false});
const manifest=await loadComparisonManifest();

test('expanded dataset counts and public source pins are reproducible without gated text',async()=>{
  assert.ok(all.length>=6000&&all.length<=10000);
  assert.equal(all.length,manifest.count);
  assert.equal(new Set(all.map(item=>item.id)).size,all.length);
  const prompts=all.filter(item=>item.prompt).map(item=>item.prompt.normalize('NFKC').toLowerCase().replace(/\s+/g,' ').trim());
  assert.equal(new Set(prompts).size,prompts.length);
  assert.equal(manifest.sources.mmlu.selected,4000);
  assert.equal(manifest.seed,manifest.splitSeed);
  assert.equal(digest(await readFile(path.join(root,'tasks/comparison/items.jsonl'))),manifest.itemsSha256);
  const gated=all.filter(item=>item.suite==='gpqa');
  assert.equal(gated.length,198);
  assert.ok(gated.every(item=>!Object.hasOwn(item,'prompt')&&!Object.hasOwn(item.reference,'correct_answer')&&item.available===false&&item.fetchRef.revision===manifest.sources.gpqa.revision));
  assert.deepEqual([...new Set(all.map(item=>item.category))].sort(),[...COMPARISON_CATEGORIES].sort());
});

test('dev training, held-out selection and final test never share source or template groups',()=>{
  const byId=new Map(all.map(item=>[item.id,item]));
  const groups=ids=>new Set(ids.map(id=>byId.get(id).groupId));
  const train=groups(manifest.devTrainIDs),selection=groups(manifest.selectionPoolIDs),heldout=groups(manifest.testIDs);
  for(const value of train){assert.equal(selection.has(value),false);assert.equal(heldout.has(value),false);}
  for(const value of selection)assert.equal(heldout.has(value),false);
  assert.equal(new Set([...manifest.devTrainIDs,...manifest.selectionPoolIDs,...manifest.testIDs]).size,all.length);
  assert.equal(manifest.selectionCoreIDs.length,1000);
  assert.ok(manifest.selectionCoreIDs.every(id=>manifest.selectionPoolIDs.includes(id)));
  assert.ok(manifest.tier0.devIDs.every(id=>manifest.devTrainIDs.includes(id)));
  assert.ok(manifest.tier0.testIDs.every(id=>manifest.testIDs.includes(id)));
  for(const ids of [manifest.selectionCoreIDs,manifest.tier0.devIDs,manifest.tier0.testIDs])assert.deepEqual([...new Set(ids.map(id=>byId.get(id).category))].sort(),[...COMPARISON_CATEGORIES].sort());
  const forward=assignComparisonSplits(all),reverse=assignComparisonSplits([...all].reverse());
  assert.deepEqual(forward,reverse);
  assert.deepEqual(forward.devTrainIDs,manifest.devTrainIDs);
});

test('declared harmful, red-team and poisoning sources are local-only independent of model outcome',()=>{
  const localOnly=all.filter(item=>['strongreject','local-poisoning','local-red-team'].includes(item.suite));
  assert.equal(localOnly.length,110);
  assert.ok(localOnly.every(item=>item.safety.cloudEligible===false&&item.safety.kind!=='safe'));
  assert.ok(all.filter(item=>item.suite==='xstest').every(item=>item.safety.kind==='safe'));
});

test('every company citation refers to a real chunk in the shared synthetic corpus',async()=>{
  const sources=JSON.parse(await readFile(path.join(root,'demo_data/manifest.json'),'utf8'));
  const chunkIds=new Set();
  for(const source of sources.files)for(const unit of await extractDocument(path.join(root,'demo_data',source.file)))chunkText(unit.text).forEach((_,index)=>chunkIds.add(stableChunkId(source.file,unit.location,index)));
  const company=all.filter(item=>item.suite==='company-rag');
  assert.ok(company.filter(item=>item.category==='company-data multi-doc').length>=1000);
  for(const item of company){assert.ok(item.reference.requiredFacts.length>0);assert.ok(item.expectedChunkIds.every(id=>chunkIds.has(id)),`Missing chunk reference on ${item.id}`);}
});

test('loader rejects out-of-split IDs and marks absent gated rows unavailable rather than fabricating questions',async()=>{
  const rows=await loadComparisonDataset({split:'tier0-test',hydrateGpqa:false});
  assert.equal(rows.length,manifest.tier0.testIDs.length);
  await assert.rejects(loadComparisonDataset({split:'test',ids:[manifest.devTrainIDs[0]],hydrateGpqa:false}),/outside/);
  await assert.rejects(loadComparisonDataset({split:'not-a-split'}),/Unknown/);
  const unavailable=all.find(item=>item.suite==='gpqa');
  assert.equal(unavailable.available,false);assert.equal(unavailable.prompt,undefined);
});
