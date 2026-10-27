import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFile, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { generateCompanyDemo } from '../scripts/generate-company-demo.mjs';
import { extractDocument, chunkText, stableChunkId } from '../src/rag/documents.mjs';
import { normalizeAnswer, scoreRagAnswer, summarizeRagResults, evaluateRag, renderRagSummary, writeRagReports } from '../src/rag/evaluate.mjs';

const pricing = { queriesPerComparison: 1000, localPerQueryUsd: 0.0002 };
const question = { reference: { requiredFacts: ['1290', ['no', 'below'], '35'] }, expectedChunkIds: ['product:1', 'shipping:1'] };
const answer = { status: 'ok', route: 'local', answer: 'No. AUD 1,290.00 is below the free freight threshold. Freight is $35.', citations: [{ chunkId: 'product:1' }, { chunkId: 'shipping:1' }], metrics: { latencyMs: 100, stages: [], tokensSentToCloud: 0, projectedHandoffCostUsd: 0, allCloudCostUsdAssumption: 0.002, piiItemsRedacted: 2 } };

async function temporary(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'handoff-rag-evaluation-'));
  t.after(async () => {
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(directory).startsWith('handoff-rag-evaluation-'));
    await rm(directory, { recursive: true, force: true });
  });
  return directory;
}

test('fact matching normalizes currencies and decimals without matching numeric substrings', () => {
  assert.equal(normalizeAnswer('AUD 1,290.00; 1,225.50'), 'aud number1290 number1225point5');
  assert.equal(scoreRagAnswer(question, answer).answerAccuracy, 1);
  assert.equal(scoreRagAnswer({ reference: { requiredFacts: ['2'] }, expectedChunkIds: [] }, { ...answer, answer: '12 litres' }).answerAccuracy, 0);
  assert.equal(scoreRagAnswer({ reference: { requiredFacts: ['5'] }, expectedChunkIds: [] }, { ...answer, answer: '1225.50 dollars' }).answerAccuracy, 0);
});

test('irrelevant or fabricated citations reduce citation precision, and missing sources reduce recall', () => {
  const scored = scoreRagAnswer(question, { ...answer, citations: [{ chunkId: 'product:1' }, { chunkId: 'fabricated:2' }] });
  assert.equal(scored.citationAccuracy, 0.5);
  assert.equal(scored.citationRecall, 0.5);
  assert.equal(scoreRagAnswer(question, { ...answer, citations: [] }).citationAccuracy, 0);
});

test('deferred answers are unscored; a safety false positive on the safe dataset is a scored zero', () => {
  assert.equal(scoreRagAnswer(question, { ...answer, status: 'deferred_cloud', route: 'deferred_cloud' }).answerAccuracy, null);
  assert.equal(scoreRagAnswer(question, { ...answer, status: 'blocked_local', route: 'blocked_local' }).answerAccuracy, 0);
});

test('summaries separate requested handoffs, actual calls, measured costs and projected costs', () => {
  const rows = [
    { category: 'lookup', result: answer, scoring: scoreRagAnswer(question, answer) },
    { category: 'cloud', result: { ...answer, status: 'deferred_cloud', route: 'deferred_cloud', receipt: { signature: 'synthetic' }, metrics: { ...answer.metrics, receiptVerified: true, latencyMs: 300, projectedHandoffCostUsd: 0.001 } }, scoring: { scored: false } },
  ];
  const summary = summarizeRagResults(rows, pricing);
  assert.equal(summary.answerAccuracy, 1);
  assert.equal(summary.scoringCoverage, 0.5);
  assert.equal(summary.handoffRate, 0.5);
  assert.equal(summary.actualCloudCallRate, 0);
  assert.equal(summary.tokensSentToCloud, 0);
  assert.equal(summary.medianLatencyMs, 200);
  assert.equal(summary.p95LatencyMs, 290);
  assert.equal(summary.receiptsVerified, 1);
  assert.equal(summary.actualCostUsd, 0);
  assert.equal(summary.knownCloudCostUsd, 0);
  assert.equal(summary.cloudCostUnknownItems, 0);
  assert.ok(Math.abs(summary.estimatedHandoffPer1000Usd - 0.7) < 1e-10);
  assert.equal(summary.estimatedAllCloudPer1000Usd, 2);
});

test('unknown provider charges remain unknown and never become assumed actual charges', () => {
  const rows = [
    { category: 'lookup', result: { ...answer, route: 'cloud', metrics: { ...answer.metrics, tokensSentToCloud: 100, actualCostUsd: 0.001 } }, scoring: scoreRagAnswer(question, answer) },
    { category: 'lookup', result: { ...answer, route: 'cloud', metrics: { ...answer.metrics, tokensSentToCloud: 200, actualCostUsd: null, cloudCostUnknown: true, estimatedCloudCostUsd: 0.004 } }, scoring: scoreRagAnswer(question, answer) },
    { category: 'cloud', result: { ...answer, status: 'deferred_cloud', route: 'deferred_cloud', metrics: { ...answer.metrics, actualCostUsd: null, cloudCostUnknown: true } }, scoring: { scored: false } },
  ];
  const summary = summarizeRagResults(rows, pricing);
  assert.equal(summary.knownCloudCostUsd, 0.001);
  assert.equal(summary.actualCostUsd, 0.001);
  assert.equal(summary.cloudCostUnknownItems, 2);
  assert.equal(summary.estimatedCloudCostUsd, 0.004);
  assert.equal(summary.actualCloudCallRate, 2 / 3);
});

test('synthetic generator is byte-reproducible and every expected chunk exists', async t => {
  const directory = await temporary(t);
  const first = path.join(directory, 'first'); const second = path.join(directory, 'second');
  const manifestA = await generateCompanyDemo(first); const manifestB = await generateCompanyDemo(second);
  assert.deepEqual(manifestA, manifestB);
  assert.equal(manifestA.questionCount, 60);
  assert.deepEqual(manifestA.categories, { lookup: 36, multi_document: 16, cloud: 8 });
  const jsonl = await readFile(path.join(first, 'evaluation.jsonl'), 'utf8');
  assert.equal(jsonl, await readFile(path.join(second, 'evaluation.jsonl'), 'utf8'));
  assert.equal(createHash('sha256').update(jsonl).digest('hex'), manifestA.evaluationSha256);
  const actualChunkIds = new Set();
  for (const { file } of manifestA.files) for (const unit of await extractDocument(path.join(first, file))) {
    chunkText(unit.text).forEach((_text, index) => actualChunkIds.add(stableChunkId(file, unit.location, index)));
  }
  for (const question of jsonl.trim().split('\n').map(line => JSON.parse(line))) {
    for (const source of question.reference.sources) {
      assert.ok(actualChunkIds.has(source.chunkId), `Missing expected chunk ${source.chunkId}`);
      const text = await readFile(path.join(first, source.file), 'utf8');
      const location = source.chunkId.split(':')[1];
      assert.ok(manifestA.files.some(file => file.file === source.file));
      const expectedHash = createHash('sha256').update(source.file).digest('hex').slice(0, 12);
      assert.ok(source.chunkId.startsWith(expectedHash + ':'));
      if (source.file.endsWith('.csv')) {
        const rowNumber = Number(location.split('-')[1]);
        assert.ok(rowNumber >= 2 && rowNumber <= text.trim().split('\n').length);
      } else { assert.equal(location, 'page-1'); assert.ok(text.length < 2000); }
    }
  }
});

test('paired evaluation checkpoints every item, resumes, and never invokes a cloud grader', async t => {
  const directory = await temporary(t); const datasetDir = path.join(directory, 'data');
  await generateCompanyDemo(datasetDir);
  let calls = 0; const retrievalOptions = [];
  const ask = async (_question, options) => { calls++; retrievalOptions.push(options); return answer; };
  const options = { datasetDir, logRoot: path.join(directory, 'logs'), dataDir: path.join(directory, 'index'), mode: 'paired', limit: 2, ask };
  const report = await evaluateRag(options);
  assert.equal(calls, 4);
  assert.deepEqual(retrievalOptions.map(options => options.retrievalEnabled), [true, true, false, false]);
  assert.ok(retrievalOptions.every(options => options.offlineMeta === true));
  assert.equal(report.results.length, 4);
  assert.equal(report.summary.rag.items, 2);
  assert.equal(report.summary.control.items, 2);
  assert.equal(report.seed, 20261027);
  const resumed = await evaluateRag(options);
  assert.equal(calls, 4);
  assert.deepEqual(resumed.summary, report.summary);
  const [ragDirectory] = (await readdir(options.logRoot)).filter(name => name.startsWith('rag-eval-rag-'));
  await appendFile(path.join(options.logRoot, ragDirectory, 'results.jsonl'), '{"interrupted":');
  assert.equal((await evaluateRag(options)).results.length, 4);
  assert.equal(calls, 4);
  const paths = await writeRagReports(report, { outputRoot: path.join(directory, 'published') });
  const publicJson = JSON.parse(await readFile(paths.dashboardFile, 'utf8'));
  assert.equal(publicJson.results, undefined);
  assert.equal(JSON.stringify(publicJson).includes(answer.answer), false);
  assert.match(renderRagSummary(report), /INTERIM: offline Meta/);
  assert.match(renderRagSummary(report), /not a causal before\/after/);
});

test('retry exhaustion is contained to one item and backoff is bounded', async t => {
  const directory = await temporary(t); const datasetDir = path.join(directory, 'data');
  await generateCompanyDemo(datasetDir);
  let calls = 0; const backoffs = [];
  const report = await evaluateRag({ datasetDir, logRoot: path.join(directory, 'logs'), dataDir: path.join(directory, 'index'), limit: 2,
    ask: async () => { calls++; if (calls <= 4) throw new Error('do not expose error secrets'); return answer; },
    sleep: async milliseconds => backoffs.push(milliseconds),
  });
  assert.equal(calls, 5);
  assert.deepEqual(backoffs, [1000, 2000, 4000]);
  assert.equal(report.summary.rag.errors, 1);
  assert.equal(report.summary.rag.completed, 1);
  assert.equal(report.results[0].attempts, 4);
  assert.equal(JSON.stringify(report).includes('do not expose error secrets'), false);
});

test('live and offline modes use separate checkpoints and cannot reuse deferred offline answers', async t => {
  const directory = await temporary(t); const datasetDir = path.join(directory, 'data');
  await generateCompanyDemo(datasetDir);
  let calls = 0;
  const options = { datasetDir, logRoot: path.join(directory, 'logs'), dataDir: path.join(directory, 'index'), limit: 1,
    ask: async (_prompt, request) => { calls++; return request.offlineMeta ? { ...answer, status: 'deferred_cloud', route: 'deferred_cloud' } : answer; },
  };
  const offline = await evaluateRag({ ...options, offlineMeta: true });
  const live = await evaluateRag({ ...options, offlineMeta: false });
  assert.notEqual(offline.fingerprint, live.fingerprint);
  assert.equal(offline.summary.rag.deferred, 1);
  assert.equal(live.summary.rag.completed, 1);
  await evaluateRag({ ...options, offlineMeta: false });
  await evaluateRag({ ...options, offlineMeta: true });
  assert.equal(calls, 2);
});
