import { createHash } from 'node:crypto';
import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { sanitizePublicResult } from '../../src/evaluation/publish-results.mjs';

const root = fileURLToPath(new URL('../../results/', import.meta.url));
// Numeric token-component fields may be named query/localDraft. Their text
// counterparts and raw request collections must never escape this aggregate API.
function stripPayloadText(value,key='') {
  if(value==null||typeof value==='number'||typeof value==='boolean')return value;
  if(/^(?:payloads|requests|records|raw|rawPayload|rawPayloads|localRecords|answerRecords)$/i.test(key))return undefined;
  if(typeof value==='string'&&/^(?:system|systemPrompt|systemInstruction|query|redactedQuery|draft|localDraft|context|retrievedContext)$/i.test(key))return undefined;
  if(Array.isArray(value))return value.map(entry=>stripPayloadText(entry,key)).filter(entry=>entry!==undefined);
  if(typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,entry])=>[name,stripPayloadText(entry,name)]).filter(([,entry])=>entry!==undefined));
  return value;
}
async function regularFile(file, parent) {
  const info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Comparison reports must be regular local files');
  const resolved = await realpath(file);
  if (path.dirname(resolved).toLowerCase() !== parent.toLowerCase()) throw new Error('Invalid comparison report location');
  return readFile(resolved, 'utf8');
}

// Only a published aggregate is exposed. Checkpoints, answers, dataset rows and
// gated source caches are never reachable through this endpoint.
export async function readComparisonResults({ resultsDir = root } = {}) {
  let directory;
  try { directory = await realpath(resultsDir); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  let pointer;
  try { pointer = JSON.parse(await regularFile(path.join(directory, 'comparison-latest.json'), directory)); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (typeof pointer.directory !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(pointer.directory)) throw new Error('Invalid comparison directory reference');
  const runPath = path.join(directory, pointer.directory), info = await lstat(runPath);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Invalid comparison directory');
  const runDirectory = await realpath(runPath);
  if (path.dirname(runDirectory).toLowerCase() !== directory.toLowerCase()) throw new Error('Comparison directory escaped results');
  const text = await regularFile(path.join(runDirectory, 'report.json'), runDirectory);
  const expectedHash = pointer.reportSha256 ?? pointer.sha256;
  if (expectedHash && createHash('sha256').update(text).digest('hex') !== expectedHash) throw new Error('Comparison report hash mismatch');
  const report = JSON.parse(text);
  if (report.schemaVersion !== 1 || !Array.isArray(report.pipelines) || !Array.isArray(report.costPlan)) throw new Error('Unsupported comparison report');
  const allowed = ['schemaVersion', 'runId', 'timestamp', 'tier', 'status', 'cloudCalls', 'baseline', 'pipelines', 'costPlan', 'costPlanVariants', 'costAudit', 'calibration', 'environment', 'selection', 'categories', 'categoryWinners', 'notes', 'pricing', 'dataset', 'provenance'];
  return stripPayloadText(sanitizePublicResult(Object.fromEntries(allowed.filter(key => Object.hasOwn(report, key)).map(key => [key, report[key]]))));
}
