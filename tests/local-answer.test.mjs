import test from 'node:test';
import assert from 'node:assert/strict';
import { generateLocalAnswer, localAnswerSchema, answerMessages, parseGeneratedAnswer, parseGenerationAnswer, extractPlainCitations, parseSelfCheck, selfCheckMessages, SELF_CHECK_MAX_TOKENS, LOCAL_ANSWER_SETTINGS } from '../src/comparison/local-answer.mjs';
import { comparisonLocal } from '../src/server/comparison-models.mjs';

const prepared = { question: 'What is the dispatch period?', retrievalScore: .8, sourceDocCount: 2, chunks: [
  { chunkId: 'shipping-1', file: 'shipping.md', text: 'Dispatch takes two days.', hash: 'source-hash-1' },
  { chunkId: 'product-1', file: 'product.md', text: 'The item costs 100.', hash: 'source-hash-2' },
] };
const item = { id: 'fixture', category: 'company-data single-doc', reference: { answer: 'REFERENCE MUST NOT ENTER PROMPTS' } };
const response = text => ({ text, modelId: 'llama3.1:8b', latencyMs: 3, tokens: { input: 20, output: 10, total: 30 } });
const goodCheck = { confidence: .9, evidenceSupported: true, answerComplete: true, issues: [] };
function callSequence(outputs, requests = []) { return async (modelId, messages, options) => { requests.push({ modelId, messages, options }); return response(outputs[requests.length - 1]); }; }

test('answer schema enumerates only retrieved identifiers and forbids routing metadata', () => {
  const schema = localAnswerSchema(prepared);
  assert.deepEqual(schema.required, ['answer', 'citations']); assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.citations.items.enum, ['shipping-1', 'product-1']);
  assert.equal(localAnswerSchema({ chunks: [] }).properties.citations.maxItems, 0);
  const prompt = JSON.stringify(answerMessages(prepared, { variant: 'structured', item }));
  assert.doesNotMatch(prompt, /REFERENCE MUST|needsCloud|confidence.*0\.0/);
  assert.equal(LOCAL_ANSWER_SETTINGS.answerMaxTokens, 384); assert.equal(SELF_CHECK_MAX_TOKENS, 128);
});
test('separate local self-check provides features while code decides the escalation flag', async () => {
  const requests = [], stages = [];
  const result = await generateLocalAnswer('llama3.1:8b', prepared, { item, dependencies: { call: callSequence([
    JSON.stringify({ answer: 'Two days.', citations: ['shipping-1'] }), JSON.stringify(goodCheck),
  ], requests) }, onStage: stage => stages.push(stage) });
  assert.equal(requests.length, 2); assert.equal(requests[0].options.maxTokens, 384); assert.equal(requests[1].options.maxTokens, 128);
  assert.deepEqual(requests[0].options.schema.properties.citations.items.enum, ['shipping-1', 'product-1']);
  assert.equal(requests[1].options.schema.properties.confidence.type, 'number');
  assert.deepEqual(stages.map(stage => stage.stage), ['local_answer', 'local_self_check']);
  assert.equal(result.answer.needsCloud, false); assert.equal(result.answer.confidence, .9);
  assert.equal(result.answer.features.hasValidCitations, true); assert.equal(result.answer.features.citationCount, 1);
  assert.doesNotMatch(JSON.stringify(requests), /REFERENCE MUST/);
});
test('self-check cannot force a route with a forged route field or out-of-range confidence', async () => {
  for (const check of [{ ...goodCheck, route: 'local' }, { ...goodCheck, confidence: 100 }, { ...goodCheck, needsCloud: false }]) {
    const result = await generateLocalAnswer('llama3.1:8b', prepared, { item, dependencies: { call: callSequence([
      JSON.stringify({ answer: 'Two days.', citations: ['shipping-1'] }), JSON.stringify(check),
    ]) } });
    assert.equal(result.answer.selfCheckParseValid, false); assert.equal(result.answer.needsCloud, true); assert.equal(result.answer.confidence, 0);
  }
});
test('repair provenance is retained, unknown citations rejected before scoring and rejected answers cannot route locally', async () => {
  const result = await generateLocalAnswer('gemma3:12b', prepared, { item, dependencies: { call: callSequence([
    JSON.stringify({ answer: 'Two days.', citations: [' [SHIPPING-1] ', 'invented-id'] }), JSON.stringify(goodCheck),
  ]) } });
  assert.deepEqual(result.answer.citations.map(cite => cite.chunkId), ['shipping-1']);
  assert.equal(result.answer.citationAudit.hadInvalidIds, true); assert.equal(result.answer.citationAudit.repaired.length, 1);
  assert.deepEqual(result.answer.citationAudit.rejectedIds, ['invented-id']); assert.equal(result.answer.needsCloud, true);
});
test('missing company citations and unsupported/incomplete self-checks fail closed', async () => {
  for (const [citations, check] of [[[], goodCheck], [['shipping-1'], { ...goodCheck, evidenceSupported: false }], [['shipping-1'], { ...goodCheck, answerComplete: false }], [['shipping-1'], { ...goodCheck, issues: ['calculation_uncertain'] }]]) {
    const result = await generateLocalAnswer('llama3.1:8b', prepared, { item, dependencies: { call: callSequence([
      JSON.stringify({ answer: 'Two days.', citations }), JSON.stringify(check),
    ]) } });
    assert.equal(result.answer.needsCloud, true);
  }
});
test('plain task-native JSON, arrays and PII placeholders survive citation extraction', () => {
  const text = '{"answer":[1, 2],"placeholder":"[[PII_NAME_123]]","field":"[first name]"}';
  assert.equal(extractPlainCitations(text, { chunks: [] }).answer, text);
  const plain = extractPlainCitations(`${text}\nTwo days. [cite: shipping-1] [cite: evil]`, prepared, { company: true });
  assert.ok(plain.answer.includes(text)); assert.deepEqual(plain.citations, ['shipping-1', 'evil']);
  assert.doesNotMatch(plain.answer, /cite:/);
  const parsed = parseGenerationAnswer('Two days. [shipping-1]', prepared, { variant: 'plain', company: true });
  assert.equal(parsed.answer, 'Two days.'); assert.equal(parsed.parseValid, true); assert.equal(parsed.citations[0].chunkId, 'shipping-1');
});
test('plain answer avoids a JSON parser and malformed structured envelopes remain visible failures', () => {
  assert.equal(parseGeneratedAnswer('Answer in prose.', { question: 'Task', chunks: [] }, { variant: 'plain' }).parseValid, true);
  assert.equal(parseGeneratedAnswer('', prepared, { variant: 'plain' }).parseValid, false);
  for (const value of ['{"answer":"Two days.","citations":[', JSON.stringify({ answer: 'Two days.', citations: [], confidence: 1 })]) {
    const result = parseGeneratedAnswer(value, prepared, { item }); assert.equal(result.parseValid, false); assert.equal(result.citationAudit.missingRequired, true);
  }
});
test('self-check prompt contains answer evidence but never references, model identity or an accepted-route field', () => {
  const generated = parseGeneratedAnswer(JSON.stringify({ answer: 'Two days.', citations: ['shipping-1'] }), prepared, { item });
  const text = JSON.stringify(selfCheckMessages(prepared, generated, { item }));
  assert.match(text, /PROPOSED ANSWER/); assert.match(text, /Dispatch takes two days/);
  assert.doesNotMatch(text, /REFERENCE MUST|llama3|gemma3|"route"/);
  assert.equal(parseSelfCheck('invalid').parseValid, false);
});
test('Ollama schema transport is loopback-only and retains fixed generation settings', async t => {
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, options) => { requests.push({ url, body: JSON.parse(options.body) }); return { ok: true, json: async () => ({ message: { content: '{}' }, prompt_eval_count: 2, eval_count: 1 }) }; });
  const schema = localAnswerSchema(prepared), result = await comparisonLocal('gemma3:12b', [{ role: 'user', content: 'fixture' }], { json: false, schema });
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(new URL(requests[0].url).hostname)); assert.deepEqual(requests[0].body.format, schema);
  assert.equal(requests[0].body.options.num_predict, 384); assert.equal(requests[0].body.options.num_ctx, 4096); assert.equal(requests[0].body.options.temperature, 0); assert.equal(requests[0].body.options.seed, 20261027);
  assert.equal(result.settings.schemaConstrained, true); assert.equal(result.settings.json, true);
  await assert.rejects(comparisonLocal('llama3.1:8b', [], { schema: 'not a schema' }), /schema/);
});
