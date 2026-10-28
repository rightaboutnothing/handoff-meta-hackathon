import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { callMuse, guardText, localChat, ragConfig } from '../src/server/gateway-models.mjs';
import { askRag } from '../src/rag/gateway.mjs';
import { sha256, verifyReceipt } from '../src/rag/receipts.mjs';

function liveFlags(t) {
  for (const [key, value] of [['META_ACCESS_STATUS', 'live'], ['HANDOFF_META_ACCESS_CONFIRMED', 'true']]) {
    const previous = process.env[key];
    process.env[key] = value;
    t.after(() => { if (previous === undefined) delete process.env[key]; else process.env[key] = previous; });
  }
}

const ollamaResponse = text => new Response(JSON.stringify({
  message: { role: 'assistant', content: text }, prompt_eval_count: 12, eval_count: 2,
}), { headers: { 'content-type': 'application/json' } });

test('the actual local adapter forwards a citation allowlist schema to loopback Ollama', async t => {
  const calls = [], schema = { type: 'object', properties: { answer: { type: 'string' }, citations: { type: 'array', items: { type: 'string', enum: ['allowed-chunk'] } } }, required: ['answer', 'citations'], additionalProperties: false };
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    calls.push({ url: new URL(url), body: JSON.parse(request.body) });
    return ollamaResponse('{"answer":"24 months","citations":["allowed-chunk"]}');
  });
  const result = await localChat(ragConfig.localModel, [{ role: 'user', content: 'Synthetic question.' }], { json: false, schema });
  assert.equal(calls.length, 1);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(calls[0].url.hostname));
  assert.deepEqual(calls[0].body.format, schema);
  assert.equal(calls[0].body.options.num_predict, ragConfig.maxOutputTokens);
  assert.equal(result.settings.schema, true);
  await assert.rejects(localChat(ragConfig.localModel, [], { schema: [] }), /schema must be an object/);
  assert.equal(calls.length, 1);
});

test('the actual Guard adapter permits only an exact safe classification and uses loopback Ollama', async t => {
  const replies = ['safe', ' SAFE \n', 'safe\nS1', 'unsafe\nS1', 'This looks safe.', '{"safe":true}', ''];
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, request) => {
    calls.push({ url: new URL(url), body: JSON.parse(request.body) });
    return ollamaResponse(replies[calls.length - 1]);
  });
  for (const [index] of replies.entries()) {
    const result = await guardText('Synthetic policy question.', 'Synthetic harmless answer.');
    assert.equal(result.safe, index < 2);
    assert.equal(result.classification, index < 2 ? 'safe' : 'unsafe');
    assert.equal(result.modelId, ragConfig.guardModel);
  }
  for (const { url, body } of calls) {
    assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname));
    assert.equal(url.pathname, '/api/chat');
    assert.equal(body.model, ragConfig.guardModel);
    assert.equal(body.keep_alive, ragConfig.keepAlive);
    assert.equal(body.options.num_predict, 40);
    assert.deepEqual(body.messages, [
      { role: 'user', content: 'Synthetic policy question.' },
      { role: 'assistant', content: 'Synthetic harmless answer.' },
    ]);
  }
});

test('Guard network, HTTP and malformed-response failures close the boundary', async t => {
  const failures = [
    async () => { throw new Error('Synthetic local service unavailable'); },
    async () => new Response('unavailable', { status: 503 }),
    async () => new Response('not JSON', { status: 200 }),
  ];
  let index = 0;
  t.mock.method(globalThis, 'fetch', (...args) => failures[index++](...args));
  for (let attempt = 0; attempt < failures.length; attempt++) {
    const result = await guardText('Synthetic harmless question.');
    assert.equal(result.safe, false);
    assert.equal(result.classification, 'unavailable');
    assert.match(result.reason, /boundary closed/);
    assert.equal(result.modelId, ragConfig.guardModel);
  }
});

test('Muse offline/default mode rejects before network even with live access flags', async t => {
  liveFlags(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Network must not be reached'); });
  await assert.rejects(callMuse('Reply with OK', { offlineMeta: true }), /access is paused/);
  await assert.rejects(callMuse('Reply with OK'), /access is paused/);
  assert.equal(calls, 0);
});

test('Muse requires both explicit access flags before even attempting a live request', async t => {
  liveFlags(t);
  let calls = 0;
  t.mock.method(globalThis, 'fetch', async () => { calls++; throw new Error('Network must not be reached'); });
  process.env.META_ACCESS_STATUS = 'paused';
  await assert.rejects(callMuse('Reply with OK', { offlineMeta: false }), /access is paused/);
  process.env.META_ACCESS_STATUS = 'live';
  process.env.HANDOFF_META_ACCESS_CONFIRMED = 'false';
  await assert.rejects(callMuse('Reply with OK', { offlineMeta: false }), /access is paused/);
  assert.equal(calls, 0);
});

test('an unsafe incoming cloud answer is withheld and its actual handoff gets a verified blocked receipt', async t => {
  liveFlags(t);
  let networkCalls = 0;
  t.mock.method(globalThis, 'fetch', async () => { networkCalls++; throw new Error('All model dependencies must be injected'); });
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'handoff-boundary-test-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(dataDir)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(dataDir).startsWith('handoff-boundary-test-'));
    await rm(dataDir, { recursive: true, force: true });
  });
  const chunk = { chunkId: 'synthetic-chunk-001', file: 'synthetic.md', location: 'page:1', text: 'SYNTHETIC warranty: 24 months.', score: 0.95, hash: sha256('SYNTHETIC warranty: 24 months.') };
  const cloudAnswer = JSON.stringify({ answer: 'UNTRUSTED_CLOUD_ANSWER', confidence: 0.9, citations: [chunk.chunkId] });
  const tokens = { input: 30, output: 10, total: 40 };
  const guardInputs = []; let cloudCalls = 0;
  const result = await askRag('Analyse this synthetic warranty.', {
    dataDir, offlineMeta: false,
    dependencies: {
      retrieve: async () => ({ chunks: [chunk], quality: 0.95, latencyMs: 1, embeddingModel: 'synthetic-embedding' }),
      localChat: async (_model, _messages, options) => ({ modelId: 'synthetic-local', latencyMs: 1, tokens,
        text: JSON.stringify(options.schema?.properties?.confidence ? { confidence: 0.1, evidenceSupported: false, answerComplete: false, issues: ['incomplete_answer'] } : { answer: 'Needs further reasoning.', citations: [chunk.chunkId] }) }),
      guardText: async (...args) => {
        guardInputs.push(args);
        return { safe: guardInputs.length === 1, modelId: 'synthetic-guard', latencyMs: 1, tokens, reason: 'Synthetic boundary classification' };
      },
      callMuse: async () => { cloudCalls++; return { modelId: 'synthetic-cloud', latencyMs: 1, tokens, text: cloudAnswer, responseId: 'synthetic-response', providerCostUsd: 0.001 }; },
    },
  });
  assert.equal(networkCalls, 0);
  assert.equal(cloudCalls, 1);
  assert.equal(guardInputs.length, 2);
  assert.equal(guardInputs[1][1], cloudAnswer);
  assert.equal(result.route, 'blocked_local');
  assert.equal(result.status, 'blocked_local');
  assert.equal(result.answer.includes('UNTRUSTED_CLOUD_ANSWER'), false);
  assert.equal(JSON.stringify(result.events).includes('UNTRUSTED_CLOUD_ANSWER'), false);
  assert.deepEqual(result.citations, []);
  assert.equal(result.metrics.guardBlocks, 1);
  assert.equal(result.metrics.tokensSentToCloud, tokens.input);
  assert.equal(result.metrics.outboundChunks, 1);
  assert.equal(result.receipt.payload.status, 'inbound_blocked');
  assert.equal(result.receipt.payload.actualChunksSent, 1);
  assert.equal(result.receipt.payload.guardInbound, 'unsafe');
  assert.equal(result.receipt.payload.responseHash, sha256(cloudAnswer));
  assert.equal(result.metrics.receiptVerified, true);
  assert.equal(await verifyReceipt(result.receipt, { dataDir }), true);
});
