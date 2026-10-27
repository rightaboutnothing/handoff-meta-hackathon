import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { evaluateRag } from '../rag/evaluate.mjs';
import { warmUpGateway, ragConfig } from '../server/gateway-models.mjs';
import { sha256 } from '../rag/receipts.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
export async function runRoundTwo({ runId, timestamp = new Date().toISOString(), dataDir = path.join(root, '.handoff'), outputDir = path.join(root, 'results'), onProgress } = {}) {
  if (!runId || !/^[\w-]+$/.test(runId)) throw new Error('Round 2 requires a safe run ID');
  const warmUp = await warmUpGateway({ dataDir });
  const report = await evaluateRag({ dataDir, offlineMeta: true, mode: 'rag', warmUp, logRoot: path.join(root, '.logs/gateway-rounds', runId, 'round-2'), onProgress });
  const sum = key => report.results.reduce((total, row) => total + (Number(row.result.metrics?.[key]) || 0), 0);
  const estimatedAllCloudInputTokens = sum('estimatedAllCloudInputTokens');
  const estimatedHandoffInputTokens = report.results.filter(row => row.result.receipt).reduce((total, row) => total + (row.result.metrics.estimatedCloudInputTokens || 0), 0);
  const summary = { ...report.summary.rag, projectionCoverage: report.results.filter(row => Number.isFinite(row.result.metrics?.estimatedAllCloudInputTokens)).length / report.questionCount, projectionsComplete: report.summary.rag.errors === 0, estimatedAllCloudInputTokens, estimatedHandoffInputTokens,
    projectedTokensKeptLocal: Math.max(0, estimatedAllCloudInputTokens - estimatedHandoffInputTokens),
    projectedTokensKeptLocalPer1000: Math.max(0, estimatedAllCloudInputTokens - estimatedHandoffInputTokens) / report.questionCount * report.pricingAssumptions.queriesPerComparison,
    projectedSavingRate: 1 - report.summary.rag.estimatedHandoffPer1000Usd / report.summary.rag.estimatedAllCloudPer1000Usd,
    projectedSavingPer1000Usd: report.summary.rag.estimatedAllCloudPer1000Usd - report.summary.rag.estimatedHandoffPer1000Usd,
    actualCloudCalls: report.results.filter(row => row.result.route === 'cloud').length,
    blockedOutbound: report.results.reduce((n, row) => n + row.result.metrics.stages.filter(stage => stage.stage === 'guard_outbound' && !stage.safe).length, 0),
    flaggedInbound: null, inboundStatus: 'deferred_no_cloud_response' };
  const questions = (await readFile(path.join(root, 'demo_data/evaluation.jsonl'), 'utf8')).trim().split('\n').map(line => JSON.parse(line));
  const questionHashes = new Map(questions.map(q => [q.id, sha256(q.prompt)]));
  const items = report.results.map(row => ({ id: row.id, category: row.category, questionHash: questionHashes.get(row.id),
    status: row.result.status, route: row.result.route, confidence: row.result.confidence, retrievalQuality: row.result.retrievalQuality,
    scoring: row.scoring, citations: row.result.citations, metrics: row.result.metrics,
    receipt: row.result.receipt ? { runId: row.result.runId, verified: row.result.metrics.receiptVerified, status: row.result.receipt.payload.status,
      inputHash: row.result.receipt.payload.inputHash, chunks: row.result.receipt.payload.chunks,
      chain: row.result.receipt.chain ? { sequence: row.result.receipt.chain.sequence, entryHash: row.result.receipt.chain.entryHash } : null } : null }));
  const result = { schemaVersion: 1, round: 2, title: 'Company data retrieval', runId, timestamp, finishedAt: new Date().toISOString(),
    status: 'completed_offline', offlineMeta: true, fingerprint: report.fingerprint, datasetSha256: report.datasetSha256,
    baseline: ragConfig.baseline, method: report.method, pricing: report.pricingAssumptions, summary, items, limitations: report.limitations };
  await mkdir(outputDir, { recursive: true });
  const file = path.join(outputDir, `round-2-${runId}.json`);
  await writeFile(file, JSON.stringify(result, null, 2) + '\n');
  return { ...result, file };
}
