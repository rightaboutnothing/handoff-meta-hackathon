import { ingestFolder, getIndexStatus } from '../../src/rag/ingest.mjs';
import { askRag } from '../../src/rag/gateway.mjs';
import { metaAccessEnabled, ragConfig } from '../../src/server/gateway-models.mjs';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import dotenv from 'dotenv';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const dataDir = path.join(repoRoot, '.handoff');
dotenv.config({ path: path.join(repoRoot, '.env'), quiet: true });

function json(res, code, body) { res.statusCode = code; res.setHeader('Content-Type', 'application/json'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(body)); }
async function body(req) {
  let text = '';
  for await (const bytes of req) { text += bytes.toString(); if (text.length > 20000) throw new Error('Request too large'); }
  return JSON.parse(text);
}
let busy = false;
export function createCompanyMiddleware() {
  return async (req, res, next) => {
    if (!req.url?.startsWith('/api/company/')) return next();
    const origin = req.headers.origin;
    if (origin && !['http://127.0.0.1:4173', 'http://localhost:4173'].includes(origin)) return json(res, 403, { error: 'Local dashboard origin required' });
    try {
      if (req.url === '/api/company/status' && req.method === 'GET') return json(res, 200, { index: await getIndexStatus({ dataDir }), metaAccess: metaAccessEnabled() ? 'live' : 'paused', models: { local: ragConfig.localModel, guard: ragConfig.guardModel, cloud: ragConfig.cloudModel }, pricing: JSON.parse(await readFile(new URL('../../config/rag-pricing.json', import.meta.url), 'utf8')) });
      if (req.method !== 'POST') return json(res, 405, { error: 'POST required' });
      if (busy) return json(res, 409, { error: 'A local ingest or question is already running' });
      busy = true;
      try {
        const input = await body(req);
        if (req.url === '/api/company/ingest') {
          if (typeof input.folder !== 'string' || !input.folder.trim()) throw new Error('Enter a local folder path');
          return json(res, 200, await ingestFolder(path.resolve(repoRoot, input.folder), { dataDir }));
        }
        if (req.url === '/api/company/ask') {
          res.statusCode = 200; res.setHeader('Content-Type', 'text/event-stream'); res.setHeader('Cache-Control', 'no-cache'); res.setHeader('Connection', 'keep-alive');
          const emit = value => res.write(`data: ${JSON.stringify(value)}\n\n`);
          try { const result = await askRag(input.question, { dataDir, offlineMeta: !metaAccessEnabled(), onEvent: event => emit({ event }) }); emit({ result }); }
          catch { emit({ error: 'The local gateway could not complete this request. Check Ollama and the local index.' }); }
          res.end(); return;
        }
        return json(res, 404, { error: 'Unknown company endpoint' });
      } finally { busy = false; }
    } catch (error) { return json(res, 400, { error: error.message }); }
  };
}
