import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { publishGatewayResults, readGatewayResults } from '../src/evaluation/publish-results.mjs';

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'handoff-publish-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const outputDir = path.join(directory, 'results'), configDir = path.join(directory, 'config');
  await mkdir(outputDir); await mkdir(configDir);
  const benchmarkFile = path.join(directory, 'benchmark.json'), summaryFile = path.join(directory, 'summary.md');
  await writeFile(benchmarkFile, JSON.stringify({ generatedAt: '2026-10-27T00:00:00Z', seed: 20261027, prompt: 'HIDDEN_GATED_QUESTION_TEXT', progress: { completed: 900, total: 1200, deferred: 300 }, trust: { harmfulCloudPrompts: 0 }, pairings: [{ id: 'meta-meta', name: 'Finkd', accuracy: 77, benchmarks: { ifeval: 100, gpqa: 59.4, xstest: null } }] }));
  await writeFile(summaryFile, '# Historical 900/1200, 300 deferred. HIDDEN_GATED_QUESTION_TEXT');
  await writeFile(path.join(configDir, 'rag.json'), JSON.stringify({ baseline: { medianLatencyMs: 1300, handoffRate: 0.296 } }));
  await writeFile(path.join(configDir, 'rag-pricing.json'), JSON.stringify({ assumption: true, museInputPerMillionUsd: 2 }));
  return { outputDir, benchmarkFile, summaryFile, configDir };
}

test('publisher snapshots source metrics with provenance and leaves missing rounds pending', async t => {
  const options = await workspace(t);
  const empty = await readGatewayResults({ resultsDir: options.outputDir }); assert.equal(empty.status, 'pending'); assert.equal(empty.baseline, null);
  const roundFile = path.join(options.outputDir, 'round-3-unit.json');
  const raw = JSON.stringify({ round: 3, status: 'completed', summary: { blockRate: 0.9, promptLeaksToCloud: 0 }, prompt: 'DO_NOT_PUBLISH_PROMPT', items: [{ id: 'unit', modelId: 'llama-guard3:8b', classification: 'unsafe', text: 'DO_NOT_PUBLISH_MODEL_TEXT', localAnswer: 'DO_NOT_PUBLISH_ANSWER', dataDir: 'C:\\private\\company' }] });
  await writeFile(roundFile, raw);
  await publishGatewayResults({ ...options, runId: 'unit', sourceCommit: '67fd4ba', timestamp: '2026-10-28T00:00:00Z', rounds: [{ round: 3, file: roundFile }] });
  assert.equal(await readFile(roundFile, 'utf8'), raw);
  const result = await readGatewayResults({ resultsDir: options.outputDir });
  assert.equal(result.rounds.length, 5); assert.equal(result.rounds[0].status, 'pending'); assert.equal(result.rounds[2].data.summary.blockRate, 0.9);
  assert.equal(result.manifest.sourceCommit, '67fd4ba');
  assert.equal(result.historical.progress.completed, 900); assert.deepEqual(result.historical.coverage.pairings[0].missingSuites, ['xstest']);
  assert.match(result.historical.provenance.summarySha256, /^[a-f0-9]{64}$/);
  const serialized = JSON.stringify(result);
  for (const forbidden of ['HIDDEN_GATED_QUESTION_TEXT', 'DO_NOT_PUBLISH_PROMPT', 'DO_NOT_PUBLISH_MODEL_TEXT', 'DO_NOT_PUBLISH_ANSWER', 'C:\\private']) assert.equal(serialized.includes(forbidden), false);
});

test('manifest traversal and content replacement are rejected instead of reading arbitrary files', async t => {
  const options = await workspace(t);
  await publishGatewayResults({ ...options, runId: 'paths', rounds: [] });
  const manifestFile = path.join(options.outputDir, 'latest.json'), original = JSON.parse(await readFile(manifestFile, 'utf8'));
  for (const file of ['../outside.json', 'C:\\private\\secret.json', 'round-1-../../outside.json']) {
    await writeFile(manifestFile, JSON.stringify({ ...original, rounds: [{ round: 1, file, sha256: null }] }));
    await assert.rejects(readGatewayResults({ resultsDir: options.outputDir }), /Invalid results file/);
  }
  await writeFile(path.join(options.outputDir, 'round-1-changed.json'), JSON.stringify({ round: 1, status: 'completed' }));
  await writeFile(manifestFile, JSON.stringify({ ...original, rounds: [{ round: 1, file: 'round-1-changed.json', sha256: 'incorrect' }] }));
  await assert.rejects(readGatewayResults({ resultsDir: options.outputDir }), /hash/);
});

test('publisher rejects round files outside its results directory and duplicates', async t => {
  const options = await workspace(t);
  await assert.rejects(publishGatewayResults({ ...options, runId: 'bad', rounds: [{ round: 1, file: path.join(os.tmpdir(), 'round-1-secret.json') }] }), /outside/);
  await assert.rejects(publishGatewayResults({ ...options, runId: 'duplicate', rounds: [{ round: 1 }, { round: 1 }] }), /unique/);
});
