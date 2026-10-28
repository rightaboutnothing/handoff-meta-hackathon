import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,readFile,writeFile,rm,access} from 'node:fs/promises';
import path from 'node:path';
import {assemblePayloadCount,createLocalTokenCounters,TOKENIZER_SOURCES,readGgufMetadata,llamaTokenizerJson} from '../src/server/token-counts.mjs';
import {serializeLeanUserPayload} from '../src/comparison/handoff-payload.mjs';

const encode=text=>[...text.matchAll(/[\p{L}\p{N}]+|[^\s]/gu)].map(match=>match[0]);
const metadata={method:'fixture-tokenizer',exactProviderBillingTokens:false};
const payload={eligible:true,system:'Answer concisely. Cite evidence.',query:'What is the warranty?',context:[{chunkId:'fake-chunk-1',text:'Warranty is 24 months.'}],draft:null};
const directory=path.resolve('.cache/token-count-tests'),temporary=[];
async function folder(){await mkdir(directory,{recursive:true});const value=await mkdtemp(path.join(directory,'case-'));temporary.push(value);return value;}
test.after(async()=>{for(const value of temporary){assert.equal(path.dirname(path.resolve(value)),directory);await rm(value,{recursive:true,force:true});}});

test('provider-selected tokenizer and documented proxy have pinned provenance, not chars/4',()=>{
  assert.equal(TOKENIZER_SOURCES.gemini.cloudModelId,'gemini-3.1-flash-lite');
  assert.equal(TOKENIZER_SOURCES.gemini.repository,'google/gemma-4-E4B-it');
  assert.match(TOKENIZER_SOURCES.gemini.revision,/^[a-f0-9]{40}$/);
  assert.match(TOKENIZER_SOURCES.gemini.mappingSdkRevision,/^[a-f0-9]{40}$/);
  assert.match(TOKENIZER_SOURCES.gemini.files['tokenizer.json'],/^[a-f0-9]{64}$/);
  assert.equal(TOKENIZER_SOURCES['muse-spark'].proxyModelId,'llama3.1:8b');
  assert.match(TOKENIZER_SOURCES['muse-spark'].limitation,/not actual Muse Spark billed tokens/);
});
test('exact content counts and telescoping components cover the same wire bytes',()=>{
  const result=assemblePayloadCount('gemini',payload,encode,metadata);
  assert.equal(result.inputTokens,encode(payload.system).length+encode(serializeLeanUserPayload(payload)).length);
  assert.equal(Object.values(result.components).reduce((sum,count)=>sum+count,0),result.inputTokens);
  assert.equal(result.components.guardWrapper,0);assert.equal(result.components.receiptMetadata,0);assert.equal(result.components.piiMap,0);
  assert.equal(result.serverFramingTokens,null);assert.equal(result.billingInputTokens,null);
  assert.match(result.framingNote,/unknown/);
});
test('with-draft and question-only count their actual distinct texts',()=>{
  const baseline=assemblePayloadCount('gemini',payload,encode,metadata);
  const drafted=assemblePayloadCount('gemini',{...payload,draft:'A tentative answer is 24 months, pending source verification.'},encode,metadata);
  assert.ok(drafted.inputTokens>baseline.inputTokens);
  assert.ok(drafted.components.localDraft>0);assert.equal(baseline.components.localDraft,0);
  assert.notEqual(drafted.providerWireTextHash,baseline.providerWireTextHash);
  assert.equal(drafted.components.retrievedChunks,baseline.components.retrievedChunks);
});
test('local proof, guard verdicts and maps are never counted as outbound bytes',()=>{
  const clean=assemblePayloadCount('gemini',payload,encode,metadata);
  const local=assemblePayloadCount('gemini',{...payload,guardVerdict:'unsafe',receipt:{signature:'local-signature'},piiMap:{name:'private'},localAudit:{reason:'Local-only routing reason'}},encode,metadata);
  assert.deepEqual(local,clean);
});
test('an adversarial/local-only item has no hypothetical handoff or tokenizer invocation',()=>{
  const result=assemblePayloadCount('gemini',{eligible:false,query:'Excluded adversarial task'},()=>assert.fail('No handoff tokens exist for this item'),metadata);
  assert.equal(result.status,'ineligible_local_only');assert.equal(result.inputTokens,0);
  assert.equal(result.billingInputTokens,null);
});
test('missing or corrupted local assets fail closed without downloading or cloud counting',async()=>{
  const value=await folder(),original=globalThis.fetch;globalThis.fetch=()=>assert.fail('Token counting must stay offline');
  try{
    await assert.rejects(createLocalTokenCounters({directory:value}),/assets are missing/);
    const manifest={schemaVersion:1,gemini:TOKENIZER_SOURCES.gemini};
    await mkdir(path.join(value,'gemini-3.1-flash-lite'));
    await writeFile(path.join(value,'manifest.json'),JSON.stringify(manifest));
    await writeFile(path.join(value,'gemini-3.1-flash-lite/tokenizer.json'),'corrupted bytes');
    await assert.rejects(createLocalTokenCounters({directory:value}),/artifact hash mismatch/);
  }finally{globalThis.fetch=original;}
});
test('GGUF metadata reader uses bounded metadata only and rejects invalid tokenizer sources',()=>{
  const u32=value=>{const result=Buffer.alloc(4);result.writeUInt32LE(value);return result;},u64=value=>{const result=Buffer.alloc(8);result.writeBigUInt64LE(BigInt(value));return result;};
  const string=value=>Buffer.concat([u64(Buffer.byteLength(value)),Buffer.from(value)]);
  const fixture=Buffer.concat([Buffer.from('GGUF'),u32(3),u64(5),u64(2),string('general.name'),u32(8),string('Synthetic model'),string('tokenizer.ggml.tokens'),u32(9),u32(8),u64(2),string('a'),string('b')]);
  const result=readGgufMetadata(fixture);assert.equal(result.metadata['general.name'],'Synthetic model');assert.deepEqual(result.metadata['tokenizer.ggml.tokens'],['a','b']);assert.equal(result.tensorCount,5);assert.equal(result.metadataBytes,fixture.length);
  assert.throws(()=>readGgufMetadata(fixture.subarray(0,30)),/bounded prefix/);
  assert.throws(()=>llamaTokenizerJson({'tokenizer.ggml.model':'unigram'}),/supported Llama BPE/);
  assert.throws(()=>llamaTokenizerJson({'tokenizer.ggml.model':'gpt2','tokenizer.ggml.pre':'llama-bpe'}),/incomplete/);
});
test('real cached provider/proxy tokenizers differ on Unicode and make zero network requests',async t=>{
  try{await access(path.resolve('.cache/tokenizers/manifest.json'));}catch{t.skip('Run node scripts/prepare-tokenizers.mjs to exercise optional pinned tokenizer assets');return;}
  const original=globalThis.fetch;globalThis.fetch=()=>assert.fail('Runtime tokenizer counting must never call the network');
  try{
    const counters=await createLocalTokenCounters();
    assert.equal(counters.countText('gemini','Hello world'),2);assert.equal(counters.countText('muse-spark','Hello world'),2);
    const unicode='🦙 café 日本語 [[PII_FAKE_123]]';assert.equal(counters.countText('gemini',unicode),17);assert.equal(counters.countText('muse-spark',unicode),14);
    assert.equal(counters.metadata.gemini.method,'provider_selected_local_tokenizer');assert.equal(counters.metadata['muse-spark'].method,'documented_local_proxy');
    assert.equal(counters.metadata.gemini.remoteCountRequests,0);assert.equal(counters.metadata['muse-spark'].cloudInferenceCalls,0);
    const one=counters.countPayload('gemini',payload);one.components.query=999999;
    assert.notEqual(counters.countPayload('gemini',payload).components.query,999999);
    assert.throws(()=>counters.countText('retired-provider','Hi'),/Unknown cloud tokenizer/);
  }finally{globalThis.fetch=original;}
});
