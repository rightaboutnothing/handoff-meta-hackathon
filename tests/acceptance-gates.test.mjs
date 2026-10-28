import test from 'node:test';
import assert from 'node:assert/strict';
import { acceptanceSlice, evaluateAcceptanceGate, extractAcceptanceFeatures, partitionDevItems } from '../src/comparison/acceptance-gates.mjs';
import { validateCitations } from '../src/comparison/citations.mjs';
import { attachToolEvidence } from '../src/comparison/claim-citations.mjs';

const item = { id: 'safe-company', category: 'company-data single-doc', suite: 'company-rag', safety: { kind: 'safe', cloudEligible: true } };
const prepared = { question: 'What is the unit weight?', retrievalScore: .9, completeness: { score: 1 }, chunks: [{ chunkId: 'product-1', file: 'products/qr700.md', text: 'The weight is 2 kg.', hash: 'source-hash' }] };
function goodRow() {
  const audit = validateCitations(['product-1'], prepared), claim = { factual: true, text: 'The weight is 2 kg.', citations: audit.citations, citationAudit: audit };
  return { modelId: 'llama3.1:8b', answer: { answer: claim.text, confidence: .95, parseValid: true, selfCheckParseValid: true, needsCloud: false, citations: audit.citations, citationAudit: audit,
    selfCheck: { parseValid: true, confidence: .95, evidenceSupported: true, answerComplete: true, issues: [] },
    claimAudit: { complete: true, factualClaimCount: 1, coveredClaimCount: 1, missingClaimCount: 0, coverage: 1, claims: [claim] } },
    rawAnswer: { modelId: 'llama3.1:8b', tokens: { output: 80 }, settings: { maxTokens: 768 } }, rawCheck: { tokens: { output: 25 } } };
}
const gate = row => evaluateAcceptanceGate(item, row, prepared);
test('company acceptance requires successful answer/check, valid claims, complete runtime sources and known untruncated usage', () => {
  const result = gate(goodRow()); assert.equal(result.eligible, true); assert.equal(result.localOnly, false); assert.deepEqual(result.reasons, []); assert.equal(result.evidenceCompleteness, 1);
});
test('unknown and adversarial manifests remain local-only regardless of model confidence or malformed classifier data', () => {
  for (const change of [{ safety: { kind: 'red-team', cloudEligible: true } }, { suite: 'strongreject' }, { harmful: true }, { poisoning: true }, { safety: undefined }, { category: 'unknown' }]) {
    const result = evaluateAcceptanceGate({ ...item, ...change }, goodRow(), prepared); assert.equal(result.localOnly, true); assert.equal(result.eligible, false); assert.equal(result.route, 'local_only_safety');
  }
});
test('actual cap and length metadata auto-escalate even syntactically valid complete JSON', () => {
  for (const patch of [{ tokens: { output: 768 } }, { done_reason: 'length' }, { finish_reason: 'max_tokens' }, { tokens: { output: 384 }, settings: { maxTokens: 384 } }]) {
    const row = goodRow(); row.rawAnswer = { ...row.rawAnswer, ...patch }; assert.equal(gate(row).eligible, false); assert.ok(gate(row).reasons.includes('answer_truncated'));
  }
  const row = goodRow(); row.cohort = 'plain50'; row.rawAnswer.tokens.output = 384; assert.equal(gate(row).answerCap, 384); assert.equal(gate(row).eligible, false);
});
test('self-check cap hits and missing usage are independently rejected', () => {
  for (const patch of [{ tokens: { output: 128 } }, { done_reason: 'length' }, { tokens: {} }]) { const row = goodRow(); row.rawCheck = patch; assert.equal(gate(row).eligible, false); }
  const row = goodRow(); delete row.rawAnswer.tokens; assert.ok(gate(row).reasons.includes('answer_usage_unknown'));
});
test('self-check or parser defects fail the gate independently of a high numeric confidence', () => {
  for (const mutate of [row => { row.answer.parseValid = false; }, row => { row.answer.selfCheckParseValid = false; }, row => { row.answer.selfCheck.evidenceSupported = false; }, row => { row.answer.selfCheck.answerComplete = false; }, row => { row.answer.selfCheck.issues = ['calculation_uncertain']; }, row => { row.answer.needsCloud = true; }, row => { row.error = 'LOCAL_FAILED'; }, row => { row.answer.selfCheck.confidence = 100; }]) { const row = goodRow(); mutate(row); assert.equal(gate(row).eligible, false); }
});
test('invented, unrepaired and missing claim citations cannot be overridden by aggregate validity metadata', () => {
  const invented = goodRow(); invented.answer.citations = [{ chunkId: 'invented-id', valid: true }]; assert.ok(gate(invented).reasons.includes('citation_id_not_retrieved'));
  const hidden = goodRow(); hidden.answer.claimAudit.claims[0].citations = [{ chunkId: 'invented-id', valid: true }]; assert.ok(gate(hidden).reasons.includes('claim_citations_incomplete'));
  const rejected = goodRow(); rejected.answer.citationAudit = { ...rejected.answer.citationAudit, remainingInvalidCount: 1, rejectedIds: ['invented'] }; assert.equal(gate(rejected).eligible, false);
  const missing = goodRow(); missing.answer.claimAudit = { complete: true, factualClaimCount: 1, coveredClaimCount: 1, missingClaimCount: 0 }; assert.equal(gate(missing).eligible, false);
});
test('only runtime completeness matters; oracle sources and rubric correctness cannot change runtime gates', () => {
  const row = goodRow(), result = gate(row); row.scoring = { score: 0, wrong: true }; row.oracleEvidence = { complete: false, score: 0 }; row.reference = { expectedSourceFiles: ['absent'] };
  assert.deepEqual(gate(row), result);
  assert.equal(evaluateAcceptanceGate(item, row, { ...prepared, completeness: { score: .999 } }).eligible, false);
  assert.equal(evaluateAcceptanceGate(item, row, { ...prepared, completeness: undefined }).eligible, false);
  assert.equal(evaluateAcceptanceGate(item, row, { ...prepared, retrievalScore: .34 }).eligible, false);
  assert.equal(evaluateAcceptanceGate(item, row, { ...prepared, bestMatchScore: .34 }).eligible, false);
});
test('general questions need no company documents or citations and explicitly mark completeness not applicable', () => {
  const general = { ...item, category: 'reasoning', suite: 'gpqa' }, row = goodRow(); row.answer.citations = []; row.answer.citationAudit = validateCitations([], { chunks: [] }, { requireCitations: false }); delete row.answer.claimAudit;
  const result = evaluateAcceptanceGate(general, row, { question: 'A general question', chunks: [] }); assert.equal(result.eligible, true); assert.equal(result.evidenceCompleteness, null); assert.equal(result.evidenceCompletenessApplicable, false); assert.equal(acceptanceSlice(general), 'general');
});
test('verified deterministic tool metadata is required for the calculator cap exemption', () => {
  const tool = { status: 'computed', toolId: 'local-tool', sourceChunkIds: ['product-1'], calculations: [{ result: 10, sourceChunkIds: ['product-1'] }], claims: [{ text: 'Five units weigh 10 kg.', sourceChunkIds: ['product-1'] }] };
  const attached = attachToolEvidence(prepared, tool), row = goodRow(), audit = validateCitations([attached.toolId, 'product-1'], attached.prepared);
  row.answer.toolId = attached.toolId; row.answer.toolProvenance = attached.provenance; row.answer.citations = audit.citations; row.answer.citationAudit = audit;
  row.answer.claimAudit.claims[0].citations = audit.citations; row.answer.claimAudit.claims[0].citationAudit = audit;
  row.rawAnswer = { modelId: 'deterministic-local-calculator', isToolResult: true, tokens: { output: 0 } };
  const result = evaluateAcceptanceGate(item, row, attached.prepared); assert.equal(result.calculatorVerified, true); assert.equal(result.eligible, true);
  row.rawAnswer.isToolResult = false; assert.equal(evaluateAcceptanceGate(item, row, attached.prepared).calculatorVerified, false);
  row.rawAnswer.tokens.output = 768; assert.equal(evaluateAcceptanceGate(item, row, attached.prepared).eligible, false);
});
test('feature allowlist contains only answer-time values and cannot pick up labels or question/reference text', () => {
  const row = goodRow(); row.scoring = { score: 1, secret: 'REFERENCE_SECRET' }; const changedItem = { ...item, prompt: 'QUESTION_SECRET', reference: { answer: 'REFERENCE_SECRET' } }, features = extractAcceptanceFeatures(changedItem, row, prepared);
  assert.doesNotMatch(JSON.stringify(features), /REFERENCE_SECRET|QUESTION_SECRET|safe-company|weight is/); assert.equal(features.slice, 'company'); assert.equal(features.calculatorVerified, false); assert.equal(features.sourceDocCount, 1);
  for (const [key, value] of Object.entries(features)) if (!['category', 'slice'].includes(key)) assert.ok(typeof value === 'number' || typeof value === 'boolean', key);
});
test('item-role partition is fixed before labels, covers every dev ID and discloses shared source families', () => {
  const rows = [...Array.from({ length: 195 }, (_, i) => ({ id: 'c'+i, split: 'dev-train', category: 'company-data multi-doc', groupId: 'company-family-'+i%6 })), ...Array.from({ length: 625 }, (_, i) => ({ id: 'g'+i, split: 'dev-train', category: 'reasoning', groupId: 'general-'+i }))], expectedDevIds = rows.map(row => row.id);
  const a = partitionDevItems(rows, { expectedDevIds }), b = partitionDevItems([...rows].reverse(), { expectedDevIds }); assert.equal(a.assignmentHash, b.assignmentHash); assert.equal(a.allItemsAssigned, true); assert.equal(Object.keys(a.assignments).length, 820);
  assert.deepEqual(Object.fromEntries(Object.entries(a.slices.company.roles).map(([k,v]) => [k,v.items])), { fit: 78, select: 19, calib: 78, audit: 20 });
  assert.deepEqual(Object.fromEntries(Object.entries(a.slices.general.roles).map(([k,v]) => [k,v.items])), { fit: 250, select: 62, calib: 250, audit: 63 }); assert.equal(a.slices.company.groups, 6); assert.equal(a.slices.company.sharedGroups, 6); assert.match(a.guaranteeScope, /not source-group-disjoint/);
  rows.forEach(row => { row.reference = { answer: 'changed' }; row.scoring = { score: 0 }; }); assert.equal(partitionDevItems(rows, { expectedDevIds }).assignmentHash, a.assignmentHash);
});
test('partition rejects test leakage, duplicates or a different registered frame', () => {
  const row = { id: 'd', split: 'dev-train', category: 'knowledge' };
  assert.throws(() => partitionDevItems([{ ...row, split: 'test' }]), /test data/); assert.throws(() => partitionDevItems([row, row]), /unique/);
  assert.throws(() => partitionDevItems([row], { expectedDevIds: ['other'] }), /exact registered/); assert.throws(() => partitionDevItems([{ ...row, split: undefined }]), /test data/);
  assert.throws(() => partitionDevItems([row], { roles: { fit: .5, audit: .5 } }), /ordered/);
});
