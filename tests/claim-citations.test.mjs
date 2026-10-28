import test from 'node:test';
import assert from 'node:assert/strict';
import { auditInlineClaimCitations, auditStructuredClaimCitations, assertionSegments, attachToolEvidence } from '../src/comparison/claim-citations.mjs';
import { generateLocalAnswer, localAnswerSchema, parseGeneratedAnswer } from '../src/comparison/local-answer.mjs';
import { calculateLocal } from '../src/rag/calculators.mjs';

const prepared = { question: 'Give the price and freight.', retrievalScore: .8, sourceDocCount: 2, chunks: [
  { chunkId: 'price-1', file: 'product.md', text: 'Price is 100 dollars.', hash: 'p' },
  { chunkId: 'freight-1', file: 'shipping.md', text: 'Freight is 35 dollars.', hash: 'f' },
] };
const item = { category: 'company-data multi-doc' };
const response = text => ({ text, modelId: 'llama3.1:8b', latencyMs: 1, tokens: { input: 10, output: 5, total: 15 } });
const check = JSON.stringify({ confidence: .9, evidenceSupported: true, answerComplete: true, issues: [] });

test('each sentence needs a citation; a global trailing citation covers only its own claim', () => {
  const complete = auditInlineClaimCitations('The price is $100. [cite: price-1] Freight is $35. [cite: freight-1]', prepared);
  assert.equal(complete.factualClaimCount, 2); assert.equal(complete.coveredClaimCount, 2); assert.equal(complete.complete, true);
  const gap = auditInlineClaimCitations('The price is $100. Freight is $35. [cite: freight-1]', prepared);
  assert.equal(gap.factualClaimCount, 2); assert.equal(gap.coveredClaimCount, 1); assert.equal(gap.missingClaimCount, 1); assert.equal(gap.complete, false);
});
test('independent clauses are checked separately and decimal values are not sentence boundaries', () => {
  const gap = auditInlineClaimCitations('The price is $100.50 and freight is $35.20 [cite: freight-1].', prepared);
  assert.equal(gap.factualClaimCount, 2); assert.equal(gap.coveredClaimCount, 1);
  assert.deepEqual(assertionSegments('Price $100.50. Freight $35.20.'), ['Price $100.50', 'Freight $35.20']);
});
test('claims preserve invalid-ID errors and never borrow a valid source from another claim', () => {
  const audit = auditStructuredClaimCitations([{ text: 'Price is $100.', citations: ['price-1'] }, { text: 'Freight is $35.', citations: ['invented-id'] }], prepared);
  assert.equal(audit.coveredClaimCount, 1); assert.equal(audit.invalidClaimCount, 1); assert.equal(audit.complete, false);
  assert.deepEqual(audit.citationAudit.citations.map(citation => citation.chunkId), ['price-1']);
  assert.deepEqual(audit.citationAudit.rejectedIds, ['invented-id']);
  const embedded = auditStructuredClaimCitations([{ text: 'Price is $100. [cite: invented-id]', citations: ['price-1'] }], prepared);
  assert.equal(embedded.complete, false); assert.equal(embedded.citationAudit.hadInvalidIds, true); assert.doesNotMatch(embedded.renderedAnswer, /invented-id/);
  const parsed = parseGeneratedAnswer(JSON.stringify({ answer: 'Price $100. Freight $35.', citations: ['price-1'] }), prepared, { item, requireClaimCitations: true });
  assert.equal(parsed.parseValid, false); assert.equal(parsed.claimAudit.complete, false);
  assert.equal(parseGeneratedAnswer(JSON.stringify({ claims: [{ text: 42, citations: [] }] }), prepared, { item, requireClaimCitations: true }).parseValid, false);
});
test('an absence/refusal statement is not counted as a supported factual answer', () => {
  const audit = auditInlineClaimCitations('Insufficient evidence to calculate this.', prepared);
  assert.equal(audit.factualClaimCount, 0); assert.equal(audit.coverage, null); assert.equal(audit.complete, false);
});
test('claim mode constrains every claim ID while the historical schema remains unchanged', () => {
  const schema = localAnswerSchema(prepared, { company: true, requireClaimCitations: true });
  assert.deepEqual(schema.required, ['claims']); assert.deepEqual(schema.properties.claims.items.properties.citations.items.enum, ['price-1', 'freight-1']);
  assert.deepEqual(localAnswerSchema(prepared).required, ['answer', 'citations']);
});
test('a 768-token answer cap is explicit; self-check remains 128 and missing claim citations force code escalation', async () => {
  const calls = [];
  const result = await generateLocalAnswer('llama3.1:8b', prepared, { item, variant: 'plain', answerMaxTokens: 768, requireClaimCitations: true,
    dependencies: { call: async (model, messages, options) => { calls.push(options); return response(calls.length === 1 ? 'Price is $100. Freight is $35. [cite: freight-1]' : check); } } });
  assert.equal(calls[0].maxTokens, 768); assert.equal(calls[1].maxTokens, 128); assert.equal(result.answer.needsCloud, true); assert.equal(result.answer.claimAudit.missingClaimCount, 1);
  await assert.rejects(generateLocalAnswer('llama3.1:8b', prepared, { answerMaxTokens: 1025 }), /token cap/);
});

const tool = { applicable: true, status: 'computed', toolId: 'local-calculator-v1', latencyMs: .2, sourceChunkIds: ['price-1', 'freight-1'],
  calculations: [{ expression: '100 + 35', operands: [100, 35], result: 135, unit: 'USD', sourceChunkIds: ['price-1', 'freight-1'] }],
  answerText: 'The total is $135.', claims: [{ text: 'The total is $135.', sourceChunkIds: ['price-1', 'freight-1'] }] };
test('trusted calculator evidence has stable hashes and verified retrieved operand provenance', () => {
  const first = attachToolEvidence(prepared, tool), second = attachToolEvidence(prepared, tool);
  assert.equal(first.toolId, second.toolId); assert.match(first.toolId, /^calc:[a-f0-9]{64}$/); assert.equal(first.prepared.sourceDocCount, 2);
  assert.deepEqual(first.claims[0].citations, [first.toolId, 'price-1', 'freight-1']); assert.equal(first.chunk.verifiedLocalTool, true);
  assert.throws(() => attachToolEvidence(prepared, { ...tool, sourceChunkIds: ['forged-source'] }), /retrieved source/);
  assert.throws(() => attachToolEvidence(prepared, { ...tool, claims: [{ text: 'Forged', sourceChunkIds: ['forged'] }] }), /unverified/);
});
test('fully computed tool results bypass model answering and cannot be rewritten by the checker', async () => {
  const calls = [];
  const result = await generateLocalAnswer('gemma3:12b', prepared, { item, variant: 'structured', answerMaxTokens: 768, requireClaimCitations: true, toolResult: tool,
    dependencies: { call: async (model, messages, options) => { calls.push({ messages, options }); return response(check); } } });
  assert.equal(calls.length, 1); assert.equal(calls[0].options.maxTokens, 128); assert.equal(result.answer.answer, 'The total is $135.');
  assert.deepEqual(result.stages.map(stage => stage.stage), ['local_calculator', 'local_self_check']); assert.equal(result.stages[0].tokens.total, 0);
  assert.equal(result.answer.claimAudit.complete, true); assert.ok(result.answer.renderedAnswer.includes(`[cite: ${result.calculator.toolId}]`));
  assert.equal(result.answer.citations.length, 3); assert.equal(result.answer.needsCloud, false);
});
test('partial tools never bypass the local answer and task-native noncompany JSON remains unchanged', async () => {
  const calls = [];
  const result = await generateLocalAnswer('llama3.1:8b', { question: 'Return JSON', chunks: [] }, { item: { category: 'instruction-following' }, variant: 'plain', requireClaimCitations: true,
    toolResult: { status: 'unsupported' }, dependencies: { call: async (_model, _messages, options) => { calls.push(options); return response(calls.length === 1 ? '{"values":[1,2]}' : check); } } });
  assert.equal(calls.length, 2); assert.equal(result.answer.answer, '{"values":[1,2]}'); assert.equal(result.answer.claimAudit, undefined);
});
test('closed question-only arithmetic cites the hashed local calculation without fabricating document sources', async () => {
  const question = 'What is 15% of 80?', toolResult = calculateLocal(question, []), context = { question, chunks: [], retrievalScore: 0, sourceDocCount: 0 };
  assert.equal(toolResult.status, 'computed');
  const evidence = attachToolEvidence(context, toolResult);
  assert.equal(evidence.provenance.questionOnly, true); assert.deepEqual(evidence.provenance.sources, []);
  assert.deepEqual(evidence.claims[0].citations, [evidence.toolId]);
  const result = await generateLocalAnswer('llama3.1:8b', context, { item: { category: 'instruction-following' }, toolResult,
    dependencies: { call: async (_model, messages) => { assert.match(messages[1].content, /VERIFIED LOCAL CALCULATOR RESULT/); return response(check); } } });
  assert.match(result.answer.answer, /12/); assert.equal(result.stages[0].stage, 'local_calculator'); assert.equal(result.answer.claimAudit.complete, true);
  assert.throws(() => attachToolEvidence(context, { ...toolResult, arithmeticIntent: 'company-price', calculations: toolResult.calculations }), /allowlisted question-only/);
  assert.throws(() => attachToolEvidence(context, { ...toolResult, calculations: [{ ...toolResult.calculations[0], operands: [{ value: 100, sourceChunkIds: [], origin: 'retrieved_evidence' }] }] }), /allowlisted question-only/);
});
