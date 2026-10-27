import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile, appendFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { atomicJson, appendCheckpoint, readCheckpoints, retryItem, installTier0NetworkBoundary, routeLocal, buildCostPlan, runComparison } from '../src/comparison/runner.mjs';
import { buildPipelineMatrix, comparisonConfig } from '../src/comparison/matrix.mjs';
import { createCloudPolicyRegistry } from '../src/comparison/policy.mjs';
import { directCloud, loadPricing } from '../src/server/comparison-models.mjs';
import { trainCalibrator } from '../src/comparison/calibration.mjs';
import { summarizePipeline } from '../src/comparison/metrics.mjs';

const safe = { id: 'runner-safe', suite: 'mmlu-pro', category: 'knowledge', prompt: 'Say hello', safety: { kind: 'safe', cloudEligible: true }, groupId: 'safe-group' };
const pricing = await loadPricing();
const modelId = 'llama3.1:8b';
const features = { confidence: .99, retrievalScore: .9, sourceDocCount: 1, citationCount: 1, hasValidCitations: true, needsCloud: false };
const trained = trainCalibrator(Array.from({ length: 6 }, (_, index) => ({ id: `dev-${index}`, groupId: `dev-${index}`, modelId, split: 'dev', category: 'knowledge', features, wrong: false })), { modelId, iterations: 30 });
const acceptsEverything = { ...trained, threshold: 1 };
const escalatesEverything = { ...trained, threshold: 0 };
const temporaryDirectories = [];
async function tempDirectory() { const base=path.resolve('.cache','comparison-runner-unit');await mkdir(base,{recursive:true});const directory = await mkdtemp(path.join(base,'test-')); temporaryDirectories.push(directory); return directory; }
test.after(async () => { for (const directory of temporaryDirectories) await rm(directory, { recursive: true, force: true }); });

test('matrix contains 12 distinct guarded hybrids, 11 explicit controls and no retired cloud', () => {
  const pipelines = buildPipelineMatrix();
  assert.equal(pipelines.length, 23);
  assert.equal(new Set(pipelines.map(row => row.id)).size, 23);
  for (const [kind, count] of [['hybrid', 12], ['local-only', 3], ['cloud-only', 2], ['guard-off', 6]]) assert.equal(pipelines.filter(row => row.kind === kind).length, count);
  assert.equal(pipelines.filter(row => row.hero).length, 1);
  assert.equal(pipelines.find(row => row.hero).id, 'llama8b+llamaguard+musespark');
  assert.ok(pipelines.filter(row => ['cloud-only', 'guard-off'].includes(row.kind)).every(row => row.safeOnly === true));
  assert.ok(pipelines.every(row => !/grok|openrouter|latest/i.test(JSON.stringify(row))));
  for (const size of [4, 8, 12]) assert.equal(pipelines.filter(row => row.kind === 'hybrid' && row.parametersB === size).length, 4);
});

test('Tier 0 boundary allows only HTTP loopback, blocks redirects and restores the original fetch', async () => {
  const original = globalThis.fetch, originalBudget = process.env.CLOUD_BUDGET_USD;
  const calls = [];
  const mockFetch = async (url, options) => { calls.push({ url, options }); return { ok: true }; };
  globalThis.fetch = mockFetch; process.env.CLOUD_BUDGET_USD = '999';
  const boundary = installTier0NetworkBoundary();
  try {
    for (const url of ['http://127.0.0.1:11434/api/chat', 'http://localhost:11434/api/tags', 'http://[::1]:11434/api/generate']) await fetch(url, { redirect: 'follow' });
    for (const url of ['https://api.meta.ai/v1/responses', 'https://generativelanguage.googleapis.com', 'http://openrouter.ai', 'http://localhost.attacker.invalid', 'https://127.0.0.1']) await assert.rejects(fetch(url), { code: 'TIER0_NETWORK_DENIED' });
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.options.redirect === 'error'));
    assert.deepEqual(boundary.status(), { externalRequests: 0, localRequests: 3 });
  } finally {
    boundary.restore(); assert.equal(globalThis.fetch, mockFetch); globalThis.fetch = original;
    if (originalBudget === undefined) delete process.env.CLOUD_BUDGET_USD; else process.env.CLOUD_BUDGET_USD = originalBudget;
  }
});

test('positive budget cannot make either direct client dispatch in Tier 0', async () => {
  const previous = process.env.CLOUD_BUDGET_USD; process.env.CLOUD_BUDGET_USD = '999';
  let external = 0, reservations = 0;
  const registry = createCloudPolicyRegistry([safe]);
  try {
    for (const cloudId of ['muse-spark', 'gemini']) {
      const result = await directCloud({ cloudId, item: safe, registry, input: 'Say hello', tier: 0, offline: false, pricing,
        budget: { reserve: async () => { reservations++; } }, dependencies: { fetch: async () => { external++; throw new Error('Unexpected external request'); }, createMetaClient: () => { external++; throw new Error('Unexpected Meta client'); } } });
      assert.equal(result.status, 'deferred_tier0'); assert.equal(result.zeroCloudCalls, true);
    }
    assert.equal(external, 0); assert.equal(reservations, 0);
  } finally { if (previous === undefined) delete process.env.CLOUD_BUDGET_USD; else process.env.CLOUD_BUDGET_USD = previous; }
});

test('runner rejects paid tiers without budget before touching inference or checkpoints', async () => {
  const original = globalThis.fetch, previous = process.env.CLOUD_BUDGET_USD;
  let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('Unexpected inference'); }; process.env.CLOUD_BUDGET_USD = '0';
  try {
    for (const tier of [1, 2]) await assert.rejects(runComparison({ tier, runId: 'unit-must-not-create' }), /CLOUD_BUDGET_USD above 0/);
    assert.equal(calls, 0);
  } finally { globalThis.fetch = original; if (previous === undefined) delete process.env.CLOUD_BUDGET_USD; else process.env.CLOUD_BUDGET_USD = previous; }
});

test('source safety metadata overrides every classifier and model request for escalation', () => {
  const wantsCloud = { features, needsCloud: true };
  for (const kind of ['harmful', 'red-team', 'poisoning']) {
    const item = { ...safe, id: kind, safety: { kind, cloudEligible: true } };
    assert.equal(routeLocal(item, wantsCloud, escalatesEverything).route, 'local_only_safety');
  }
  for (const mutation of [{ suite: 'strongreject' }, { localOnly: true }, { harmful: true }, { poisoning: true }, { category: 'unknown' }]) assert.equal(routeLocal({ ...safe, ...mutation }, wantsCloud, escalatesEverything).route, 'local_only_safety');
});

test('safe routing honors dev-calibrated threshold and retrieval grounding, without test reference features', () => {
  assert.equal(routeLocal(safe, { features, needsCloud: false }, acceptsEverything).route, 'local');
  assert.equal(routeLocal(safe, { features, needsCloud: false }, escalatesEverything).route, 'escalate');
  assert.equal(routeLocal(safe, { features, needsCloud: true }, acceptsEverything).route, 'escalate');
  const company = { ...safe, category: 'company-data multi-doc' };
  assert.equal(routeLocal(company, { features: { ...features, retrievalScore: .1 }, needsCloud: false }, acceptsEverything).route, 'escalate');
  assert.equal(routeLocal(company, { features: { ...features, hasValidCitations: false }, needsCloud: false }, acceptsEverything).route, 'escalate');
  assert.deepEqual(routeLocal(safe, { features, needsCloud: false, reference: { answer: 'Forbidden feature' } }, acceptsEverything), routeLocal(safe, { features, needsCloud: false }, acceptsEverything));
});

test('retry performs at most three backoff retries and terminal budget/safety denials never retry', async () => {
  const sleeps = [], events = []; let attempts = 0;
  await assert.rejects(retryItem(async () => { attempts++; throw new Error('transient'); }, { sleep: async ms => sleeps.push(ms), onRetry: row => events.push(row) }), /after three retries/);
  assert.equal(attempts, 4); assert.deepEqual(sleeps, [1000, 2000, 4000]); assert.equal(events.length, 3);
  for (const code of ['CLOUD_BUDGET_EXHAUSTED', 'LOCAL_ONLY_ITEM', 'UNREDACTED_PAYLOAD']) {
    let calls = 0;
    await assert.rejects(retryItem(async () => { calls++; throw Object.assign(new Error(code), { code }); }, { sleep: async () => { throw new Error('Must not sleep'); } }), { code });
    assert.equal(calls, 1);
  }
  let eventualAttempts = 0;
  assert.equal(await retryItem(async () => { eventualAttempts++; if (eventualAttempts < 3) throw new Error('transient'); return 'finished'; }, { sleep: async () => {} }), 'finished');
  assert.equal(eventualAttempts, 3);
});

test('checkpoints retain complete items, discard interrupted tail and append a valid resume record', async () => {
  const directory = await tempDirectory(), file = path.join(directory, 'results.jsonl');
  assert.deepEqual(await readCheckpoints(file), []);
  await appendCheckpoint(file, { pipelineId: 'one', id: 'done-1' });
  await appendFile(file, '{"pipelineId":"one","id":"interrupted');
  assert.deepEqual(await readCheckpoints(file), [{ pipelineId: 'one', id: 'done-1' }]);
  await appendCheckpoint(file, { pipelineId: 'one', id: 'done-2' });
  assert.deepEqual((await readCheckpoints(file)).map(row => row.id), ['done-1', 'done-2']);
  assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 2);
});

test('valid JSON without a final newline cannot corrupt the next resumed append', async () => {
  const directory = await tempDirectory(), file = path.join(directory, 'results.jsonl');
  await writeFile(file, '{"id":"done"}\n{"id":"tail-without-commit-newline"}');
  await readCheckpoints(file);
  await appendCheckpoint(file, { id: 'next' });
  const resumed = await readCheckpoints(file);
  assert.equal(resumed[0].id, 'done'); assert.equal(resumed.at(-1).id, 'next');
  assert.ok(resumed.length === 2 || resumed.length === 3);
});

test('interior checkpoint corruption fails closed and atomic metadata preserves exact JSON', async () => {
  const directory = await tempDirectory(), file = path.join(directory, 'results.jsonl');
  await writeFile(file, '{"id":"done"}\nNOT-JSON\n{"id":"later"}\n');
  await assert.rejects(readCheckpoints(file), /Corrupt completed comparison checkpoint/);
  const metadata = path.join(directory, 'nested', 'run.json');
  await atomicJson(metadata, { run: 'original', settings: { seed: 20261027 } });
  assert.deepEqual(JSON.parse(await readFile(metadata, 'utf8')), { run: 'original', settings: { seed: 20261027 } });
  await atomicJson(metadata, { run: 'updated' });
  assert.deepEqual(JSON.parse(await readFile(metadata, 'utf8')), { run: 'updated' });
});

test('planning keeps model sizes separate and unknown provider USD is not silently called zero', () => {
  const pipelines = buildPipelineMatrix().filter(row => row.kind === 'hybrid' && row.cloudId === 'gemini' && row.guardId === 'llamaguard');
  const rows = pipelines.map((pipeline, index) => ({ id: safe.id, pipelineId: pipeline.id, category: safe.category, route: 'deferred_cloud', handoff: true,
    plan: { estimatedTokens: { input: 10 + index, output: 20, reasoning: 30 } }, metrics: { projectedCostUsd: .001 * (index + 1), allCloudCostUsd: .004, actualCloudSpendUsd: null, meteredCloudSpendUsd: .0002, cloudCostUnknown: true } }));
  const plan = buildCostPlan(pipelines, rows, [safe], [safe], pricing);
  assert.equal(plan.length, 3);
  assert.deepEqual(plan.map(row => row.costPer1000Usd), [1, 2, 3]);
  assert.ok(plan.every(row => row.actualSpendUsd === null));
  assert.ok(plan.every(row => row.meteredSpendUsd === .0002));
  assert.throws(() => summarizePipeline(rows.map((row, index) => ({ ...row, localModelId: pipelines[index].localModelId }))), /pool different pipelines/);
});

test('planning cannot turn a failed missing-cost observation into free projected cloud work', () => {
  const pipeline = buildPipelineMatrix().find(row => row.id === 'llama8b+llamaguard+gemini');
  const row = { id: safe.id, pipelineId: pipeline.id, category: safe.category, status: 'error', route: 'error', metrics: { cloudCostUnknown: true } };
  const plan = buildCostPlan([pipeline], [row], [safe], [safe], pricing)[0];
  assert.equal(plan.costPer1000Usd, null);
});

test('core weighting accounts for local-only unsafe work without imputing unsafe cloud calls', () => {
  const pipeline = buildPipelineMatrix().find(row => row.id === 'llama8b+llamaguard+gemini');
  const harmful = { ...safe, id: 'harmful', safety: { kind: 'harmful', cloudEligible: false } };
  const row = { id: safe.id, pipelineId: pipeline.id, category: safe.category, status: 'deferred_cloud', handoff: true,
    plan: { estimatedCostUsd: .003, estimatedTokens: { input: 30, output: 20, reasoning: 10 } },
    metrics: { allCloudCostUsd: .004, allCloudInputTokens: 40, actualCloudSpendUsd: 0, meteredCloudSpendUsd: 0 } };
  const plan = buildCostPlan([pipeline], [row], [safe, harmful], [safe, harmful], pricing)[0];
  assert.ok(Math.abs(plan.costPer1000Usd - 1.7) < 1e-12);
  assert.equal(plan.cloudOnlyCostPer1000Usd, 2);
  assert.equal(plan.expectedInputTokensPer1000, 15000);
  assert.equal(plan.expectedAllCloudInputTokensPer1000, 20000);
  assert.equal(plan.estimatedAllCloudInputTokens, 40);
  assert.equal(plan.projectionCoverage, 1);
  const control = { ...pipeline, kind: 'cloud-only', localModelId: null, safeOnly: true };
  assert.equal(buildCostPlan([control], [{ ...row, metrics: { ...row.metrics, projectedCostUsd: .003 } }], [safe, harmful], [safe, harmful], pricing)[0].costPer1000Usd, 1.5);
});

test('a missing safe core category makes the cost projection pending with weighted coverage', () => {
  const pipeline = buildPipelineMatrix().find(row => row.id === 'llama8b+llamaguard+gemini');
  const absent = { ...safe, id: 'absent', category: 'reasoning' };
  const row = { id: safe.id, pipelineId: pipeline.id, category: safe.category, metrics: { projectedCostUsd: .001 } };
  const plan = buildCostPlan([pipeline], [row], [safe], [safe, absent], pricing)[0];
  assert.equal(plan.costPer1000Usd, null);
  assert.equal(plan.projectionCoverage, .5);
});
