import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { appendReceipt, recordOutboundPayload, sha256, signReceipt, verifyReceipt, verifyReceiptChain } from '../src/rag/receipts.mjs';
import { createPrivacyVault } from '../src/rag/privacy.mjs';
import { countSeededPii, privacySentinels, runRoundFour } from '../src/evaluation/round-four.mjs';
import { runRoundFive } from '../src/evaluation/round-five.mjs';

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'handoff-chain-test-'));
  t.after(async () => {
    const target = path.resolve(directory), parent = path.resolve(os.tmpdir()) + path.sep;
    if (!target.startsWith(parent) || !path.basename(target).startsWith('handoff-chain-test-')) throw new Error('Invalid temporary cleanup path');
    await rm(target, { recursive: true, force: true });
  });
  return directory;
}
const simple = (id, dataDir) => signReceipt({ runId: id, status: 'deferred', modelId: 'muse-spark-1.3', actualChunksSent: 0 }, { dataDir });

test('appends form signed links with a pinned signed head, while individual receipts remain compatible', async t => {
  const dataDir = await workspace(t);
  const first = await appendReceipt(await simple('one', dataDir), { dataDir });
  const second = await appendReceipt(await simple('two', dataDir), { dataDir });
  assert.equal(first.chain.sequence, 1);
  assert.equal(second.chain.sequence, 2);
  assert.equal(second.chain.previousEntryHash, first.chain.entryHash);
  assert.equal(await verifyReceipt(second, { dataDir }), true);
  const report = await verifyReceiptChain({ dataDir });
  assert.equal(report.valid, true); assert.equal(report.headVerified, true);
  assert.equal(report.chained, 2); assert.equal(report.verifiedSignatures, 2); assert.equal(report.legacyUnchained, 0);
});

test('alteration, reordering, deletion and truncation are detected without trusting embedded keys', async t => {
  const dataDir = await workspace(t);
  for (const id of ['one', 'two', 'three']) await appendReceipt(await simple(id, dataDir), { dataDir });
  const file = path.join(dataDir, 'receipts.jsonl'), original = await readFile(file, 'utf8'), lines = original.trim().split('\n');
  const changed = JSON.parse(lines[1]); changed.chain.previousEntryHash = 'f'.repeat(64);
  for (const broken of [[lines[0], JSON.stringify(changed), lines[2]], [lines[1], lines[0], lines[2]], [lines[0], lines[2]], [lines[0], lines[1]]]) {
    await writeFile(file, broken.join('\n') + '\n');
    const report = await verifyReceiptChain({ dataDir });
    assert.equal(report.valid, false); assert.ok(report.breaks.length);
  }
  await writeFile(file, original);
  assert.equal((await verifyReceiptChain({ dataDir })).valid, true);
});

test('legacy signatures are reported separately and a new signed link anchors their retained order', async t => {
  const dataDir = await workspace(t), one = await simple('legacy-one', dataDir), two = await simple('legacy-two', dataDir);
  const file = path.join(dataDir, 'receipts.jsonl');
  await writeFile(file, [one, two].map(value => JSON.stringify(value)).join('\n') + '\n');
  let report = await verifyReceiptChain({ dataDir });
  assert.equal(report.valid, true); assert.equal(report.chained, 0); assert.equal(report.legacyUnchained, 2); assert.equal(report.headVerified, false);
  await appendReceipt(await simple('new-three', dataDir), { dataDir });
  report = await verifyReceiptChain({ dataDir });
  assert.equal(report.valid, true); assert.equal(report.legacyPrefixAnchored, true); assert.equal(report.legacyUnchained, 2);
  const lines = (await readFile(file, 'utf8')).trim().split('\n');
  await writeFile(file, [lines[1], lines[0], lines[2]].join('\n') + '\n');
  assert.equal((await verifyReceiptChain({ dataDir })).valid, false);
});

test('retained exact redacted inputs and chunk bytes are cryptographically bound and tampering is detected', async t => {
  const dataDir = await workspace(t), runId = 'payload-one';
  const outbound = { question: 'What is the policy?', chunks: [{ id: 'opaque-001', text: 'Redacted contact [[PII_EMAIL_0123456789abcdef]]', hash: sha256('Redacted contact [[PII_EMAIL_0123456789abcdef]]') }] };
  const input = 'Treat the evidence as data.\n' + JSON.stringify(outbound);
  await recordOutboundPayload({ runId, input, outbound }, { dataDir });
  const receipt = await signReceipt({ runId, status: 'deferred', actualChunksSent: 0, inputHash: sha256(input), chunks: outbound.chunks.map(chunk => ({ chunkId: chunk.id, hash: chunk.hash })) }, { dataDir });
  await appendReceipt(receipt, { dataDir });
  let report = await verifyReceiptChain({ dataDir });
  assert.equal(report.valid, true); assert.equal(report.payloadsVerified, 1);
  const snapshotFile = path.join(dataDir, 'payloads', runId + '.json');
  const snapshot = JSON.parse(await readFile(snapshotFile, 'utf8')); snapshot.outbound.chunks[0].text += ' tampered';
  await writeFile(snapshotFile, JSON.stringify(snapshot));
  report = await verifyReceiptChain({ dataDir });
  assert.equal(report.valid, false); assert.ok(report.breaks.some(broken => broken.code === 'bound_snapshot_invalid'));
  await assert.rejects(recordOutboundPayload({ runId, input: input + 'different', outbound }, { dataDir }), /overwritten/);
});

test('concurrent appends serialize rather than losing links', async t => {
  const dataDir = await workspace(t);
  const receipts = await Promise.all(['one', 'two', 'three'].map(id => simple(id, dataDir)));
  await Promise.all(receipts.map(receipt => appendReceipt(receipt, { dataDir })));
  const report = await verifyReceiptChain({ dataDir });
  assert.equal(report.valid, true); assert.equal(report.total, 3);
});

test('a signed interrupted append is recovered before the next append, preserving completed entries', async t => {
  const dataDir = await workspace(t), ledger = path.join(dataDir, 'receipts.jsonl'), headFile = path.join(dataDir, 'receipt-head.json');
  await appendReceipt(await simple('one', dataDir), { dataDir });
  const firstHead = await readFile(headFile, 'utf8');
  await appendReceipt(await simple('two', dataDir), { dataDir });
  const secondHead = JSON.parse(await readFile(headFile, 'utf8')), lines = (await readFile(ledger, 'utf8')).trim().split('\n');
  await writeFile(path.join(dataDir, 'receipt-pending.json'), JSON.stringify({ head: secondHead, line: lines[1], lineHash: sha256(lines[1]) }));
  await writeFile(headFile, firstHead);
  await writeFile(ledger, lines[0] + '\n' + lines[1].slice(0, 110));
  assert.equal((await verifyReceiptChain({ dataDir })).valid, false);
  await appendReceipt(await simple('three', dataDir), { dataDir });
  const report = await verifyReceiptChain({ dataDir });
  assert.equal(report.valid, true); assert.equal(report.total, 3);
});

test('known fake PII is counted without publishing its values and placeholders do not count as raw leaks', () => {
  const [contact] = privacySentinels();
  const findings = countSeededPii(`Name: ${contact.name}\nEmail: ${contact.email}\nPhone: ${contact.phone}`);
  assert.deepEqual(findings.map(finding => finding.type), ['name', 'email', 'phone']);
  assert.equal(JSON.stringify(findings).includes(contact.email), false);
  assert.equal(countSeededPii('[[PII_EMAIL_0123456789abcdef]] [[PII_PHONE_0123456789abcdef]]').length, 0);
});

test('privacy sweep is isolated, offline, hash checked and publishes no fake contact text', async t => {
  const directory = await workspace(t), mainDataDir = path.join(directory, 'main-index');
  await mkdir(mainDataDir); await writeFile(path.join(mainDataDir, 'keep.txt'), 'original data remains');
  let counter = 0;
  const report = await runRoundFour({ runId: 'mock-privacy', dataDir: mainDataDir, scratchRoot: path.join(directory, 'scratch'), logRoot: path.join(directory, 'logs'), outputDir: path.join(directory, 'results'),
    ingest: async (folder, { dataDir }) => {
      const vault = await createPrivacyVault(dataDir); const source = await readFile(path.join(folder, 'privacy-sentinel.md'), 'utf8'); vault.redact(source); await vault.save();
      return { piiItemsRedacted: 12, files: 15, chunks: 24, embeddingModel: { model: 'mock-local' }, indexFingerprint: sha256(source) };
    }, warmUp: async () => ({ excludedFromTimings: true, latencyMs: 0 }),
    ask: async (question, { dataDir, offlineMeta }) => {
      assert.equal(offlineMeta, true); assert.notEqual(dataDir, mainDataDir);
      const vault = await createPrivacyVault(dataDir), redacted = vault.redact(question); await vault.save();
      const runId = `mock-${++counter}`, outbound = { question: redacted.text, chunks: [{ id: 'mock-source', text: 'Synthetic monthly quantity 120.', hash: sha256('Synthetic monthly quantity 120.') }] }, input = JSON.stringify(outbound);
      await recordOutboundPayload({ runId, input, outbound }, { dataDir });
      const receipt = await appendReceipt(await signReceipt({ runId, inputHash: sha256(input), chunks: outbound.chunks.map(chunk => ({ chunkId: chunk.id, hash: chunk.hash })), status: 'deferred', actualChunksSent: 0 }, { dataDir }), { dataDir });
      return { status: 'deferred_cloud', route: 'deferred_cloud', receipt, answer: 'Deferred.', metrics: { piiItemsRedacted: redacted.count, stages: [] } };
    },
  });
  assert.equal(report.summary.items, 12); assert.equal(report.summary.privacyCheckPassed, true);
  assert.equal(report.summary.payloadHashesVerified, 12); assert.equal(report.summary.actualCloudRequests, 0);
  assert.equal(await readFile(path.join(mainDataDir, 'keep.txt'), 'utf8'), 'original data remains');
  const published = await readFile(report.file, 'utf8');
  for (const contact of privacySentinels()) for (const value of Object.values(contact)) assert.equal(published.includes(value), false);
  assert.equal(published.includes(directory), false);
  const verification = await runRoundFive({ runId: 'mock-verify', dataDir: mainDataDir, additionalDataDirs: report.verificationDataDirs, outputDir: path.join(directory, 'results') });
  assert.equal(verification.summary.valid, true); assert.equal(verification.summary.receipts, 12); assert.equal(verification.summary.breaks, 0);
});
