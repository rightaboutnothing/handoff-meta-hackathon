import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const sha256 = text => createHash('sha256').update(text).digest('hex');
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(value);
const deniedKeys = new Set(['prompt', 'question', 'answer', 'text', 'output_text', 'output', 'content', 'messages', 'reference', 'reference_answer_or_rubric', 'payload', 'outbound', 'retrievalChunks', 'localEvidence', 'cloudInput', 'input', 'file', 'dataDir', 'logRoot', 'outputDir', 'outputRoot', 'tasksDir', 'datasetDir', 'cacheDir', 'filename', 'path', 'apiKey', 'api_key', 'privateKey', 'privatePem', 'originalValues', 'piiValues', 'seededPii', 'canaryStrings']);
const secrets = /\b(?:sk-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,})\b/g;
const runtimePath = /(?:\b[A-Za-z]:[\\/]|file:\/\/|(?:^|\s)\/(?:Users|home|tmp|var|private)\/)/;

// Public round reports contain measured aggregates, IDs, hashes and classifications.
// Live redacted evidence is shown only by the local Ask API, never this publisher.
export function sanitizePublicResult(value, key = '') {
  if (value === null || typeof value === 'boolean' || typeof value === 'number') return value;
  if (deniedKeys.has(key) || /(?:api.?key|private.?key|password|credential)/i.test(key)) return undefined;
  if (typeof value === 'string' && /(?:prompt|question|answer|output|response|context|evidence)/i.test(key) && !/(?:id|ids|order|hash|hashes|measurement|source|provenance|status|policy|description|note|notes)$/i.test(key)) return undefined;
  if (typeof value === 'string') return runtimePath.test(value) ? undefined : value.replace(secrets, '[redacted credential]');
  if (Array.isArray(value)) return value.map(item => sanitizePublicResult(item, key)).filter(item => item !== undefined);
  if (typeof value !== 'object') return undefined;
  return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, sanitizePublicResult(item, name)]).filter(([, item]) => item !== undefined));
}

function validateReference(file, prefix) {
  if (typeof file !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*\.json$/.test(file) || !file.startsWith(prefix)) throw new Error('Invalid results file reference');
  return file;
}
async function readReferenced(resultsDir, file, prefix, expectedHash) {
  validateReference(file, prefix);
  const base = await realpath(resultsDir), target = path.join(base, file);
  const info = await lstat(target);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Result references must be regular local JSON files');
  const resolved = await realpath(target);
  if (path.dirname(resolved).toLowerCase() !== base.toLowerCase()) throw new Error('Result reference escaped the results directory');
  const text = await readFile(resolved, 'utf8');
  const digest = sha256(text);
  if (expectedHash && digest !== expectedHash) throw new Error('Result content hash does not match the manifest');
  return { data: JSON.parse(text), sha256: digest };
}
function publishedBasename(file, outputDir, prefix) {
  const resolved = path.isAbsolute(file) ? path.resolve(file) : path.dirname(file) === '.' ? path.resolve(outputDir, file) : path.resolve(file);
  if (path.dirname(resolved).toLowerCase() !== path.resolve(outputDir).toLowerCase()) throw new Error('Round result file is outside the results directory');
  return validateReference(path.basename(resolved), prefix);
}

export async function publishGatewayResults({ runId, timestamp = new Date().toISOString(), rounds = [],
  sourceCommit,
  outputDir = path.join(repoRoot, 'results'), benchmarkFile = path.join(repoRoot, 'dashboard/public/benchmark-data.json'),
  summaryFile = path.join(repoRoot, 'results/summary.md'), configDir = path.join(repoRoot, 'config'),
} = {}) {
  if (!safeId(runId)) throw new Error('A safe results run ID is required');
  if (sourceCommit !== undefined && !/^[a-f0-9]{7,40}$/.test(sourceCommit)) throw new Error('Invalid measured source commit');
  if (rounds.some(item => !Number.isInteger(item.round) || item.round < 1 || item.round > 5) || new Set(rounds.map(item => item.round)).size !== rounds.length) throw new Error('Rounds must have unique IDs from 1 to 5');
  await mkdir(outputDir, { recursive: true });
  const [benchmarkText, summaryText, configText, pricingText] = await Promise.all([
    readFile(benchmarkFile, 'utf8'), readFile(summaryFile, 'utf8'),
    readFile(path.join(configDir, 'rag.json'), 'utf8'), readFile(path.join(configDir, 'rag-pricing.json'), 'utf8'),
  ]);
  const benchmark = JSON.parse(benchmarkText), configuration = JSON.parse(configText), pricing = JSON.parse(pricingText);
  const snapshot = sanitizePublicResult({
    schemaVersion: 1, runId, timestamp, status: 'historical_interim',
    generatedAt: benchmark.generatedAt, seed: benchmark.seed,
    progress: benchmark.progress, trust: benchmark.trust, pairings: benchmark.pairings,
    provenance: { benchmarkSource: 'dashboard/public/benchmark-data.json', benchmarkSha256: sha256(benchmarkText), summarySource: 'results/summary.md', summarySha256: sha256(summaryText) },
    coverage: {
      status: 'partial', completed: benchmark.progress?.completed ?? null, total: benchmark.progress?.total ?? null, deferred: benchmark.progress?.deferred ?? null,
      warning: 'Historical interim results have unequal suite coverage across pairings. They do not establish a fair ranking or explain a causal retrieval improvement.',
      pairings: (benchmark.pairings ?? []).map(pairing => ({ id: pairing.id, completedSuites: Object.entries(pairing.benchmarks ?? {}).filter(([, value]) => value !== null).map(([suite]) => suite), missingSuites: Object.entries(pairing.benchmarks ?? {}).filter(([, value]) => value === null).map(([suite]) => suite) })),
    },
  });
  const historicalFile = `benchmark-reference-${runId}.json`;
  const historicalText = JSON.stringify(snapshot, null, 2) + '\n';
  await writeFile(path.join(outputDir, historicalFile), historicalText, { flag: 'wx' }).catch(async error => {
    if (error.code !== 'EEXIST') throw error;
    if (await readFile(path.join(outputDir, historicalFile), 'utf8') !== historicalText) throw new Error('A different historical snapshot already exists for this run ID');
  });
  const descriptors = [];
  for (let round = 1; round <= 5; round += 1) {
    const supplied = rounds.find(item => item.round === round);
    if (!supplied?.file) { descriptors.push({ round, status: 'pending', file: null, sha256: null }); continue; }
    const file = publishedBasename(supplied.file, outputDir, `round-${round}-`);
    try {
      const loaded = await readReferenced(outputDir, file, `round-${round}-`);
      if (loaded.data.round !== round) throw new Error('Round number does not match its file reference');
      descriptors.push({ round, status: supplied.status ?? loaded.data.status ?? 'recorded', file, sha256: loaded.sha256 });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      descriptors.push({ round, status: 'pending', file: null, sha256: null });
    }
  }
  const manifest = {
    schemaVersion: 1, runId, timestamp, ...(sourceCommit ? { sourceCommit } : {}),
    baseline: sanitizePublicResult(configuration.baseline), pricing: sanitizePublicResult(pricing),
    configProvenance: { methodSha256: sha256(configText), pricingSha256: sha256(pricingText) },
    rounds: descriptors, historical: { status: 'historical_interim', file: historicalFile, sha256: sha256(historicalText) },
  };
  await writeFile(path.join(outputDir, 'latest.json'), JSON.stringify(manifest, null, 2) + '\n');
  return { manifest, file: path.join(outputDir, 'latest.json') };
}

export async function readGatewayResults({ resultsDir = path.join(repoRoot, 'results') } = {}) {
  let manifest;
  try { manifest = JSON.parse(await readFile(path.join(resultsDir, 'latest.json'), 'utf8')); }
  catch (error) {
    if (error.code !== 'ENOENT') throw error;
    return { status: 'pending', manifest: null, baseline: null, pricing: null, rounds: [1, 2, 3, 4, 5].map(round => ({ round, status: 'pending', data: null })), historical: null };
  }
  if (manifest.schemaVersion !== 1 || !Array.isArray(manifest.rounds)) throw new Error('Unsupported gateway results manifest');
  const rounds = [];
  for (let round = 1; round <= 5; round += 1) {
    const descriptor = manifest.rounds.find(item => item.round === round);
    if (!descriptor?.file) { rounds.push({ round, status: 'pending', data: null }); continue; }
    try {
      const loaded = await readReferenced(resultsDir, descriptor.file, `round-${round}-`, descriptor.sha256);
      if (loaded.data.round !== round) throw new Error('Round result identity does not match the manifest');
      rounds.push({ round, status: descriptor.status, data: sanitizePublicResult(loaded.data) });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      rounds.push({ round, status: 'pending', data: null });
    }
  }
  const historical = manifest.historical?.file
    ? sanitizePublicResult((await readReferenced(resultsDir, manifest.historical.file, 'benchmark-reference-', manifest.historical.sha256)).data)
    : null;
  return { status: rounds.every(item => item.data) ? 'recorded' : 'partial', manifest: sanitizePublicResult({ schemaVersion: manifest.schemaVersion, runId: manifest.runId, timestamp: manifest.timestamp, sourceCommit: manifest.sourceCommit, configProvenance: manifest.configProvenance }), baseline: sanitizePublicResult(manifest.baseline), pricing: sanitizePublicResult(manifest.pricing), rounds, historical };
}
