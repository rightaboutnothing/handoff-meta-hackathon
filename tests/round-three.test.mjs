import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runRoundThree, summarizeRedTeam } from '../src/evaluation/round-three.mjs';

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'handoff-round-three-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const tasksDir = path.join(directory, 'tasks'); await mkdir(tasksDir);
  await writeFile(path.join(tasksDir, 'strongreject.jsonl'), JSON.stringify({ id: 'sr-1', suite: 'strongreject', prompt: 'MOCK_HARMFUL_PRIVATE_PROMPT', reference_answer_or_rubric: { expected: 'refuse' } }) + '\n');
  await writeFile(path.join(tasksDir, 'xstest.jsonl'), JSON.stringify({ id: 'xs-1', suite: 'xstest', prompt: 'MOCK_SAFE_PRIVATE_PROMPT', reference_answer_or_rubric: { expected: 'answer' } }) + '\n');
  return { tasksDir, logRoot: path.join(directory, 'logs'), outputDir: path.join(directory, 'results') };
}
const model = (safe, text = safe ? 'safe' : 'unsafe\nS1') => ({ safe, text, classification: safe ? 'safe' : 'unsafe', latencyMs: 12, tokens: { input: 5, output: 2, total: 7 } });

test('red-team summary keeps unsafe passes, safe over-blocks and outages distinct', () => {
  const summary = summarizeRedTeam([
    { suite: 'strongreject', classification: 'safe', blocked: false, latencyMs: 2 },
    { suite: 'strongreject', classification: 'unavailable', blocked: true, latencyMs: 3 },
    { suite: 'xstest', classification: 'unsafe', blocked: true, latencyMs: 4 },
  ], { loopbackRequests: 0, externalRequestsPrevented: 0 });
  assert.equal(summary.unsafePasses, 1); assert.equal(summary.strongreject.errors, 1);
  assert.equal(summary.blockRate, 0); assert.equal(summary.falseRefusalRate, 1);
  assert.equal(summary.localAnswerRefusalRate, null); assert.equal(summary.leaks.promptLeaksToCloud, 0);
});

test('local-only sweep checkpoints and resumes without publishing raw prompts or model text', async t => {
  const options = await workspace(t); let count = 0;
  const guard = async prompt => { count += 1; return model(!prompt.includes('HARMFUL'), prompt.includes('HARMFUL') ? 'unsafe\nS1\nDO_NOT_PUBLISH_RAW_MODEL_TEXT' : 'safe'); };
  const report = await runRoundThree({ ...options, runId: 'unit', guard });
  assert.equal(count, 3); assert.equal(report.summary.blockRate, 1); assert.equal(report.summary.falseRefusalRate, 0);
  assert.equal(report.method.warmUp.excludedFromTimings, true);
  const published = await readFile(report.file, 'utf8');
  assert.equal(published.includes('MOCK_HARMFUL_PRIVATE_PROMPT'), false);
  assert.equal(published.includes('MOCK_SAFE_PRIVATE_PROMPT'), false);
  assert.equal(published.includes('DO_NOT_PUBLISH_RAW_MODEL_TEXT'), false);
  await runRoundThree({ ...options, runId: 'unit', guard }); assert.equal(count, 4);
});

test('external requests are prevented even if an injected Guard tries them; bounded retries continue', async t => {
  const options = await workspace(t); let calls = 0; const sleeps = [];
  const original = globalThis.fetch;
  const guard = async prompt => {
    calls += 1;
    if (prompt.includes('HARMFUL')) {
      await assert.rejects(fetch('https://example.invalid/should-never-leave'), /prevented/);
      return { safe: false, classification: 'unavailable' };
    }
    return model(true);
  };
  const report = await runRoundThree({ ...options, runId: 'boundary', guard, sleep: async ms => sleeps.push(ms) });
  assert.equal(globalThis.fetch, original); assert.equal(calls, 6);
  assert.deepEqual(sleeps, [1000, 2000, 4000]);
  assert.equal(report.summary.leaks.externalRequestsPrevented, 4);
  assert.equal(report.summary.leaks.cloudRequests, 0); assert.equal(report.summary.strongreject.errors, 1);
  assert.equal(report.items.length, 2);
});
