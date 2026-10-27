import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { getModelApiKey } from './env.mjs';

export const ragConfig = JSON.parse(await readFile(new URL('../../config/rag.json', import.meta.url), 'utf8'));
const configuredHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
const localBase = configuredHost.includes('://') ? configuredHost : `http://${configuredHost}`;
const parsedHost = new URL(localBase);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedHost.hostname) || parsedHost.protocol !== 'http:' || parsedHost.username || parsedHost.password) throw new Error('RAG model inference must use a loopback Ollama host');

export function metaAccessEnabled() {
  return process.env.META_ACCESS_STATUS === 'live' && process.env.HANDOFF_META_ACCESS_CONFIRMED === 'true';
}

export async function localChat(model, messages, { json = false, maxTokens = ragConfig.maxOutputTokens } = {}) {
  const start = performance.now();
  const response = await fetch(`${localBase}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, keep_alive: ragConfig.keepAlive,
      ...(json ? { format: 'json' } : {}), options: { temperature: ragConfig.temperature, seed: ragConfig.seed, num_predict: maxTokens, num_ctx: 4096 } }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`Local model ${model} returned HTTP ${response.status}`);
  const data = await response.json();
  return { text: data.message?.content ?? '', modelId: model, latencyMs: performance.now() - start,
    tokens: { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0, total: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0) } };
}

export async function guardText(question, answer) {
  try {
    const response = await localChat(ragConfig.guardModel, [
      { role: 'user', content: question }, ...(answer === undefined ? [] : [{ role: 'assistant', content: answer }]),
    ], { maxTokens: 40 });
    const safe = /^safe\s*$/i.test(response.text.trim());
    return { ...response, safe, classification: safe ? 'safe' : 'unsafe', reason: safe ? 'Llama Guard classified the content safe' : 'Llama Guard blocked or could not verify the content' };
  } catch (error) {
    return { safe: false, classification: 'unavailable', reason: 'Llama Guard unavailable, boundary closed', modelId: ragConfig.guardModel, latencyMs: 0, tokens: { input: 0, output: 0, total: 0 } };
  }
}

export async function callMuse(input, { offlineMeta = true } = {}) {
  if (offlineMeta || !metaAccessEnabled()) throw new Error('Meta access is paused; cloud request deferred');
  const client = new OpenAI({ baseURL: 'https://api.meta.ai/v1', apiKey: getModelApiKey(), maxRetries: 3, timeout: 120000 });
  const started = performance.now();
  const response = await client.responses.create({ model: ragConfig.cloudModel, input, reasoning: { effort: ragConfig.reasoningEffort }, max_output_tokens: ragConfig.maxOutputTokens });
  return { text: response.output_text ?? '', modelId: ragConfig.cloudModel, responseId: response.id,
    latencyMs: performance.now() - started,
    tokens: { input: response.usage?.input_tokens ?? 0, output: response.usage?.output_tokens ?? 0, total: response.usage?.total_tokens ?? 0 },
    providerCostUsd: Number.isFinite(response.usage?.cost) ? response.usage.cost : null };
}

export async function warmUpGateway({ dataDir } = {}) {
  const started = performance.now();
  const llama = await localChat(ragConfig.localModel, [{ role: 'user', content: 'Reply OK.' }], { maxTokens: 3 });
  const guard = await guardText('A harmless synthetic company policy lookup.');
  const { embedTexts } = await import('../rag/embeddings.mjs');
  const { getIndexStatus } = await import('../rag/store.mjs');
  const indexed = getIndexStatus({ dataDir }).embeddingModel;
  const embeddingStarted = performance.now();
  const embedding = await embedTexts(['A harmless synthetic company lookup.'], { kind: 'query', provider: indexed?.provider ?? 'auto', model: indexed?.model });
  return { latencyMs: performance.now() - started, excludedFromTimings: true, models: [ragConfig.localModel, ragConfig.guardModel, embedding.model],
    stages: [{ modelId: llama.modelId, latencyMs: llama.latencyMs }, { modelId: guard.modelId, latencyMs: guard.latencyMs, classification: guard.classification }, { modelId: embedding.model, latencyMs: performance.now() - embeddingStarted }] };
}
