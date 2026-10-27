import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCloudPolicyRegistry, isCloudEligible } from '../src/comparison/policy.mjs';
import { createCloudBudget } from '../src/comparison/budget.mjs';
import { directCloud, loadPricing, estimateRequest, comparisonGuard, parseGuardResponse, llamaGuardPrompt, CLOUD_MODELS } from '../src/server/comparison-models.mjs';

const item = { id: 'mock-safe-1', suite: 'mmlu-pro', category: 'knowledge', prompt: 'Say hello', safety: { kind: 'safe', cloudEligible: true } };
const registry = createCloudPolicyRegistry([item]);
const pricing = await loadPricing();
const previousBudget = process.env.CLOUD_BUDGET_USD;
process.env.CLOUD_BUDGET_USD = '1';
test.after(() => { if (previousBudget === undefined) delete process.env.CLOUD_BUDGET_USD; else process.env.CLOUD_BUDGET_USD = previousBudget; });
const budget = async capUsd => createCloudBudget({ directory: await mkdtemp(path.join(os.tmpdir(), 'handoff-budget-')), capUsd });
const fixtureUsage = { promptTokenCount: 12, candidatesTokenCount: 2, thoughtsTokenCount: 7, totalTokenCount: 21 };
const fakeGoogle = async () => ({ ok: true, json: async () => ({ modelVersion: CLOUD_MODELS.gemini, responseId: 'mock-response', candidates: [{ content: { parts: [{ text: 'Hello' }, { text: 'private thinking', thought: true }] } }], usageMetadata: fixtureUsage }) });

test('unsafe categories and registry forgery cannot reach either cloud, including controls', async () => {
  let networkCalls = 0;
  const dependencies = { fetch: async () => { networkCalls++; throw new Error('unexpected'); }, createMetaClient: () => { networkCalls++; throw new Error('unexpected'); } };
  for (const cloudId of Object.keys(CLOUD_MODELS)) {
    for (const kind of ['harmful', 'red-team', 'poisoning']) {
      const blocked = { ...item, id: `unsafe-${kind}`, safety: { kind, cloudEligible: true } };
      assert.equal(isCloudEligible(blocked), false);
      const unsafeRegistry = createCloudPolicyRegistry([blocked]);
      for (const control of ['cloud-only', 'guard-off', 'standard']) {
        await assert.rejects(directCloud({ cloudId, item: blocked, registry: unsafeRegistry, input: 'Do not dispatch', tier: 1, offline: false, control, dependencies }), { code: 'LOCAL_ONLY_ITEM' });
      }
      await assert.rejects(directCloud({ cloudId, item: { ...blocked, safety: { kind: 'safe', cloudEligible: true } }, registry: unsafeRegistry, input: 'Do not dispatch', tier: 1, offline: false, dependencies }), { code: 'LOCAL_ONLY_ITEM' });
    }
    await assert.rejects(directCloud({ cloudId, item: { ...item, prompt: 'Changed after registration' }, registry, input: 'hello', tier: 1, offline: false, dependencies }), { code: 'LOCAL_ONLY_ITEM' });
    await assert.rejects(directCloud({ cloudId, item, registry: { count: 1 }, input: 'hello', tier: 1, offline: false, dependencies }), { code: 'LOCAL_ONLY_ITEM' });
  }
  assert.equal(networkCalls, 0);
});
test('unknown categories and StrongREJECT never cloud-eligible even with safe flags', () => {
  assert.equal(isCloudEligible({ ...item, category: 'unknown' }), false);
  assert.equal(isCloudEligible({ ...item, suite: 'strongreject' }), false);
  assert.equal(isCloudEligible({ ...item, poisoning: true }), false);
  assert.equal(isCloudEligible({ ...item, safety: { kind: 'safe' } }), false);
});
test('Tier 0 forces zero cloud calls before any key, budget or client access', async () => {
  for (const cloudId of Object.keys(CLOUD_MODELS)) {
    let calls = 0;
    const result = await directCloud({ cloudId, item, registry, input: 'Say hello', tier: 0, offline: false, dependencies: { fetch: () => { calls++; }, createMetaClient: () => { calls++; } } });
    assert.equal(result.status, 'deferred_tier0'); assert.equal(result.zeroCloudCalls, true); assert.equal(calls, 0);
  }
});
test('Meta stays deferred until both standing access flags are restored', async () => {
  const oldStatus = process.env.META_ACCESS_STATUS, oldConfirmation = process.env.HANDOFF_META_ACCESS_CONFIRMED;
  delete process.env.META_ACCESS_STATUS; delete process.env.HANDOFF_META_ACCESS_CONFIRMED;
  try {
    const result = await directCloud({ cloudId: 'muse-spark', item, registry, input: 'hello', tier: 1, offline: false });
    assert.equal(result.status, 'deferred_meta');
  } finally {
    if (oldStatus === undefined) delete process.env.META_ACCESS_STATUS; else process.env.META_ACCESS_STATUS = oldStatus;
    if (oldConfirmation === undefined) delete process.env.HANDOFF_META_ACCESS_CONFIRMED; else process.env.HANDOFF_META_ACCESS_CONFIRMED = oldConfirmation;
  }
});
test('canaries, raw email and telephone patterns fail before network', async () => {
  for (const input of ['hello alice@example.invalid', 'Hello CANARY-unique-id', 'Call +61 412 345 678']) {
    await assert.rejects(directCloud({ cloudId: 'gemini', item, registry, input, tier: 1, offline: false }), { code: 'UNREDACTED_PAYLOAD' });
  }
});
test('cloud dispatch requires CLOUD_BUDGET_USD above zero inside the client', async () => {
  const previous = process.env.CLOUD_BUDGET_USD; process.env.CLOUD_BUDGET_USD = '0';
  try { await assert.rejects(directCloud({ cloudId: 'gemini', item, registry, input: 'Hello', tier: 1, offline: false }), { code: 'CLOUD_BUDGET_EXHAUSTED' }); }
  finally { process.env.CLOUD_BUDGET_USD = previous; }
});
test('conservative UTF8 reservation exceeds character/4 and includes reasoning', () => {
  const input = '复杂🦙'.repeat(30);
  const estimate = estimateRequest('gemini', input, { pricing });
  assert.equal(estimate.upperTokens.input, Buffer.byteLength(input, 'utf8') + 256);
  assert(estimate.upperTokens.input > estimate.estimatedTokens.input);
  assert.equal(estimate.upperTokens.reasoning, 65536);
  assert(estimate.reservedUpperUsd > estimate.estimatedCostUsd);
});
test('budget requires positive cap and blocks before projected overspend', async () => {
  assert.throws(() => createCloudBudget({ directory: 'unused', capUsd: 0 }), { code: 'CLOUD_BUDGET_EXHAUSTED' });
  const ledger = await budget(0.1);
  await ledger.reserve({ requestId: 'first', cloudId: 'gemini', upperBoundUsd: 0.08 });
  await assert.rejects(ledger.reserve({ requestId: 'second', cloudId: 'gemini', upperBoundUsd: 0.03 }), { code: 'CLOUD_BUDGET_EXHAUSTED' });
  assert.equal((await ledger.status()).reservedUsd, 0.08);
});
test('parallel reservations cannot overspend and failures retain their full reservation', async () => {
  const ledger = await budget(0.1);
  const results = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => ledger.reserve({ requestId: `parallel-${i}`, cloudId: 'gemini', upperBoundUsd: 0.03 })));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 3);
  const first = results.findIndex(r => r.status === 'fulfilled');
  await ledger.markUnknown(`parallel-${first}`);
  const status = await ledger.status();
  assert(Math.abs(status.reservedUsd - 0.09) < 1e-12); assert.equal(status.providerReportedCostUsd, null);
});
test('durable budget survives a new instance and does not silently raise its cap', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'handoff-resume-'));
  await createCloudBudget({ directory, capUsd: 1 }).reserve({ requestId: 'attempt-1', cloudId: 'gemini', upperBoundUsd: 0.4 });
  assert.equal((await createCloudBudget({ directory, capUsd: 1 }).status()).reservedUsd, 0.4);
  await assert.rejects(createCloudBudget({ directory, capUsd: 2 }).status(), /cap differs/);
  assert.equal(JSON.parse(await readFile(path.join(directory, 'cloud-budget.json'), 'utf8')).attempts['attempt-1'].state, 'reserved');
});
test('Google uses direct API with same temperature/output cap and records invoice cost as unknown', async () => {
  const ledger = await budget(1);
  const old = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'unit-test-placeholder';
  let request;
  try {
    const result = await directCloud({ cloudId: 'gemini', item, registry, input: 'Say hello', budget: ledger, tier: 1, offline: false, dependencies: { fetch: async (url, options) => { request = { url, options }; return fakeGoogle(); } } });
    const body = JSON.parse(request.options.body);
    assert.equal(request.url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent');
    assert.equal(body.generationConfig.temperature, 0); assert.equal(body.generationConfig.seed, 20261027);
    assert.equal(body.generationConfig.maxOutputTokens, 384); assert.equal(body.generationConfig.thinkingConfig.thinkingLevel, 'MEDIUM');
    assert.equal(result.text, 'Hello'); assert.equal(result.providerReportedCostUsd, null);
    assert.equal(result.tokens.reasoning, 7); assert.equal(result.budget.reservedUsd, 0); assert(result.meteredCostUsd > 0);
  } finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});
test('API errors have no hidden retries and retain durable worst-case charge', async () => {
  const ledger = await budget(1);
  const old = process.env.GEMINI_API_KEY; process.env.GEMINI_API_KEY = 'unit-test-placeholder';
  let calls = 0;
  try {
    await assert.rejects(directCloud({ cloudId: 'gemini', item, registry, input: 'hello', budget: ledger, tier: 1, offline: false, dependencies: { fetch: async () => { calls++; return { ok: false, status: 429 }; } } }), /HTTP 429/);
    assert.equal(calls, 1); assert((await ledger.status()).reservedUsd > 0);
  } finally { if (old === undefined) delete process.env.GEMINI_API_KEY; else process.env.GEMINI_API_KEY = old; }
});
test('Meta official Responses request uses explicit key, no retries, output_text and version logging', async () => {
  const ledger = await budget(1);
  const names = ['MODEL_API_KEY', 'META_ACCESS_STATUS', 'HANDOFF_META_ACCESS_CONFIRMED'];
  const old = names.map(n => process.env[n]);
  Object.assign(process.env, { MODEL_API_KEY: 'unit-test-placeholder', META_ACCESS_STATUS: 'live', HANDOFF_META_ACCESS_CONFIRMED: 'true' });
  let options, request;
  try {
    const result = await directCloud({ cloudId: 'muse-spark', item, registry, input: 'hello', budget: ledger, tier: 1, offline: false,
      dependencies: { createMetaClient: o => { options = o; return { responses: { create: async r => { request = r; return { output_text: 'Hello', model: 'muse-spark-1.3', usage: { input_tokens: 12, output_tokens: 9, total_tokens: 21, output_tokens_details: { reasoning_tokens: 7 } } }; } } }; } } });
    assert.equal(options.maxRetries, 0); assert.equal(options.apiKey, 'unit-test-placeholder');
    assert.equal(options.baseURL, 'https://api.meta.ai/v1');
    assert.equal(request.model, 'muse-spark-1.3'); assert.equal(request.max_output_tokens, 384);
    assert.equal(request.reasoning.effort, 'medium'); assert.equal(result.text, 'Hello'); assert.equal(result.modelVersion, 'muse-spark-1.3');
    assert.equal(result.settings.seedSupported, false); assert.equal(result.providerReportedCostUsd, null);
  } finally { names.forEach((name, i) => { if (old[i] === undefined) delete process.env[name]; else process.env[name] = old[i]; }); }
});
test('provider-specific guard verdict parsing and inbound role fail closed', () => {
  assert.equal(parseGuardResponse('shieldgemma:9b', 'No. This is safe.').safe, true);
  assert.equal(parseGuardResponse('shieldgemma:9b', 'Yes\nDangerous content').safe, false);
  assert.equal(parseGuardResponse('shieldgemma:9b', 'safe').safe, false);
  assert.equal(parseGuardResponse('llama-guard3:8b', 'safe').safe, true);
  assert.equal(parseGuardResponse('llama-guard3:8b', 'unsafe\nS1,S9').safe, false);
  assert.equal(parseGuardResponse('llama-guard3:8b', 'probably safe').safe, false);
  assert.match(llamaGuardPrompt('Question', 'Reply'), /ONLY THE LAST Agent message/);
  assert.match(llamaGuardPrompt('Question'), /ONLY THE LAST User message/);
  assert.match(llamaGuardPrompt('Question'), /S14: Code Interpreter Abuse/);
});
test('ShieldGemma inbound native template receives both question and assistant reply', async t => {
  let request;
  t.mock.method(globalThis, 'fetch', async (url, options) => { request = { url, body: JSON.parse(options.body) }; return { ok: true, json: async () => ({ message: { content: 'Yes. A policy violation.' }, prompt_eval_count: 12, eval_count: 8 }) }; });
  const result = await comparisonGuard('shieldgemma:9b', 'Harmless question', 'Unsafe assistant response fixture');
  assert.match(request.url, /\/api\/chat$/);
  assert.deepEqual(request.body.messages, [{ role: 'user', content: 'Harmless question' }, { role: 'assistant', content: 'Unsafe assistant response fixture' }]);
  assert.equal(result.direction, 'inbound'); assert.equal(result.safe, false);
});
test('a reservation overrun records known usage accurately and permanently halts dispatch', async () => {
  const ledger = await budget(1);
  await ledger.reserve({ requestId: 'overrun', cloudId: 'gemini', upperBoundUsd: 0.01 });
  const status = await ledger.settle('overrun', { meteredUsd: 0.02, providerReportedCostUsd: null });
  assert.equal(status.overrun, true); assert.equal(status.meteredUsd, 0.02); assert.equal(status.reservedUsd, 0);
  await assert.rejects(ledger.reserve({ requestId: 'halted', cloudId: 'gemini', upperBoundUsd: 0.01 }), { code: 'CLOUD_BUDGET_EXHAUSTED' });
});
