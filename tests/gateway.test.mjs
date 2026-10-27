import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { askRag, estimateTokens } from '../src/rag/gateway.mjs';
import { createPrivacyVault } from '../src/rag/privacy.mjs';
import { sha256, verifyReceipt } from '../src/rag/receipts.mjs';
import { ragConfig } from '../src/server/gateway-models.mjs';

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'handoff-gateway-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function permitInjectedCloud(t) {
  // Only injected functions run in these tests; no provider or model is called.
  const previous = [process.env.META_ACCESS_STATUS, process.env.HANDOFF_META_ACCESS_CONFIRMED];
  process.env.META_ACCESS_STATUS = 'live';
  process.env.HANDOFF_META_ACCESS_CONFIRMED = 'true';
  t.after(() => {
    for (const [key, value] of [['META_ACCESS_STATUS', previous[0]], ['HANDOFF_META_ACCESS_CONFIRMED', previous[1]]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
}

const modelResponse = (answer, confidence = 0.95, citations = ['chunk-001'], needsCloud = false) => ({
  modelId: 'test-local-model', latencyMs: 2, tokens: { input: 30, output: 20, total: 50 },
  text: JSON.stringify({ answer, confidence, citations, needsCloud }),
});

const guardResponse = safe => ({
  modelId: 'test-local-guard', latencyMs: 1, tokens: { input: 20, output: 1, total: 21 },
  safe, reason: safe ? 'Synthetic safe classification' : 'Synthetic blocked classification',
});

const chunk = (index, text, score = 0.9) => ({
  chunkId: `chunk-${String(index).padStart(3, '0')}`, file: `synthetic-${index}.md`,
  location: 'page:1', text, score, hash: sha256(text), piiCount: 0,
});

function retrieveFixture(chunks) {
  return async () => ({ chunks, quality: 0.9, latencyMs: 1, embeddingModel: 'test-local-embedding' });
}

test('offline handoffs never call the cloud and produce a verifiable deferred receipt', async t => {
  permitInjectedCloud(t);
  const dataDir = await workspace(t);
  let cloudCalls = 0, guardCalls = 0;
  const result = await askRag('Analyse the synthetic warranty and suggest improvements.', {
    dataDir, offlineMeta: true,
    dependencies: {
      retrieve: retrieveFixture([chunk(1, 'Synthetic warranty lasts 24 months.')]),
      localChat: async () => modelResponse('More reasoning is needed.', 0.2, ['chunk-001'], true),
      guardText: async () => { guardCalls += 1; return guardResponse(true); },
      callMuse: async () => { cloudCalls += 1; throw new Error('Cloud calls are forbidden in this test'); },
    },
  });
  assert.equal(cloudCalls, 0);
  assert.equal(guardCalls, 1);
  assert.equal(result.status, 'deferred_cloud');
  assert.equal(result.route, 'deferred_cloud');
  assert.equal(result.metrics.tokensSentToCloud, 0);
  assert.equal(result.metrics.outboundChunks, 0);
  assert.equal(result.metrics.receiptVerified, true);
  assert.equal(result.receipt.payload.status, 'deferred');
  assert.equal(result.receipt.payload.actualChunksSent, 0);
  assert.equal(await verifyReceipt(result.receipt, { dataDir }), true);
  const saved = (await readFile(path.join(dataDir, 'receipts.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.equal(saved.length, 1);
  assert.equal(await verifyReceipt(saved[0], { dataDir }), true);
});

test('unsafe outbound content is blocked locally before any cloud call', async t => {
  permitInjectedCloud(t);
  const dataDir = await workspace(t);
  let cloudCalls = 0;
  const result = await askRag('Synthetic test request classified unsafe by the local guard.', {
    dataDir, offlineMeta: false,
    dependencies: {
      retrieve: retrieveFixture([chunk(1, 'SYNTHETIC TEST EVIDENCE')]),
      localChat: async () => modelResponse('Escalation required.', 0.1, ['chunk-001'], true),
      guardText: async () => guardResponse(false),
      callMuse: async () => { cloudCalls += 1; throw new Error('Unsafe content reached cloud'); },
    },
  });
  assert.equal(cloudCalls, 0);
  assert.equal(result.route, 'blocked_local');
  assert.equal(result.status, 'blocked_local');
  assert.equal(result.metrics.guardBlocks, 1);
  assert.equal(result.metrics.tokensSentToCloud, 0);
  assert.deepEqual(result.outbound, { question: '', chunks: [] });
  assert.equal(result.receipt, undefined);
});

test('local answers restore private placeholders and retain local source citations', async t => {
  const dataDir = await workspace(t);
  const vault = await createPrivacyVault(dataDir);
  const redacted = vault.redact('Name: Avery Chen\nEmail: avery@example.invalid\nWarranty: 24 months.');
  await vault.save();
  const contact = redacted.placeholders.find(value => value.includes('NAME'));
  let cloudCalls = 0, guardCalls = 0;
  const result = await askRag('Who owns the warranty process?', {
    dataDir,
    dependencies: {
      retrieve: retrieveFixture([chunk(1, redacted.text)]),
      localChat: async (_modelId, messages) => {
        assert.equal(messages[1].content.includes('Avery Chen'), false);
        assert.equal(messages[1].content.includes('avery@example.invalid'), false);
        return modelResponse(`${contact} owns the warranty process; the warranty is 24 months.`);
      },
      guardText: async () => { guardCalls += 1; return guardResponse(true); },
      callMuse: async () => { cloudCalls += 1; throw new Error('A grounded local answer should stay local'); },
    },
  });
  assert.equal(result.route, 'local');
  assert.equal(result.status, 'ok');
  assert.equal(result.answer, 'Avery Chen owns the warranty process; the warranty is 24 months.');
  assert.equal(cloudCalls, 0);
  assert.equal(guardCalls, 0);
  assert.equal(result.citations.length, 1);
  assert.deepEqual(result.citations[0], { file: 'synthetic-1.md', chunkId: 'chunk-001', location: 'page:1', hash: sha256(redacted.text) });
  assert.equal(result.metrics.piiItemsRedacted, 2);
});

test('the cloud payload contains at most two redacted chunks, no local filenames, and matching signed hashes', async t => {
  permitInjectedCloud(t);
  const dataDir = await workspace(t);
  const vault = await createPrivacyVault(dataDir);
  const redacted = vault.redact('Name: Avery Chen\nEmail: avery@example.invalid\nPhone: +61 400 000 001\nWarranty: 24 months.');
  await vault.save();
  const chunks = [1, 2, 3, 4].map(index => ({ ...chunk(index, `${redacted.text}\n${'Synthetic evidence. '.repeat(100)}`, 0.99 - index / 100), file: `private/Avery Chen-${index}.md` }));
  const cloudInputs = [], guardInputs = [];
  const result = await askRag('Compare the warranty evidence for Avery Chen.', {
    dataDir, offlineMeta: false,
    dependencies: {
      retrieve: retrieveFixture(chunks),
      localChat: async () => modelResponse('More reasoning is needed.', 0.2, chunks.map(value => value.chunkId), true),
      guardText: async (...args) => { guardInputs.push(args); return guardResponse(true); },
      callMuse: async input => {
        cloudInputs.push(input);
        return { ...modelResponse('The warranty is 24 months.', 0.95, ['chunk-001']), modelId: 'test-cloud-model', responseId: 'synthetic-response', providerCostUsd: 0.001, tokens: { input: 200, output: 30, total: 230 } };
      },
    },
  });
  assert.equal(cloudInputs.length, 1);
  assert.equal(result.route, 'cloud');
  assert.equal(result.outbound.chunks.length, 2);
  assert.ok(result.outbound.chunks.reduce((sum, value) => sum + estimateTokens(value.text), 0) <= ragConfig.cloudContextMaxTokens);
  for (const privateValue of ['Avery Chen', 'avery@example.invalid', '+61 400 000 001', 'private/', '.md']) {
    assert.equal(cloudInputs[0].includes(privateValue), false);
  }
  assert.equal(guardInputs.length, 2);
  assert.equal(guardInputs[0][0], cloudInputs[0]);
  for (const value of result.outbound.chunks) assert.equal(value.hash, sha256(value.text));
  assert.deepEqual(result.receipt.payload.chunks, result.outbound.chunks.map(value => ({ chunkId: value.id, hash: sha256(value.text) })));
  assert.equal(result.receipt.payload.actualChunksSent, 2);
  assert.equal(result.receipt.payload.inputHash, sha256(cloudInputs[0]));
  assert.equal(result.receipt.payload.status, 'completed');
  assert.equal(await verifyReceipt(result.receipt, { dataDir }), true);
  assert.equal(result.metrics.receiptVerified, true);
  assert.equal(result.metrics.actualCostUsd, 0.001);
});

test('local-only evaluations cannot call cloud models even if the guard would permit them', async t => {
  permitInjectedCloud(t);
  let cloudCalls = 0, guardCalls = 0;
  const result = await askRag('Synthetic local-only evaluation request.', {
    dataDir: await workspace(t), offlineMeta: false, localOnly: true,
    dependencies: {
      retrieve: retrieveFixture([chunk(1, 'SYNTHETIC TEST EVIDENCE')]),
      localChat: async () => modelResponse('More reasoning is needed.', 0.2, ['chunk-001'], true),
      guardText: async () => { guardCalls += 1; return guardResponse(true); },
      callMuse: async () => { cloudCalls += 1; throw new Error('Local-only evaluation reached cloud'); },
    },
  });
  assert.equal(cloudCalls, 0);
  assert.equal(guardCalls, 0);
  assert.equal(result.route, 'deferred_cloud');
  assert.equal(result.metrics.tokensSentToCloud, 0);
  assert.equal(result.receipt, undefined);
});

test('a residual private value in retrieved evidence blocks outbound before cloud or guard calls', async t => {
  permitInjectedCloud(t);
  let cloudCalls = 0, guardCalls = 0;
  await assert.rejects(askRag('Analyse this synthetic evidence.', {
    dataDir: await workspace(t), offlineMeta: false,
    dependencies: {
      retrieve: retrieveFixture([chunk(1, 'Contact: accidentally-unredacted@example.invalid')]),
      localChat: async () => modelResponse('More reasoning is needed.', 0.1, ['chunk-001'], true),
      guardText: async () => { guardCalls += 1; return guardResponse(true); },
      callMuse: async () => { cloudCalls += 1; throw new Error('Unredacted evidence reached cloud'); },
    },
  }), /private data/);
  assert.equal(cloudCalls, 0);
  assert.equal(guardCalls, 0);
});
