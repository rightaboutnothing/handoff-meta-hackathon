import { ingestFolder, getIndexStatus } from '../../src/rag/ingest.mjs';
import { askRag } from '../../src/rag/gateway.mjs';
import { metaAccessEnabled, ragConfig } from '../../src/server/gateway-models.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';
import { readGatewayResults, sanitizePublicResult } from '../../src/evaluation/publish-results.mjs';
import { runRoundFive } from '../../src/evaluation/round-five.mjs';
import { readOutboundPayload, verifyReceiptPayload, verifyReceiptChain } from '../../src/rag/receipts.mjs';
import { readComparisonResults } from './comparison-results.mjs';
import { readStage4Results } from './stage4-results.mjs';
import { readStage5Results } from './stage5-results.mjs';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = path.join(repoRoot, '.handoff');
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

function json(res, code, body) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); }
async function body(req) {
  let text = '';
  for await (const bytes of req) { text += bytes.toString(); if (text.length > 20000) throw new Error('Request too large'); }
  return text.trim() ? JSON.parse(text) : {};
}
let busy = false;
export function createCompanyMiddleware() {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/company/')) return next();
    const origin = req.headers.origin;
    if (origin && !['http://127.0.0.1:4173', 'http://localhost:4173'].includes(origin)) return json(res, 403, { error: 'Local dashboard origin required' });
    try {
      if (req.url === '/api/company/results' && req.method === 'GET') return json(res, 200, await readGatewayResults());
      if (req.url === '/api/company/comparison' && req.method === 'GET') return json(res, 200, await readComparisonResults());
      if (req.url === '/api/company/stage4' && req.method === 'GET') return json(res, 200, await readStage4Results());
      if (req.url === '/api/company/stage5' && req.method === 'GET') return json(res, 200, await readStage5Results());
      if (req.url === '/api/company/status' && req.method === 'GET') return json(res, 200, { index: await getIndexStatus({ dataDir }), metaAccess: metaAccessEnabled() ? 'live' : 'paused', routing: { lockedCompanyRoutingEnabled: ragConfig.lockedCompanyRoutingEnabled === true, localCompanyModel: ragConfig.lockedCompanyRoutingEnabled === true ? 'gemma3:12b' : ragConfig.localModel, otherSafeTasks: ragConfig.lockedCompanyRoutingEnabled === true ? 'guarded_escalation' : 'legacy_confidence_routing', futureCertified: false }, models: { local: ragConfig.lockedCompanyRoutingEnabled === true ? 'gemma3:12b' : ragConfig.localModel, guard: ragConfig.guardModel, cloud: ragConfig.cloudModel }, pricing: JSON.parse(await readFile(new URL('../../config/rag-pricing.json', import.meta.url), 'utf8')) });
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      if (busy) return json(res, 409, { error: 'A local ingest or question is already running' });
      busy = true;
      try {
        const input = await body(req);
        if (req.url === '/api/company/verify-receipts') {
          const timestamp = new Date().toISOString();
          const report = await runRoundFive({ runId: `verify-${timestamp.replace(/[:.]/g, '-')}`, timestamp, dataDir });
          return json(res, 200, sanitizePublicResult(report));
        }
        if (req.url === '/api/company/ingest') {
          if (typeof input.folder !== 'string' || !input.folder.trim()) throw new Error('Enter a local folder path');
          return json(res, 200, await ingestFolder(path.resolve(repoRoot, input.folder), { dataDir }));
        }
        if (req.url === '/api/company/ask') {
          res.statusCode = 200; res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
          const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
          try {
            const result = await askRag(input.question, { dataDir, offlineMeta: !metaAccessEnabled(), onEvent: event => emit({ event }) });
            if (result.receipt) {
              const snapshot = await readOutboundPayload(result.runId, { dataDir });
              const payload = await verifyReceiptPayload(result.receipt, { dataDir });
              const chain = await verifyReceiptChain({ dataDir });
              result.boundary = { input: snapshot?.input ?? null, inputHash: result.receipt.payload.inputHash,
                disposition: result.receipt.payload.status === 'deferred' ? 'proposed' : result.metrics.cloudDeliveryUnknown ? 'unknown' : 'sent' };
              result.receiptVerification = { signature: result.metrics.receiptVerified, payload: payload.verified, chain: chain.valid, sequence: result.receipt.chain?.sequence };
            }
            emit({ result });
          }
          catch { emit({ error: 'The local gateway could not complete this request. Check Ollama and the local index.' }); }
          res.end(); return;
        }
        return json(res, 404, { error: 'Unknown company endpoint' });
      } finally { busy = false; }
    } catch (error) { return json(res, 400, { error: error.message }); }
  };
}
