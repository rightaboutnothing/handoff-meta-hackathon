import { mkdir, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyReceiptChain } from '../rag/receipts.mjs';
import { ragConfig } from '../server/gateway-models.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function discoverReceiptLedgers(dataDir) {
  const found = [];
  async function visit(directory, depth) {
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (entries.some(entry => entry.isFile() && ['receipts.jsonl', 'receipt-head.json', 'receipt-pending.json'].includes(entry.name))) found.push(directory);
    if (depth < 8) for (const entry of entries) if (entry.isDirectory() && !['keys', 'payloads', 'privacy-demo', 'node_modules'].includes(entry.name)) await visit(path.join(directory, entry.name), depth + 1);
  }
  await visit(path.resolve(dataDir), 0);
  return found.sort();
}

export async function runRoundFive({ runId, timestamp = new Date().toISOString(), dataDir = path.join(root, '.handoff'), dataDirs, additionalDataDirs = [],
  outputDir = path.join(root, 'results'), onProgress, verify = verifyReceiptChain,
} = {}) {
  if (!runId || !/^[A-Za-z0-9._-]+$/.test(runId)) throw new Error('A safe testing run ID is required');
  const directories = [...new Set([...(dataDirs ?? await discoverReceiptLedgers(dataDir)), ...additionalDataDirs].map(directory => path.resolve(directory)))];
  const ledgers = [];
  for (const directory of directories) {
    let report;
    try { report = await verify({ dataDir: directory, verifyPayloads: true }); }
    catch { report = { valid: false, total: 0, verifiedSignatures: 0, chained: 0, legacyUnchained: 0, payloadsVerified: 0, payloadsMissing: 0, headVerified: false, breaks: [{ code: 'ledger_could_not_be_read' }], details: [] }; }
    ledgers.push({ ledger: path.relative(dataDir, directory).split(path.sep).join('/') || '.', ...report });
    await onProgress?.({ round: 5, finished: ledgers.length, total: directories.length, valid: report.valid, receipts: report.total, breaks: report.breaks.length });
  }
  const sum = key => ledgers.reduce((total, ledger) => total + (ledger[key] ?? 0), 0);
  const summary = { ledgers: ledgers.length, receipts: sum('total'), signaturesVerified: sum('verifiedSignatures'), chained: sum('chained'), legacyUnchained: sum('legacyUnchained'),
    payloadHashesVerified: sum('payloadsVerified'), legacyPayloadSnapshotsMissing: sum('payloadsMissing'),
    headsVerified: ledgers.filter(ledger => ledger.headVerified).length,
    breaks: ledgers.reduce((total, ledger) => total + ledger.breaks.length, 0), valid: ledgers.length > 0 && ledgers.every(ledger => ledger.valid),
    completeChainCoverage: ledgers.length > 0 && ledgers.every(ledger => ledger.headVerified && ledger.legacyUnchained === 0 && ledger.payloadsMissing === 0 && ledger.valid),
  };
  const result = { round: 5, name: 'Full local receipt-chain verification', runId, timestamp, completedAt: new Date().toISOString(),
    status: summary.valid ? summary.completeChainCoverage ? 'completed' : 'completed_with_legacy_coverage' : 'integrity_breaks_or_empty',
    method: { version: 'receipt-chain-verification-v1', offlineMeta: true, verifyPayloads: true, historicalBaseline: ragConfig.baseline }, summary, ledgers,
    limitations: ['Legacy receipts were signed individually. Their signatures are checked, but they are never represented as originally hash-chained.', 'Older receipts may lack exact retained payload snapshots; missing historical coverage is reported separately from cryptographic breaks.', 'Signed local heads detect ledger truncation against the retained head; simultaneous rollback of both local ledger and head needs an independent external anchor to detect.', 'Local cryptographic integrity does not prove cloud delivery, billing or answer accuracy.'],
  };
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, `round-5-${runId}.json`);
  await writeFile(file, JSON.stringify(result, null, 2) + '\n');
  return { ...result, file };
}
