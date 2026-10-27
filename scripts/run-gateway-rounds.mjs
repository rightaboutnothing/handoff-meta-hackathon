import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runRoundOne } from '../src/evaluation/round-one.mjs';
import { runRoundTwo } from '../src/evaluation/round-two.mjs';
import { runRoundThree } from '../src/evaluation/round-three.mjs';
import { runRoundFour } from '../src/evaluation/round-four.mjs';
import { runRoundFive } from '../src/evaluation/round-five.mjs';
import { publishGatewayResults } from '../src/evaluation/publish-results.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2), at = args.indexOf('--run-id');
const runId = at >= 0 ? args[at + 1] : new Date().toISOString().replace(/[:.]/g, '-');
if (!runId || !/^[\w-]+$/.test(runId)) throw new Error('Use a filename-safe --run-id');
const directory = path.join(root, '.logs/gateway-rounds', runId);
await mkdir(directory, { recursive: true });
const sourceNames = ['scripts/run-gateway-rounds.mjs', 'src/server/gateway-models.mjs', 'src/server/env.mjs', 'config/rag.json', 'config/rag-pricing.json', ...['mmlu-pro','ad-privacy','strongreject','xstest'].map(suite => `tasks/${suite}.jsonl`)];
for (const folder of ['src/rag', 'src/evaluation']) for (const name of (await readdir(path.join(root, folder))).filter(name => name.endsWith('.mjs')).sort()) sourceNames.push(`${folder}/${name}`);
const corpus = JSON.parse(await readFile(path.join(root, 'demo_data/manifest.json'), 'utf8'));
sourceNames.push('demo_data/manifest.json', 'demo_data/evaluation.jsonl', ...corpus.files.map(source => `demo_data/${source.file}`));
const executionFingerprint = createHash('sha256').update(JSON.stringify(await Promise.all(sourceNames.map(async name => [name, createHash('sha256').update(await readFile(path.join(root, name))).digest('hex')])))).digest('hex');
let method;
try { method = JSON.parse(await readFile(path.join(directory, 'run.json'), 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; method = { runId, timestamp: new Date().toISOString(), executionFingerprint, sourceCommit: execFileSync('git', ['rev-parse','HEAD'], { cwd: root, encoding: 'utf8' }).trim(), order: [1,2,3,4,5], offlineMeta: true }; await writeFile(path.join(directory, 'run.json'), JSON.stringify(method, null, 2)); }
if (method.executionFingerprint !== executionFingerprint) throw new Error('Testing code, settings or source data changed. Preserve this run and choose a new run ID.');
process.env.META_ACCESS_STATUS = 'paused'; process.env.HANDOFF_META_ACCESS_CONFIRMED = 'false';
const originalFetch = globalThis.fetch;
let externalRequestsPrevented = 0;
globalThis.fetch = async (input, options) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (url.protocol !== 'http:' || !['localhost','127.0.0.1','[::1]'].includes(url.hostname) || url.username || url.password) { externalRequestsPrevented++; throw new Error('Testing rounds prohibit external API requests'); }
  return originalFetch(input, { ...options, redirect: 'error' });
};
const progress = round => event => console.error(JSON.stringify({ round, ...event }));
const results = [];
try {
  for (const round of method.order) {
    const checkpoint = path.join(directory, `round-${round}-complete.json`);
    let result;
    try { result = JSON.parse(await readFile(checkpoint, 'utf8')); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      console.error(`Starting round ${round}; Meta offline.`);
      const options = { runId, timestamp: new Date().toISOString(), onProgress: progress(round), dataDir: path.join(root, '.handoff') };
      if (round === 1) result = await runRoundOne(options);
      if (round === 2) result = await runRoundTwo(options);
      if (round === 3) result = await runRoundThree(options);
      if (round === 4) result = await runRoundFour(options);
      if (round === 5) result = await runRoundFive({ ...options, additionalDataDirs: results.find(value => value.round === 4)?.verificationDataDirs ?? [] });
      if (!result.file && result.outputFile) result.file = result.outputFile;
      await writeFile(checkpoint, JSON.stringify(result, null, 2));
    }
    results.push(result);
    await publishGatewayResults({ runId, timestamp: method.timestamp, sourceCommit: method.sourceCommit, rounds: results });
    console.error(JSON.stringify({ round, status: result.status, summary: result.summary }));
  }
  console.log(JSON.stringify({ runId, timestamp: method.timestamp, rounds: results.map(({round,status,file}) => ({round,status,file})), externalRequestsPrevented, actualMetaCalls: 0 }, null, 2));
} finally { globalThis.fetch = originalFetch; }
