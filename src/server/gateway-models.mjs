import OpenAI from 'openai';
import { readFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { getModelApiKey } from './env.mjs';
import {llamaGuardPrompt} from './comparison-models.mjs';
import {assertNoRawPrivatePatterns} from '../comparison/handoff-payload.mjs';
import {sha256} from '../rag/receipts.mjs';

export const ragConfig = JSON.parse(await readFile(new URL('../../config/rag.json', import.meta.url), 'utf8'));
const configuredHost = process.env.OLLAMA_HOST || 'http://localhost:11434';
const localBase = configuredHost.includes('://') ? configuredHost : `http://${configuredHost}`;
const parsedHost = new URL(localBase);
if (!['localhost', '127.0.0.1', '[::1]'].includes(parsedHost.hostname) || parsedHost.protocol !== 'http:' || parsedHost.username || parsedHost.password) throw new Error('RAG model inference must use a loopback Ollama host');

export function metaAccessEnabled() {
  return process.env.META_ACCESS_STATUS === 'live' && process.env.HANDOFF_META_ACCESS_CONFIRMED === 'true';
}

export async function localChat(model, messages, { json = false, maxTokens = ragConfig.maxOutputTokens, schema } = {}) {
  if (schema !== undefined && (!schema || typeof schema !== 'object' || Array.isArray(schema))) throw new Error('Local structured output schema must be an object');
  const start = performance.now();
  const response = await fetch(`${localBase}/api/chat`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false, keep_alive: ragConfig.keepAlive,
      ...(schema ? { format: schema } : json ? { format: 'json' } : {}), options: { temperature: ragConfig.temperature, seed: ragConfig.seed, num_predict: maxTokens, num_ctx: 4096 } }),
    signal: AbortSignal.timeout(180000),
  });
  if (!response.ok) throw new Error(`Local model ${model} returned HTTP ${response.status}`);
  const data = await response.json();
  return { text: data.message?.content ?? '', modelId: model, latencyMs: performance.now() - start, doneReason:data.done_reason??null,
    tokens: { input: data.prompt_eval_count ?? 0, output: data.eval_count ?? 0, total: (data.prompt_eval_count ?? 0) + (data.eval_count ?? 0) },
    settings: { temperature: ragConfig.temperature, seed: ragConfig.seed, keepAlive: ragConfig.keepAlive, maxTokens, contextTokens: 4096, json, schema: Boolean(schema) } };
}

export async function guardText(question, answer) {
  const started=performance.now(),direction=answer===undefined?'outbound':'inbound',prompt=llamaGuardPrompt(question,answer);
  try {
    if(ragConfig.guardModel!=='llama-guard3:8b')throw new Error('The gateway requires the pinned local Llama Guard model');
    const reply=await fetch(`${localBase}/api/generate`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:ragConfig.guardModel,prompt,raw:true,stream:false,keep_alive:ragConfig.keepAlive,options:{temperature:ragConfig.temperature,seed:ragConfig.seed,num_predict:40,num_ctx:4096}}),signal:AbortSignal.timeout(180000)});
    if(!reply.ok)throw new Error('Local Guard HTTP failure');
    const data=await reply.json(),text=data.response??data.message?.content??'',trimmed=String(text).trim();
    const output=data.eval_count??0,truncated=output>=40||data.done_reason==='length';
    const unsafe=/^unsafe(?:\s*\r?\n\s*(S(?:1[0-4]|[1-9])(?:\s*,\s*S(?:1[0-4]|[1-9]))*))?\s*$/i.exec(trimmed);
    const safe=!truncated&&/^safe$/i.test(trimmed),classification=safe?'safe':!truncated&&unsafe?'unsafe':'invalid';
    const safetyCategories=unsafe?.[1]?[...new Set(unsafe[1].toUpperCase().split(/\s*,\s*/))]:[];
    const input=data.prompt_eval_count??0;
    return {text,modelId:ragConfig.guardModel,latencyMs:performance.now()-started,tokens:{input,output,total:input+output},doneReason:data.done_reason??null,
      settings:{temperature:ragConfig.temperature,seed:ragConfig.seed,keepAlive:ragConfig.keepAlive,maxTokens:40,contextTokens:4096,raw:true},
      safe,classification,safetyCategories,categories:safetyCategories,direction,
      policyProtocol:'Meta Llama Guard 3 explicit raw User/Agent S1-S14 template',policyTemplateHash:sha256(llamaGuardPrompt('',answer===undefined?undefined:'')),promptHash:sha256(prompt),
      reason:safe?'Llama Guard classified the redacted content safe':classification==='unsafe'?'Llama Guard classified the content unsafe':'Llama Guard output was invalid or truncated; boundary closed'};
  } catch (error) {
    return { safe: false, classification: 'unavailable', safetyCategories:[],categories:[],direction,reason: 'Llama Guard unavailable, boundary closed', modelId: ragConfig.guardModel, latencyMs: performance.now()-started, tokens: { input: 0, output: 0, total: 0 },policyProtocol:'Meta Llama Guard 3 explicit raw User/Agent S1-S14 template',policyTemplateHash:sha256(llamaGuardPrompt('',answer===undefined?undefined:'')) };
  }
}

const releases=new WeakMap();
/** Both the measured dry run and live gateway use this exact redacted-input
 * boundary. A verdict for one immutable input cannot authorize another input. */
export async function screenForCloud(input,{guard=guardText,localOnly=false,allowInjectedLegacy=false}={}){
  if(typeof input!=='string'||!input.trim())throw new Error('A redacted cloud input is required');
  assertNoRawPrivatePatterns(input);
  if(localOnly)return{safe:false,classification:'local_only',safetyCategories:[],categories:[],wouldRelease:false,releasePermit:null,reason:'The server safety policy keeps this item local',modelId:ragConfig.guardModel,latencyMs:0,tokens:{input:0,output:0,total:0}};
  const result=await guard(input),classification=result?.classification??(allowInjectedLegacy&&result?.safe===true?'safe':'invalid');
  const safe=result?.safe===true&&classification==='safe',permit=safe?Object.freeze({}):null;
  if(permit)releases.set(permit,{hash:sha256(input),modelId:result.modelId});
  return{...result,classification,safe,safetyCategories:result?.safetyCategories??result?.categories??[],wouldRelease:safe,releasePermit:permit,inputHash:sha256(input)};
}
export function assertCloudRelease(input,permit){
  if(!permit||!releases.has(permit)||releases.get(permit).hash!==sha256(input))throw new Error('Cloud boundary requires an unused Guard pass for the exact redacted input');
  releases.delete(permit);return true;
}

export async function callMuse(input, { offlineMeta = true,releasePermit } = {}) {
  if (offlineMeta || !metaAccessEnabled()) throw new Error('Meta access is paused; cloud request deferred');
  assertCloudRelease(input,releasePermit);
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
  const activeModel=ragConfig.lockedCompanyRoutingEnabled?'gemma3:12b':ragConfig.localModel;
  const llama = await localChat(activeModel, [{ role: 'user', content: 'Reply OK.' }], { maxTokens: 3 });
  const guard = await guardText('A harmless synthetic company policy lookup.');
  const { embedTexts } = await import('../rag/embeddings.mjs');
  const { getIndexStatus } = await import('../rag/store.mjs');
  const indexed = getIndexStatus({ dataDir }).embeddingModel;
  const embeddingStarted = performance.now();
  const embedding = await embedTexts(['A harmless synthetic company lookup.'], { kind: 'query', provider: indexed?.provider ?? 'auto', model: indexed?.model });
  return { latencyMs: performance.now() - started, excludedFromTimings: true, models: [activeModel, ragConfig.guardModel, embedding.model],
    stages: [{ modelId: llama.modelId, latencyMs: llama.latencyMs }, { modelId: guard.modelId, latencyMs: guard.latencyMs, classification: guard.classification }, { modelId: embedding.model, latencyMs: performance.now() - embeddingStarted }] };
}
