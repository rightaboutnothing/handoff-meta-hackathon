import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, unlink, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { openReceiptJournal } from '../src/comparison/receipt-journal.mjs';
import { appendReceipt, recordOutboundPayload, sha256, signReceipt, verifyReceipt, verifyReceiptChain } from '../src/rag/receipts.mjs';

const directory = () => mkdtemp(path.join(os.tmpdir(), 'handoff-fast-receipt-'));
async function fixture(dataDir, runId, overrides = {}) {
  const input = `Synthetic safe input ${runId}`;
  const chunk = { id: `chunk-${runId}`, text: `Synthetic source ${runId}` };
  chunk.hash = sha256(chunk.text);
  await recordOutboundPayload({ runId, input, outbound: { chunks: [chunk] } }, { dataDir });
  return signReceipt({ runId, pipelineId: 'mock-pipeline', itemId: runId, inputHash: sha256(input), modelId: 'mock-cloud', status: 'sent', chunks: [{ chunkId: chunk.id, hash: chunk.hash }], createdAt: '2026-10-28T00:00:00Z', ...overrides }, { dataDir });
}
test('constant-work appends retain existing Ed25519 chain and signed-head compatibility', async () => {
  const dataDir = await directory(), journal = await openReceiptJournal({ dataDir });
  const first = await journal.append(await fixture(dataDir, 'one'));
  const second = await journal.append(await fixture(dataDir, 'two'));
  assert.equal(first.chain.sequence, 1); assert.equal(second.chain.previousEntryHash, first.chain.entryHash);
  assert.equal(await verifyReceipt(second, { dataDir }), true);
  const report = await journal.close();
  assert.equal(report.valid, true); assert.equal(report.total, 2); assert.equal(report.payloadsVerified, 2);
  assert.equal(report.verifiedSignatures, 2); assert.equal(report.headVerified, true);
  assert.equal((await verifyReceiptChain({ dataDir })).valid, true);
  assert.deepEqual(await journal.close(), report);
  await assert.rejects(journal.append(first), /closed/);
});
test('concurrent appends serialize without duplicate links or lost updates', async () => {
  const dataDir = await directory(), journal = await openReceiptJournal({ dataDir });
  const receipts = await Promise.all(['one', 'two', 'three'].map(id => fixture(dataDir, id)));
  const saved = await Promise.all(receipts.map(receipt => journal.append(receipt)));
  assert.deepEqual(saved.map(receipt => receipt.chain.sequence), [1, 2, 3]);
  assert.equal((await journal.close()).total, 3);
});
test('repeated/resumed semantic events reuse the original receipt despite a new creation timestamp', async () => {
  const dataDir = await directory();
  let journal = await openReceiptJournal({ dataDir });
  const first = await journal.append(await fixture(dataDir, 'one'));
  assert.equal((await journal.append(await fixture(dataDir, 'one', { createdAt: '2026-10-29T00:00:00Z' }))).signature, first.signature);
  assert.equal((await journal.close()).total, 1);
  journal = await openReceiptJournal({ dataDir });
  assert.equal((await journal.append(await fixture(dataDir, 'one', { createdAt: '2026-10-30T00:00:00Z' }))).signature, first.signature);
  const report = await journal.close(); assert.equal(report.total, 1); assert.equal(report.valid, true);
});
test('a different event payload cannot overwrite a committed event identity', async () => {
  const dataDir = await directory(), journal = await openReceiptJournal({ dataDir });
  await journal.append(await fixture(dataDir, 'one'));
  await assert.rejects(journal.append(await fixture(dataDir, 'one', { itemId: 'different' })), /different content/);
  const report = await journal.close(); assert.equal(report.valid, false);
  assert(report.breaks.some(row => row.code === 'comparison_journal_append_failed'));
});
test('old payloads are not rescanned per append but their tampering fails the mandatory final audit', async () => {
  const dataDir = await directory(), journal = await openReceiptJournal({ dataDir });
  await journal.append(await fixture(dataDir, 'one'));
  const file = path.join(dataDir, 'payloads', 'one.json');
  const snapshot = JSON.parse(await readFile(file, 'utf8')); snapshot.input += ' tampered';
  await writeFile(file, JSON.stringify(snapshot));
  // This succeeds precisely because only the new receipt/snapshot is checked.
  await journal.append(await fixture(dataDir, 'two'));
  const report = await journal.close();
  assert.equal(report.valid, false); assert.equal(report.total, 2);
  assert(report.breaks.some(row => row.code === 'payload_hash_mismatch' || row.code === 'bound_snapshot_invalid'));
  await assert.rejects(openReceiptJournal({ dataDir }), /startup audit failed/);
});
test('external ledger/head modification fails closed before another append', async () => {
  for (const target of ['receipts.jsonl', 'receipt-head.json']) {
    const dataDir = await directory(), journal = await openReceiptJournal({ dataDir });
    await journal.append(await fixture(dataDir, 'one'));
    const file = path.join(dataDir, target), original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('sent', 'evil'));
    await utimes(file, new Date('2020-01-01'), new Date('2020-01-01'));
    await assert.rejects(journal.append(await fixture(dataDir, 'two')), /changed outside/);
    assert.equal((await journal.close()).valid, false);
  }
});
test('startup rejects a missing signed head and a receipt lacking an exact payload snapshot', async () => {
  const dataDir = await directory();
  await appendReceipt(await fixture(dataDir, 'one'), { dataDir });
  await unlink(path.join(dataDir, 'receipt-head.json'));
  await assert.rejects(openReceiptJournal({ dataDir }), /startup audit failed/);
  const missingDir = await directory();
  await appendReceipt(await signReceipt({ runId: 'missing', status: 'sent' }, { dataDir: missingDir }), { dataDir: missingDir });
  await assert.rejects(openReceiptJournal({ dataDir: missingDir }), /startup audit failed/);
});
test('shared pending-journal recovery preserves a torn append and resumes the compatible chain', async () => {
  const dataDir = await directory(), ledger = path.join(dataDir, 'receipts.jsonl'), head = path.join(dataDir, 'receipt-head.json');
  await appendReceipt(await fixture(dataDir, 'one'), { dataDir });
  const firstHead = await readFile(head, 'utf8');
  await appendReceipt(await fixture(dataDir, 'two'), { dataDir });
  const nextHead = JSON.parse(await readFile(head, 'utf8')), lines = (await readFile(ledger, 'utf8')).trim().split('\n');
  await writeFile(path.join(dataDir, 'receipt-pending.json'), JSON.stringify({ head: nextHead, line: lines[1], lineHash: sha256(lines[1]) }));
  await writeFile(head, firstHead);
  await writeFile(ledger, `${lines[0]}\n${lines[1].slice(0, 100)}`);
  const journal = await openReceiptJournal({ dataDir });
  const saved = await journal.append(await fixture(dataDir, 'three'));
  assert.equal(saved.chain.sequence, 3);
  const report = await journal.close(); assert.equal(report.valid, true); assert.equal(report.total, 3);
});
test('a live journal holds the exclusive receipt lock and releases it on close', async () => {
  const dataDir = await directory(), journal = await openReceiptJournal({ dataDir });
  const receipt = await fixture(dataDir, 'one');
  await journal.append(receipt);
  const { acquireRunLock } = await import('../src/comparison/run-lock.mjs');
  await assert.rejects(acquireRunLock(path.join(dataDir, 'receipts.lock')), /lock|running|held|owned|busy/i);
  assert.equal((await journal.close()).valid, true);
  const release = await acquireRunLock(path.join(dataDir, 'receipts.lock')); await release();
});
test('the in-memory trust anchor stays pinned through the final audit', async () => {
  const dataDir = await directory(), journal = await openReceiptJournal({ dataDir });
  await journal.append(await fixture(dataDir, 'one'));
  const alternate = await directory(); await fixture(alternate, 'other-key');
  await writeFile(path.join(dataDir, 'keys', 'receipt-public.pem'), await readFile(path.join(alternate, 'keys', 'receipt-public.pem')));
  assert.equal((await journal.close()).valid, false);
});
test('receipt failures expose a hard-stop code and prevent all subsequent appends', async () => {
  const dataDir = await directory(), journal = await openReceiptJournal({ dataDir });
  const receipt = await fixture(dataDir, 'one');
  await assert.rejects(journal.append({ ...receipt, signature: 'invalid' }), { code: 'RECEIPT_INTEGRITY_FAILURE' });
  await assert.rejects(journal.append(receipt), error => error.code === 'RECEIPT_INTEGRITY_FAILURE' && /after an error/.test(error.message));
  const report = await journal.close(); assert.equal(report.valid, false); assert.equal(report.total, 0);
  await assert.rejects(journal.append(receipt), { code: 'RECEIPT_INTEGRITY_FAILURE' });
  await assert.rejects(openReceiptJournal(), { code: 'RECEIPT_INTEGRITY_FAILURE' });
});
