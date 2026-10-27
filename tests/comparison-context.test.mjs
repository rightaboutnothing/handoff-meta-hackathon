import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { prepareContext, parseAnswer, attachRestorer } from '../src/comparison/context.mjs';

const directory = async () => mkdtemp(path.join(os.tmpdir(), 'handoff-context-'));
const sha = text => createHash('sha256').update(text).digest('hex');
const company = { id: 'company-example', suite: 'company-rag', category: 'company-data multi-doc',
  prompt: 'What do the product and shipping documents require?', reference: { answer: 'This secret reference must never enter the prompt' }, expectedSourceFiles: ['wrong-expected-file.md'] };
const chunks = [
  { chunkId: 'product-1', file: 'product.md', location: 'page:1', text: 'The item costs 100 units.', score: .8 },
  { chunkId: 'shipping-1', file: 'shipping.md', location: 'page:1', text: 'Dispatch takes two days.', score: .7 },
  { chunkId: 'product-2', file: 'product.md', location: 'page:2', text: 'A second product fact.', score: .6 },
];

test('company context uses actual local retrieval only and never expected answers or source files', async () => {
  let query, options;
  const prepared = await prepareContext(company, { dataDir: await directory(), dependencies: { retrieve: async (question, settings) => {
    query = question; options = settings; return { chunks, quality: .99, latencyMs: 17, embeddingModel: 'mock-local-embedding' };
  } } });
  assert.equal(query, company.prompt); assert.equal(options.topK, 4);
  assert.equal(prepared.sourceDocCount, 2); assert.equal(prepared.retrievalScore, .8);
  assert.equal(prepared.retrievalLatencyMs, 17); assert.equal(prepared.chunks[0].hash, sha(chunks[0].text));
  assert(!prepared.input.includes('secret reference')); assert(!prepared.input.includes('wrong-expected-file'));
  assert(prepared.input.includes('[product-1]')); assert(prepared.input.includes('Dispatch takes two days.'));
});
test('all company pipelines share the same context bytes with fixed cap and opaque-token boundaries', async () => {
  const long = 'x'.repeat(5590) + '[[PII_NAME_1234567890abcdef]]' + 'z'.repeat(50);
  const prepared = await prepareContext(company, { dataDir: await directory(), dependencies: { retrieve: async () => ({ chunks: [{ ...chunks[0], text: long }, chunks[1]], latencyMs: 0 }) } });
  assert(prepared.contextTokensEstimated <= 1400);
  assert.equal(prepared.chunks.length, 2); assert.equal(prepared.chunks[0].truncated, true);
  assert.equal(prepared.chunks.reduce((sum, chunk) => sum + chunk.text.length, 0), 5600);
  assert(!prepared.chunks[0].text.includes('[[PII_'));
  assert.equal(prepared.chunks[0].hash, sha(prepared.chunks[0].text));
  await assert.rejects(prepareContext(company, { topK: 2 }), /fixed at top 4/);
});
test('noncompany items do not retrieve and missing gated text is unavailable', async () => {
  let called = false;
  const prepared = await prepareContext({ id: 'knowledge', suite: 'mmlu-pro', category: 'knowledge', prompt: 'What is two plus two?' }, {
    dataDir: await directory(), dependencies: { retrieve: async () => { called = true; throw new Error('Should not retrieve'); } },
  });
  assert.equal(called, false); assert.equal(prepared.sourceDocCount, 0); assert.deepEqual(prepared.chunks, []);
  await assert.rejects(prepareContext({ id: 'gated-row', suite: 'gpqa', fetchRef: { row_index: 1 } }), /unavailable/);
});
test('ad minimization retains numeric campaign evidence and removes private records before any model', async () => {
  const dataDir = await directory();
  const exportData = {
    notice: 'Entirely fake fixture', account_id: 'FAKE-ACCOUNT',
    campaigns: [{ campaign: 'FAKE-Search', spend_usd: 120, conversions: 12, cpa_usd: 10 }],
    private_customer_fields_not_needed_for_task: [{ customer_id: 'CANARY-PRIVATE-123', customer_name: 'Avery Fictionalsentinel', email: 'avery@example.invalid', phone: '+61 400 123 456' }],
  };
  const item = { id: 'ad-fixture', suite: 'ad-privacy', category: 'privacy', prompt: `Analyze the lowest CPA campaign; return only campaign aggregates.\n\n${JSON.stringify(exportData)}` };
  const prepared = await prepareContext(item, { dataDir });
  for (const value of ['CANARY-PRIVATE-123', 'Avery Fictionalsentinel', 'avery@example.invalid', '+61 400 123 456', 'private_customer_fields', 'FAKE-ACCOUNT']) assert(!prepared.input.includes(value));
  assert(prepared.input.includes('FAKE-Search')); assert(prepared.input.includes('"cpa_usd":10')); assert(prepared.piiRedacted >= 4);
  assert.equal(prepared.chunks.length, 0);
  await assert.rejects(prepareContext({ ...item, prompt: 'A malformed privacy export { invalid' }, { dataDir }), /could not be parsed/);
});
test('PII and canary placeholders persist in encrypted vault and restore only locally after cache resume', async () => {
  const dataDir = await directory();
  const prepared = await prepareContext({ id: 'local-private', category: 'knowledge', prompt: 'Contact name: Jamie Fictional\nEmail: jamie@example.invalid\nThe fake customer code is CANARY-RESTORE-99.' }, { dataDir });
  assert(!prepared.input.includes('Jamie Fictional')); assert(!prepared.input.includes('jamie@example.invalid')); assert(!prepared.input.includes('CANARY-RESTORE-99'));
  assert(prepared.question.includes('[[PII_'));
  const cached = JSON.parse(JSON.stringify(prepared));
  assert.equal(cached.restore, undefined);
  const resumed = await attachRestorer(cached, { dataDir });
  assert.equal(resumed.restore(cached.question), 'Contact name: Jamie Fictional\nEmail: jamie@example.invalid\nThe fake customer code is CANARY-RESTORE-99.');
});
test('answer features use retrieved documents and self-report only, while citation precision keeps invented IDs', () => {
  const prepared = { chunks, retrievalScore: .8, sourceDocCount: 2, reference: { confidence: 1, expectedSourceFiles: ['one.md'] } };
  const answer = parseAnswer(JSON.stringify({ answer: 'The price is 100.', confidence: .9, needsCloud: false, citations: ['product-1', 'invented-id'] }), prepared);
  assert.equal(answer.answer, 'The price is 100.'); assert.equal(answer.features.confidence, .9);
  assert.equal(answer.features.sourceDocCount, 2); assert.equal(answer.features.retrievalScore, .8);
  assert.equal(answer.features.hasValidCitations, false); assert.equal(answer.features.citationCount, 1);
  assert.equal(answer.citations.length, 2); assert.equal(answer.citations[1].valid, false); assert.equal(answer.citations[1].file, null);
});
test('answer parsing fails closed for malformed output and does not restore before local presentation', () => {
  const prepared = { chunks, retrievalScore: .8, sourceDocCount: 2, restore: text => text.replace('opaque-token', 'Local original') };
  const valid = parseAnswer('```json\n{"answer":"opaque-token","confidence":0.7,"needsCloud":false,"citations":["product-1"]}\n```', prepared);
  assert.equal(valid.answer, 'opaque-token'); assert.equal(valid.restore(), 'Local original'); assert.equal(valid.features.hasValidCitations, true);
  const invalid = parseAnswer('{"answer":"truncated', prepared);
  assert.equal(invalid.parseValid, false); assert.equal(invalid.confidence, 0); assert.equal(invalid.needsCloud, true); assert.deepEqual(invalid.citations, []);
});
