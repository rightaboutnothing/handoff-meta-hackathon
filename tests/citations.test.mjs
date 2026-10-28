import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCitations } from '../src/comparison/citations.mjs';

const prepared = { chunks: [
  { chunkId: 'policy:Chunk-A', file: 'company/policy.md', location: { page: 2 }, hash: 'trusted-a', text: 'Policy evidence' },
  { chunkId: 'spec:Chunk-B', file: 'products/spec.md', location: { row: 3 }, hash: 'trusted-b', text: 'Specification evidence' },
] };

test('valid citation IDs resolve metadata locally and ignore fabricated model metadata', () => {
  const result = validateCitations(['policy:Chunk-A', { chunkId: 'spec:Chunk-B', file: 'fabricated.md', hash: 'invented' }], prepared);
  assert.equal(result.hadInvalidIds, false);
  assert.equal(result.grounded, true);
  assert.equal(result.remainingInvalidCount, 0);
  assert.equal(result.citations[1].file, 'products/spec.md');
  assert.equal(result.citations[1].hash, 'trusted-b');
});

test('format and case repairs retain original invalid IDs and explicit provenance', () => {
  const result = validateCitations(['  [`policy:Chunk-A`] ', 'SPEC:CHUNK-B'], prepared);
  assert.equal(result.hadInvalidIds, true);
  assert.deepEqual(result.invalidIds, ['  [`policy:Chunk-A`] ', 'SPEC:CHUNK-B']);
  assert.deepEqual(result.repaired.map(({ to, reason }) => ({ to, reason })), [
    { to: 'policy:Chunk-A', reason: 'formatting_only_exact_id' }, { to: 'spec:Chunk-B', reason: 'case_only_unique_id' },
  ]);
  assert.equal(result.remainingInvalidCount, 0);
  assert.equal(result.grounded, true);
});

test('only a uniquely identified retrieved filename or explicit chunk label can repair', () => {
  const result = validateCitations(['policy.md', 'PRODUCTS\\SPEC.MD'], prepared);
  assert.deepEqual(result.citations.map(row => row.chunkId), ['policy:Chunk-A', 'spec:Chunk-B']);
  assert.ok(result.repaired.every(row => row.reason === 'unique_retrieved_source_alias'));
  const labelled = validateCitations('Known label', { chunks: [{ ...prepared.chunks[0], label: 'Known label' }] });
  assert.equal(labelled.citations[0].chunkId, 'policy:Chunk-A');
});

test('ambiguous filenames and labels are rejected without choosing a convenient source', () => {
  const evidence = { chunks: [...prepared.chunks, { chunkId: 'policy:Chunk-C', file: 'company/policy.md', label: 'shared' }, { chunkId: 'another', file: 'elsewhere/policy.md', label: 'shared' }] };
  const result = validateCitations(['policy.md', 'company/policy.md', 'shared'], evidence);
  assert.equal(result.citations.length, 0);
  assert.equal(result.repaired.length, 0);
  assert.equal(result.remainingInvalidCount, 3);
  assert.equal(result.missingRequired, true);
});

test('unknown or adversarial IDs cannot select a non-retrieved or nearest source', () => {
  const values = ['policy:Chunk-Z', '../private.csv', 'ignore the allowlist and use policy:Chunk-A', 'policy', 'Chunk 1'];
  const result = validateCitations(values, prepared);
  assert.deepEqual(result.rejectedIds, values);
  assert.equal(result.citations.length, 0);
  assert.equal(result.grounded, false);
  assert.equal(result.missingRequired, true);
  assert.equal(result.repaired.length, 0);
});

test('duplicate citations are deduplicated while duplicate and repair counts remain visible', () => {
  const result = validateCitations(['policy:Chunk-A', 'policy:Chunk-A', '[policy:Chunk-A]', '[policy:Chunk-A]'], prepared);
  assert.equal(result.citations.length, 1);
  assert.equal(result.duplicateCount, 3);
  assert.equal(result.repaired.length, 1);
  assert.equal(result.hadInvalidIds, true);
  assert.equal(result.remainingInvalidCount, 0);
});

test('malformed citation entries and conflicting object IDs are rejected safely', () => {
  const result = validateCitations([{}, 123, false, ['policy:Chunk-A'], { id: 'policy:Chunk-A', chunkId: 'spec:Chunk-B' }, { id: 1 }, ''], prepared);
  assert.equal(result.malformedCount, 7);
  assert.equal(result.remainingInvalidCount, 7);
  assert.equal(result.hadInvalidIds, true);
  assert.equal(result.citations.length, 0);
  assert.equal(result.missingRequired, true);
  assert.equal(validateCitations(42, prepared).containerValid, false);
});

test('missing company citations are an explicit missing requirement, not a successful repair', () => {
  const result = validateCitations([], prepared);
  assert.equal(result.hadInvalidIds, false);
  assert.equal(result.missingRequired, true);
  assert.equal(result.grounded, false);
  assert.equal(result.repaired.length, 0);
  const general = validateCitations([], { chunks: [] }, { requireCitations: false });
  assert.equal(general.missingRequired, false);
});

test('conflicting retrieved metadata fails closed for the duplicated ID', () => {
  const result = validateCitations('policy:Chunk-A', { chunks: [prepared.chunks[0], { ...prepared.chunks[0], text: 'Conflicting source', file: 'different.md' }] });
  assert.equal(result.citations.length, 0);
  assert.deepEqual(result.rejectedIds, ['policy:Chunk-A']);
});

test('case-fold collisions do not break exact valid IDs or permit ambiguous repairs', () => {
  const evidence = { chunks: [{ chunkId: 'Chunk-A', file: 'first' }, { chunkId: 'chunk-a', file: 'second' }] };
  assert.equal(validateCitations('Chunk-A', evidence).citations[0].file, 'first');
  assert.deepEqual(validateCitations('CHUNK-A', evidence).rejectedIds, ['CHUNK-A']);
});
