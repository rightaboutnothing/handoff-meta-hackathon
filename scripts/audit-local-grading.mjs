import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { loadComparisonDataset, loadComparisonManifest } from '../src/comparison/dataset.mjs';
import { loadAuditManifest, makeAuditManifest, auditLocalAnswers, AUDIT_MODELS } from '../src/comparison/grading-audit.mjs';
import { sha256 } from '../src/rag/receipts.mjs';
const args = process.argv.slice(2), option = key => { const i = args.indexOf(key); return i < 0 ? undefined : args[i + 1]; };
try {
  if (args.includes('--init-manifest')) {
    const manifestText = await readFile('tasks/comparison/manifest.json', 'utf8');
    const manifest = JSON.parse(manifestText), items = await loadComparisonDataset({ hydrateGpqa: false });
    const audit = makeAuditManifest(manifest, items, { sourceManifestHash: sha256(manifestText) });
    await writeFile('tasks/comparison/grading-audit-manifest.json', JSON.stringify(audit, null, 2) + '\n');
    console.log(JSON.stringify({ seed: audit.seed, randomHeldOutItems: audit.items, originalReportedItems: audit.originalReportedTestItems, categoryCounts: audit.categoryCounts, inferenceCalls: 0 }));
  } else {
    const input = option('--input'), output = option('--output');
    if (!input || !output) throw new Error('Usage: node scripts/audit-local-grading.mjs --init-manifest OR --input <private-local-answers.jsonl> --output <aggregate.json>');
    const manifest = await loadAuditManifest(), ids = [...new Set([...manifest.itemIds, ...manifest.originalReportedTestIds])];
    const items = await loadComparisonDataset({ split: 'test', ids }), lines = (await readFile(input, 'utf8')).split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
    const recordsByModel = Object.fromEntries(AUDIT_MODELS.map(model => [model, lines.filter(row => row.modelId === model)]));
    const report = auditLocalAnswers({ items, recordsByModel, manifest });
    await mkdir(path.dirname(output), { recursive: true }); await writeFile(output, JSON.stringify(report, null, 2) + '\n');
    console.log(JSON.stringify({ output, randomItems: report.random200.items, originalItems: report.originalReportedSlice.items, cloudCalls: 0, actualSpendUsd: 0 }));
  }
} catch (error) { console.error(error.message); process.exitCode = 1; }
