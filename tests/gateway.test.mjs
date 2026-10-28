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

// The local answer and self-check are separate responses with distinct schemas.
const localSteps = (answer, confidence = 0.95, citations = ['chunk-001'], complete = true, inspect = () => {}) => async (_model, messages, options) => {
  inspect(messages, options);
  const check = Boolean(options.schema?.properties?.confidence);
  return { modelId: 'test-local-model', latencyMs: check ? 3 : 2, tokens: { input: 30, output: 20, total: 50 },
    text: JSON.stringify(check ? { confidence, evidenceSupported: complete, answerComplete: complete, issues: complete ? [] : ['incomplete_answer'] } : { claims: [{ text: answer, citations }] }) };
};

const guardResponse = safe => ({
  modelId: 'test-local-guard', latencyMs: 1, tokens: { input: 20, output: 1, total: 21 },
  safe, reason: safe ? 'Synthetic safe classification' : 'Synthetic blocked classification',
});

const chunk = (index, text, score = 0.9) => ({
  chunkId: `chunk-${String(index).padStart(3, '0')}`, file: `synthetic-${index}.md`,
  location: 'page:1', text, score, hash: sha256(text), piiCount: 0,
});

function retrieveFixture(chunks) {
  return async () => ({ chunks, quality: 0.9, latencyMs: 1, embeddingModel: 'test-local-embedding',
    completeness: { score: 1, requiredFacets: ['fixture-source'], coveredFacets: ['fixture-source'], missingFacets: [], method: 'Synthetic fixture requirements' } });
}

test('offline handoffs never call the cloud and produce a verifiable deferred receipt', async t => {
  permitInjectedCloud(t);
  const dataDir = await workspace(t);
  let cloudCalls = 0, guardCalls = 0;
  const result = await askRag('Analyse the synthetic warranty and suggest improvements.', {
    dataDir, offlineMeta: true,
    dependencies: {
      calculateLocal: async () => ({ status: 'not_applicable' }),
      retrieve: retrieveFixture([chunk(1, 'Synthetic warranty lasts 24 months.')]),
      localChat: localSteps('More reasoning is needed.', 0.2, ['chunk-001'], false),
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
      calculateLocal: async () => ({ status: 'not_applicable' }),
      retrieve: retrieveFixture([chunk(1, 'SYNTHETIC TEST EVIDENCE')]),
      localChat: localSteps('Escalation required.', 0.1, ['chunk-001'], false),
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
      calculateLocal: async () => ({ status: 'not_applicable' }),
      retrieve: retrieveFixture([chunk(1, redacted.text)]),
      localChat: localSteps(`${contact} owns the warranty process; the warranty is 24 months.`, 0.95, ['chunk-001'], true, messages => {
        assert.equal(messages[1].content.includes('Avery Chen'), false);
        assert.equal(messages[1].content.includes('avery@example.invalid'), false);
      }),
      guardText: async () => { guardCalls += 1; return guardResponse(true); },
      callMuse: async () => { cloudCalls += 1; throw new Error('A grounded local answer should stay local'); },
    },
  });
  assert.equal(result.route, 'local');
  assert.equal(result.status, 'ok');
  assert.equal(result.answer, 'Avery Chen owns the warranty process; the warranty is 24 months. [cite: chunk-001]');
  assert.equal(cloudCalls, 0);
  assert.equal(guardCalls, 0);
  assert.equal(result.citations.length, 1);
  assert.deepEqual(result.citations[0], { file: 'synthetic-1.md', chunkId: 'chunk-001', location: 'page:1', hash: sha256(redacted.text) });
  assert.equal(result.metrics.piiItemsRedacted, 2);
  assert.deepEqual(result.metrics.stages.filter(stage => stage.stage.startsWith('local_')).map(stage => stage.stage), ['local_answer', 'local_self_check']);
  assert.equal(result.metrics.localAnswerLatencyMs, 2);
  assert.equal(result.metrics.localSelfCheckLatencyMs, 3);
  assert.deepEqual(result.metrics.localTokens, { input: 60, output: 40, total: 100 });
  assert.ok(result.events.findIndex(event => event.type === 'self_check') < result.events.findIndex(event => event.type === 'confidence'));
  assert.equal(result.metrics.answerParseFailures, 0);
  assert.equal(result.metrics.selfCheckParseFailures, 0);
  assert.equal(result.metrics.evidenceCompleteness, 1);
  assert.equal(result.metrics.missingClaimCitations, 0);
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
      calculateLocal: async () => ({ status: 'not_applicable' }),
      retrieve: retrieveFixture(chunks),
      localChat: localSteps('More reasoning is needed.', 0.2, chunks.map(value => value.chunkId), false),
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
      calculateLocal: async () => ({ status: 'not_applicable' }),
      retrieve: retrieveFixture([chunk(1, 'SYNTHETIC TEST EVIDENCE')]),
      localChat: localSteps('More reasoning is needed.', 0.2, ['chunk-001'], false),
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
      calculateLocal: async () => ({ status: 'not_applicable' }),
      retrieve: retrieveFixture([chunk(1, 'Contact: accidentally-unredacted@example.invalid')]),
      localChat: localSteps('More reasoning is needed.', 0.1, ['chunk-001'], false),
      guardText: async () => { guardCalls += 1; return guardResponse(true); },
      callMuse: async () => { cloudCalls += 1; throw new Error('Unredacted evidence reached cloud'); },
    },
  }), /private data/);
  assert.equal(cloudCalls, 0);
  assert.equal(guardCalls, 0);
});

test('Company Ask separates constrained answering from self-check and preserves citation repair statistics', async t => {
  const calls = [], local = localSteps('The warranty is 24 months.', 0.95, ['[CHUNK-001]'], true, (messages, options) => calls.push({ messages, options }));
  const result = await askRag('What is the synthetic warranty?', {
    dataDir: await workspace(t),
    dependencies: {
      calculateLocal: async () => ({ status: 'not_applicable' }),
      retrieve: retrieveFixture([chunk(1, 'SYNTHETIC warranty: 24 months.')]), localChat: local,
      guardText: async () => { throw new Error('Validated local answers do not escalate'); },
      callMuse: async () => { throw new Error('Cloud is forbidden'); },
    },
  });
  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0].options.schema.properties.claims.items.properties.citations.items.enum, ['chunk-001']);
  assert.deepEqual(calls[0].options.schema.required, ['claims']);
  assert.equal(calls[0].options.maxTokens, 768);
  assert.equal(Object.hasOwn(calls[0].options.schema.properties, 'confidence'), false);
  assert.equal(Object.hasOwn(calls[1].options.schema.properties, 'answer'), false);
  assert.ok(calls[1].messages[1].content.includes('PROPOSED ANSWER:\nThe warranty is 24 months. [cite: chunk-001]'));
  assert.equal(result.route, 'local');
  assert.equal(result.citations[0].chunkId, 'chunk-001');
  assert.equal(result.metrics.invalidCitationItems, 1);
  assert.equal(result.metrics.invalidCitationIds, 1);
  assert.equal(result.metrics.repairedCitationIds, 1);
  assert.equal(result.metrics.rejectedCitationIds, 0);
});

test('invalid citations and malformed split contracts fail closed despite a confident self-check', async t => {
  const validAnswer = { claims: [{ text: 'The warranty is 24 months.', citations: ['chunk-001'] }] };
  const validCheck = { confidence: 1, evidenceSupported: true, answerComplete: true, issues: [] };
  for (const [answer, check, expected] of [
    [{ claims: [{ text: 'The warranty is 24 months.', citations: ['chunk-001', 'invented-source'] }] }, validCheck, 'citation'],
    [validAnswer, { ...validCheck, decision: 'local' }, 'self-check'],
    [{ ...validAnswer, confidence: 1, needsCloud: false }, validCheck, 'answer'],
  ]) {
    const result = await askRag('What is the synthetic warranty?', {
      dataDir: await workspace(t), localOnly: true,
      dependencies: {
      calculateLocal: async () => ({ status: 'not_applicable' }),
        retrieve: retrieveFixture([chunk(1, 'SYNTHETIC warranty: 24 months.')]),
        localChat: async (_model, _messages, options) => ({ modelId: 'test-local', latencyMs: 1, tokens: { input: 5, output: 5, total: 10 }, text: JSON.stringify(options.schema?.properties?.confidence ? check : answer) }),
        guardText: async () => { throw new Error('Local-only request must not create an outbound stage'); },
        callMuse: async () => { throw new Error('Cloud is forbidden'); },
      },
    });
    assert.equal(result.route, 'deferred_cloud');
    assert.equal(result.metrics.tokensSentToCloud, 0);
    assert.deepEqual(result.citations, []);
    if (expected === 'citation') assert.equal(result.metrics.rejectedCitationIds, 1);
    if (expected === 'self-check') assert.equal(result.metrics.selfCheckParseFailures, 1);
    if (expected === 'answer') assert.equal(result.metrics.answerParseFailures, 1);
  }
});

test('high best-match similarity does not override incomplete source evidence', async t => {
  let guardCalls = 0, cloudCalls = 0, retrievedOptions;
  const result = await askRag('Give a synthetic product price and shipping condition.', {
    dataDir: await workspace(t), localOnly: true,
    dependencies: {
      calculateLocal: async () => ({ status: 'not_applicable' }),
      retrieve: async (_question, options) => { retrievedOptions = options; return { chunks: [chunk(1, 'Synthetic price: AUD 100.')], quality: .99, bestMatchScore: .99, latencyMs: 1,
        completeness: { score: .5, missingFacets: ['shipping-policy'], method: 'Synthetic source requirements' }, queryCount: 3, tokenCount: 12, tokenBudget: 1800 }; },
      localChat: localSteps('The price is AUD 100.', 1),
      guardText: async () => { guardCalls++; throw new Error('Local-only evaluation must not screen outbound'); },
      callMuse: async () => { cloudCalls++; throw new Error('Cloud is forbidden'); },
    },
  });
  assert.equal(retrievedOptions.topK, 8); assert.equal(retrievedOptions.tokenBudget, 1800);
  assert.equal(result.evidenceCompleteness, .5); assert.equal(result.metrics.bestMatchScore, .99);
  assert.deepEqual(result.metrics.missingEvidenceFacets, ['shipping-policy']);
  assert.equal(result.route, 'deferred_cloud'); assert.match(result.reason, /evidence is incomplete/);
  assert.equal(guardCalls, 0); assert.equal(cloudCalls, 0);
});

test('one globally valid citation cannot cover a separate uncited factual claim', async t => {
  const result = await askRag('State the synthetic warranty and freight.', {
    dataDir: await workspace(t), localOnly: true,
    dependencies: {
      calculateLocal: async () => ({ status: 'not_applicable' }),
      retrieve: retrieveFixture([chunk(1, 'SYNTHETIC warranty: 24 months. Freight: AUD 35.')]),
      localChat: async (_model, _messages, options) => ({ modelId: 'synthetic-local', latencyMs: 1, tokens: { input: 10, output: 10, total: 20 },
        text: JSON.stringify(options.schema?.properties?.confidence ? { confidence: 1, evidenceSupported: true, answerComplete: true, issues: [] } : { claims: [
          { text: 'The warranty is 24 months.', citations: ['chunk-001'] }, { text: 'Freight is AUD 35.', citations: [] },
        ] }) }),
      guardText: async () => { throw new Error('Local-only boundary must not create outbound work'); },
      callMuse: async () => { throw new Error('Cloud is forbidden'); },
    },
  });
  assert.equal(result.metrics.factualClaimCount, 2); assert.equal(result.metrics.citedClaimCount, 1);
  assert.equal(result.metrics.missingClaimCitations, 1); assert.equal(result.metrics.claimCitationCoverage, .5);
  assert.equal(result.route, 'deferred_cloud'); assert.equal(result.metrics.tokensSentToCloud, 0);
});

const computedFixture = () => ({ status: 'computed', arithmeticIntent: 'subtotal', toolId: 'deterministic-local-calculator', latencyMs: 2,
  sourceChunkIds: ['chunk-001'], calculations: [{ expression: 'quantity * price', result: 200, unit: 'AUD cents', sourceChunkIds: ['chunk-001'], operands: [{ value: 100, sourceChunkIds: ['chunk-001'] }, { value: 2, origin: 'question' }] }],
  claims: [{ text: 'The subtotal is AUD 2.00.', sourceChunkIds: ['chunk-001'] }] });

test('a computed local tool result is cited and checked without model answer generation', async t => {
  const calls = [];
  const result = await askRag('Calculate a synthetic subtotal for two products.', {
    dataDir: await workspace(t),
    dependencies: {
      calculateLocal: async () => computedFixture(), retrieve: retrieveFixture([chunk(1, 'SYNTHETIC unit price: AUD 1.00.')]),
      localChat: localSteps('This model draft must never be requested.', .95, ['chunk-001'], true, (_messages, options) => calls.push(options)),
      guardText: async () => { throw new Error('Verified local answer must not escalate'); },
      callMuse: async () => { throw new Error('Cloud is forbidden'); },
    },
  });
  assert.equal(calls.length, 1); assert.ok(calls[0].schema.properties.confidence); assert.equal(calls[0].maxTokens, 128);
  assert.equal(result.route, 'local'); assert.equal(result.metrics.calculatorUsed, true);
  assert.match(result.answer, /AUD 2\.00/); assert.match(result.answer, /\[cite: calc:/);
  assert.equal(result.citations.length, 2); assert.ok(result.citations.some(cite => cite.chunkId.startsWith('calc:')));
  assert.deepEqual(result.metrics.stages.filter(stage => stage.stage.startsWith('local_')).map(stage => stage.stage), ['local_calculator', 'local_self_check']);
  assert.deepEqual(result.metrics.localTokens, { input: 30, output: 20, total: 50 });
});

test('calculator evidence and proof metadata stay local even when its self-check defers', async t => {
  permitInjectedCloud(t); const inputs = [];
  const result = await askRag('Calculate a synthetic subtotal and analyse uncertainty.', {
    dataDir: await workspace(t), offlineMeta: false,
    dependencies: {
      calculateLocal: async () => computedFixture(), retrieve: retrieveFixture([chunk(1, 'SYNTHETIC unit price: AUD 1.00.')]),
      localChat: localSteps('Must not generate a model answer.', .1, ['chunk-001'], false),
      guardText: async () => guardResponse(true),
      callMuse: async input => { inputs.push(input); return { ...modelResponse('The synthetic price is AUD 1.00.', .95, ['chunk-001']), responseId: 'synthetic-cloud-response', providerCostUsd: .001 }; },
    },
  });
  assert.equal(inputs.length, 1); assert.equal(result.route, 'cloud');
  for (const privateMetadata of ['calc:', 'VERIFIED LOCAL CALCULATOR', 'quantity * price', 'operands', 'sourceChunkIds', 'provenance']) assert.equal(inputs[0].includes(privateMetadata), false);
  assert.deepEqual(result.outbound.chunks.map(value => value.id), ['chunk-001']);
  assert.equal(result.metrics.calculatorUsed, true); assert.equal(result.receipt.payload.actualChunksSent, 1);
});
