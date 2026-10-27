#!/usr/bin/env node
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { ingestFolder, getIndexStatus } from '../src/rag/ingest.mjs';
import { askRag } from '../src/rag/gateway.mjs';
import { warmUpGateway, metaAccessEnabled } from '../src/server/gateway-models.mjs';
import { verifyReceipt } from '../src/rag/receipts.mjs';

const args = process.argv.slice(2);
const command = args.shift();
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
const dataDir = path.resolve(option('--data-dir') || '.handoff');
const offlineMeta = args.includes('--offline-meta') || !args.includes('--live-meta') || !metaAccessEnabled();
try {
  if (command === 'ingest') {
    const folder = args[0];
    if (!folder || folder.startsWith('--')) throw new Error('Usage: handoff ingest <folder> [--data-dir <path>]');
    const result = await ingestFolder(path.resolve(folder), { dataDir, embeddingProvider: args.includes('--embeddings-fallback') ? 'sentence-transformers' : undefined });
    console.log(JSON.stringify(result, null, 2));
  } else if (command === 'ask') {
    const question = args[0];
    const result = await askRag(question, { dataDir, offlineMeta, localOnly: args.includes('--local-only'), retrievalEnabled: !args.includes('--no-retrieval') });
    console.log(JSON.stringify({ answer: result.answer, route: result.route, status: result.status, confidence: result.confidence, retrievalQuality: result.retrievalQuality, reason: result.reason, citations: result.citations, metrics: result.metrics, receipt: result.receipt ? { verified: result.metrics.receiptVerified, signature: result.receipt.signature, chunks: result.receipt.payload.chunks, status: result.receipt.payload.status } : null }, null, 2));
  } else if (command === 'eval-rag') {
    const { evaluateRag, writeRagReports } = await import('../src/rag/evaluate.mjs');
    console.error('Warming local Llama and Llama Guard, excluded from measured latency.');
    const warmUp = await warmUpGateway({ dataDir });
    const result = await evaluateRag({ dataDir, offlineMeta, warmUp, mode: args.includes('--paired') ? 'paired' : args.includes('--control') ? 'control' : 'rag', limit: option('--limit') ? Number(option('--limit')) : undefined, resume: !args.includes('--fresh'), onProgress: event => console.error(typeof event === 'string' ? event : JSON.stringify(event)) });
    const files = await writeRagReports(result);
    console.log(JSON.stringify({ summary: result.summary, comparison: result.comparison, fingerprint: result.fingerprint, files }, null, 2));
  } else if (command === 'status') console.log(JSON.stringify(await getIndexStatus({ dataDir }), null, 2));
  else if (command === 'verify-receipt') {
    const receipt = JSON.parse(await readFile(args[0], 'utf8'));
    const verified = await verifyReceipt(receipt, { dataDir });
    console.log(JSON.stringify({ verified })); if (!verified) process.exitCode = 1;
  } else console.log('Handoff private AI gateway\n\n  handoff ingest <folder>\n  handoff ask "<question>" [--offline-meta]\n  handoff eval-rag [--paired] [--offline-meta]\n  handoff status\n  handoff verify-receipt <receipt.json>\n\nAll state stays in ignored .handoff/. Meta defaults to paused.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
