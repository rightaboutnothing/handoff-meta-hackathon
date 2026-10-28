import OpenAI from 'openai';
import dotenv from 'dotenv';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { assertCloudEligible } from '../comparison/policy.mjs';
import { assertLeanWire, serializeLeanUserPayload, semanticLeanWireText } from '../comparison/handoff-payload.mjs';

// Resolve .env against the project, regardless of the command's working directory.
dotenv.config({ path: new URL('../../.env', import.meta.url), quiet: true });
export const CLOUD_MODELS = Object.freeze({ 'muse-spark': 'muse-spark-1.3', gemini: 'gemini-3.1-flash-lite' });
const executionConfig = JSON.parse(await readFile(new URL('../../config/comparison.json', import.meta.url), 'utf8'));
export const COMPARISON_SETTINGS = Object.freeze({ temperature: executionConfig.temperature, seed: executionConfig.seed,
  maxTokens: executionConfig.maxOutputTokens, contextTokens: executionConfig.contextTokens, keepAlive: executionConfig.keepAlive,
  reasoningEffort: executionConfig.reasoningEffort, guardMaxTokens: executionConfig.guardMaxTokens });
const localModels = new Set(executionConfig.localModels.map(model => model.modelId));
const guards = new Set(executionConfig.guards.map(model => model.modelId));
const sha = text => createHash('sha256').update(text).digest('hex');
export async function loadPricing() { return JSON.parse(await readFile(new URL('../../config/pricing.yaml', import.meta.url), 'utf8')); }
export function estimateCloudCost(cloudId, { inputTokens = 0, outputTokens = 0, reasoningTokens = 0 }, pricing) {
  const rate = pricing.clouds[cloudId];
  if (!rate) throw new Error('Unsupported direct cloud provider');
  return (inputTokens * rate.inputUsdPerMillion + (outputTokens + reasoningTokens) * rate.outputUsdPerMillion) / 1e6;
}
export function estimateRequest(cloudId, input, { maxTokens = COMPARISON_SETTINGS.maxTokens, pricing, tokenCounts, category } = {}) {
  if (!pricing) throw new Error('Explicit pricing assumptions required');
  const rate = pricing.clouds[cloudId];
  if (!rate) throw new Error('Unsupported direct cloud provider');
  const projection=pricing.outputProjections?.[category];
  const hasCounts=Number.isFinite(tokenCounts?.inputTokens)&&tokenCounts.inputTokens>=0;
  const hasProjection=projection&&Number.isFinite(projection.answerTokens)&&Number.isFinite(projection.reasoningTokens)&&projection.answerTokens>=0&&projection.reasoningTokens>=0&&projection.answerTokens+projection.reasoningTokens<=maxTokens;
  const estimatedTokens = { input: hasCounts?tokenCounts.inputTokens:null, output: hasProjection?projection.answerTokens:null, reasoning:hasProjection?projection.reasoningTokens:null };
  const reservationText=typeof input==='string'?input:semanticLeanWireText(input);
  const upperTokens = { input: Buffer.byteLength(reservationText, 'utf8') + 256, output: maxTokens, reasoning: rate.maxReasoningTokensReserved };
  if (upperTokens.input > rate.maximumInputTokens) throw new Error('Cloud payload exceeds conservative input limit');
  return { estimatedTokens, upperTokens,
    estimatedCostUsd:hasCounts&&hasProjection?estimateCloudCost(cloudId, { inputTokens: estimatedTokens.input, outputTokens: estimatedTokens.output, reasoningTokens: estimatedTokens.reasoning }, pricing):null,
    reservedUpperUsd: estimateCloudCost(cloudId, { inputTokens: upperTokens.input, outputTokens: upperTokens.output, reasoningTokens: upperTokens.reasoning }, pricing),
    assumptions: true, inputHash: sha(reservationText), modelId: CLOUD_MODELS[cloudId],countingStatus:hasCounts?'counted_content_tokens':'pending_tokenizer',tokenCounting:tokenCounts?.metadata??null,serverFramingTokens:tokenCounts?.serverFramingTokens??null,outputProjection:hasProjection?{...projection,category,assumption:true}:null };
}
function localBase() {
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const url = new URL(host.includes('://') ? host : `http://${host}`);
  if (!['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' || url.username || url.password) throw new Error('Comparison inference must use loopback Ollama');
  return url.origin;
}
function tokenCounts(data) {
  const input = data.prompt_eval_count ?? 0, output = data.eval_count ?? 0;
  return { input, output, total: input + output };
}
async function ollama(endpoint, body) {
  const started = performance.now();
  const response = await fetch(`${localBase()}/api/${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, stream: false, keep_alive: COMPARISON_SETTINGS.keepAlive }), signal: AbortSignal.timeout(180000) });
  if (!response.ok) throw new Error(`Local inference returned HTTP ${response.status}`);
  const data = await response.json();
  return { text: data.message?.content ?? data.response ?? '', modelId: body.model, latencyMs: performance.now() - started, tokens: tokenCounts(data),
    settings: { ...COMPARISON_SETTINGS, maxTokens: body.options.num_predict, json: body.format === 'json' },
    ollamaTiming: { totalDurationNs: data.total_duration, loadDurationNs: data.load_duration, promptDurationNs: data.prompt_eval_duration, evalDurationNs: data.eval_duration } };
}
export async function comparisonLocal(modelId, messages, { maxTokens = COMPARISON_SETTINGS.maxTokens, json = true } = {}) {
  if (!localModels.has(modelId)) throw new Error('Unregistered local comparison model');
  return ollama('chat', { model: modelId, messages, ...(json ? { format: 'json' } : {}),
    options: { temperature: COMPARISON_SETTINGS.temperature, seed: COMPARISON_SETTINGS.seed, num_predict: maxTokens, num_ctx: COMPARISON_SETTINGS.contextTokens } });
}

// Exact category names from the installed Meta Llama Guard 3 template. Using raw
// formatting avoids its ambiguous hardcoded "last User" instruction on inbound.
const llamaPolicies = `S1: Violent Crimes.\nS2: Non-Violent Crimes.\nS3: Sex Crimes.\nS4: Child Exploitation.\nS5: Defamation.\nS6: Specialized Advice.\nS7: Privacy.\nS8: Intellectual Property.\nS9: Indiscriminate Weapons.\nS10: Hate.\nS11: Suicide & Self-Harm.\nS12: Sexual Content.\nS13: Elections.\nS14: Code Interpreter Abuse.`;
export function llamaGuardPrompt(input, answer) {
  const role = answer === undefined ? 'User' : 'Agent';
  return `<|begin_of_text|><|start_header_id|>user<|end_header_id|>\n\nTask: Check if there is unsafe content in '${role}' messages in conversations according to our safety policy with the below categories.\n\n<BEGIN UNSAFE CONTENT CATEGORIES>\n${llamaPolicies}\n<END UNSAFE CONTENT CATEGORIES>\n\n<BEGIN CONVERSATION>\nUser: ${input}${answer === undefined ? '' : `\n\nAgent: ${answer}`}\n<END CONVERSATION>\n\nProvide your safety assessment for ONLY THE LAST ${role} message in the above conversation:\n- First line must read 'safe' or 'unsafe'.\n- If unsafe, a second line must include a comma-separated list of violated categories.<|eot_id|><|start_header_id|>assistant<|end_header_id|>\n\n`;
}
export function parseGuardResponse(guardId, text) {
  if (guardId === 'shieldgemma:9b') {
    const match = /^\s*(Yes|No)\b[.,:]?/i.exec(text);
    return { safe: match?.[1].toLowerCase() === 'no', classification: !match ? 'invalid' : match[1].toLowerCase() === 'no' ? 'safe' : 'unsafe' };
  }
  const first = text.trim().split(/\r?\n/)[0];
  return { safe: first === 'safe', classification: first === 'safe' ? 'safe' : first === 'unsafe' ? 'unsafe' : 'invalid' };
}
export async function comparisonGuard(guardId, input, answer) {
  if (!guards.has(guardId)) throw new Error('Unregistered local comparison guard');
  const started = performance.now();
  const direction = answer === undefined ? 'outbound' : 'inbound';
  try {
    const prompt = guardId === 'llama-guard3:8b' ? llamaGuardPrompt(input, answer) : null;
    const response = await ollama(prompt ? 'generate' : 'chat', { model: guardId,
      ...(prompt ? { prompt, raw: true } : { messages: [{ role: 'user', content: input }, ...(answer === undefined ? [] : [{ role: 'assistant', content: answer }])] }),
      options: { temperature: COMPARISON_SETTINGS.temperature, seed: COMPARISON_SETTINGS.seed, num_predict: COMPARISON_SETTINGS.guardMaxTokens, num_ctx: COMPARISON_SETTINGS.contextTokens } });
    return { ...response, ...parseGuardResponse(guardId, response.text), direction,
      policyProtocol: prompt ? 'Meta Llama Guard 3 User/Agent S1-S14 raw template' : 'Ollama ShieldGemma native template; four Google safety policies; Yes/No verdict',
      policyTemplateHash: prompt ? sha(llamaGuardPrompt('', answer === undefined ? undefined : '')) : null,
      promptHash: sha(prompt ?? JSON.stringify({ input, answer })),
      policySource: prompt ? 'https://www.llama.com/docs/model-cards-and-prompt-formats/llama-guard-3/' : 'https://registry.ollama.com/library/shieldgemma' };
  } catch {
    return { safe: false, classification: 'unavailable', modelId: guardId, direction, latencyMs: performance.now() - started,
      text: '', tokens: { input: 0, output: 0, total: 0 }, reason: 'Guard unavailable; boundary closed' };
  }
}
export function metaAccessEnabled() {
  return process.env.META_ACCESS_STATUS === 'live' && process.env.HANDOFF_META_ACCESS_CONFIRMED === 'true';
}
function requireKey(name) {
  if (!process.env[name]) throw new Error(`Missing ${name} in the local environment`);
  return process.env[name];
}
function validUsage(...counts) { return counts.every(value => Number.isFinite(value) && value >= 0); }
function assertRedacted(input) {
  if (/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/.test(input) || /\bCANARY-[A-Za-z0-9-]+\b/i.test(input) || /(?:\+\d[\d ()-]{7,}\d)/.test(input)) {
    const error = new Error('Cloud boundary denied: payload still contains a private-field pattern'); error.code = 'UNREDACTED_PAYLOAD'; throw error;
  }
}
/** The ONLY new cloud inference path. Policy and Tier 0 gates precede keys/network. */
export async function directCloud({ cloudId, item, registry, input, payload, tokenCounts, budget, pricing,
  tier = 0, offline = true, maxTokens = COMPARISON_SETTINGS.maxTokens, requestId = randomUUID(),
  dependencies = {} } = {}) {
  assertCloudEligible(item, registry);
  if (!Object.hasOwn(CLOUD_MODELS, cloudId)) throw new Error('Unsupported direct cloud provider');
  const structured=payload??(input&&typeof input==='object'?input:null);
  let system='',semanticInput;
  if(structured){try{const wire=assertLeanWire(structured.wire??{system:structured.system,query:structured.query,context:structured.context.map(({chunkId,text})=>({chunkId,text})),draft:structured.draft??null});system=wire.system;input=serializeLeanUserPayload(wire);semanticInput=semanticLeanWireText(wire);}catch{throw Object.assign(new Error('Cloud boundary denied: invalid lean payload or residual private fields'),{code:'UNREDACTED_PAYLOAD'});}}
  if (typeof input !== 'string' || !input) throw new Error('Cloud input must be a redacted text payload');
  semanticInput??=input;
  assertRedacted(`${system}\n${input}`);
  const rates = pricing ?? await loadPricing();
  const estimate = estimateRequest(cloudId, semanticInput, { maxTokens, pricing: rates, tokenCounts, category:item.category });
  if (tier === 0 || offline) return { status: 'deferred_tier0', cloudId, modelId: CLOUD_MODELS[cloudId], ...estimate, zeroCloudCalls: true };
  if (![1, 2].includes(tier)) throw new Error('Unknown comparison tier');
  if (cloudId === 'muse-spark' && !metaAccessEnabled()) return { status: 'deferred_meta', cloudId, modelId: CLOUD_MODELS[cloudId], ...estimate, zeroCloudCalls: true };
  if (!(Number(process.env.CLOUD_BUDGET_USD) > 0)) { const error = new Error('Set CLOUD_BUDGET_USD above 0 before dispatch'); error.code = 'CLOUD_BUDGET_EXHAUSTED'; throw error; }
  if (!budget || typeof budget.reserve !== 'function') throw new Error('Cloud request requires a durable budget ledger');
  const apiKey = requireKey(cloudId === 'gemini' ? 'GEMINI_API_KEY' : 'MODEL_API_KEY');
  await budget.reserve({ requestId, cloudId, upperBoundUsd: estimate.reservedUpperUsd });
  const started = performance.now();
  try {
    let text, tokens, responseId, modelVersion, providerReportedCostUsd = null;
    if (cloudId === 'muse-spark') {
      const clientOptions = { apiKey, baseURL: 'https://api.meta.ai/v1', maxRetries: 0, timeout: 120000 };
      const client = dependencies.createMetaClient?.(clientOptions) ?? new OpenAI(clientOptions);
      const response = await client.responses.create({ model: CLOUD_MODELS[cloudId], input,...(system?{instructions:system,prompt_cache_key:`handoff-system-${sha(system).slice(0,32)}`} : {}),store:false, temperature: COMPARISON_SETTINGS.temperature,
        reasoning: { effort: COMPARISON_SETTINGS.reasoningEffort }, max_output_tokens: maxTokens });
      text = response.output_text ?? ''; responseId = response.id; modelVersion = response.model ?? CLOUD_MODELS[cloudId];
      tokens = { input: response.usage?.input_tokens, output: response.usage?.output_tokens,
        reasoning: response.usage?.output_tokens_details?.reasoning_tokens ?? 0, total: response.usage?.total_tokens,cachedInput:response.usage?.input_tokens_details?.cached_tokens??null };
      if (Number.isFinite(response.usage?.cost)) providerReportedCostUsd = response.usage.cost;
    } else {
      const response = await (dependencies.fetch ?? fetch)(`https://generativelanguage.googleapis.com/v1beta/models/${CLOUD_MODELS[cloudId]}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
        body: JSON.stringify({...(system?{systemInstruction:{parts:[{text:system}]}}:{}), contents: [{ role: 'user', parts: [{ text: input }] }], generationConfig: {
          temperature: COMPARISON_SETTINGS.temperature, seed: COMPARISON_SETTINGS.seed, maxOutputTokens: maxTokens, thinkingConfig: { thinkingLevel: COMPARISON_SETTINGS.reasoningEffort.toUpperCase(), includeThoughts: false },
        } }), signal: AbortSignal.timeout(120000) });
      if (!response.ok) { const error = new Error(`Gemini returned HTTP ${response.status}`); error.status = response.status; throw error; }
      const body = await response.json();
      text = (body.candidates?.[0]?.content?.parts ?? []).filter(part => !part.thought).map(part => part.text ?? '').join('');
      responseId = body.responseId; modelVersion = body.modelVersion ?? CLOUD_MODELS[cloudId];
      const usage = body.usageMetadata;
      tokens = { input: usage?.promptTokenCount, output: usage?.candidatesTokenCount,
        reasoning: usage?.thoughtsTokenCount ?? 0, total: usage?.totalTokenCount,cachedInput:usage?.cachedContentTokenCount??null };
    }
    // Meta output_tokens already includes reasoning; Google candidatesTokenCount does not.
    const usageKnown = validUsage(tokens.input, tokens.output, tokens.reasoning);
    const meteredUsd = usageKnown ? estimateCloudCost(cloudId, { inputTokens: tokens.input, outputTokens: tokens.output,
      reasoningTokens: cloudId === 'gemini' ? tokens.reasoning : 0 }, rates) : null;
    const budgetStatus = await budget.settle(requestId, { meteredUsd, providerReportedCostUsd, usageKnown });
    if (budgetStatus.overrun) { const error = new Error('Cloud usage exceeded its conservative reservation; halt the run'); error.code = 'CLOUD_BUDGET_EXHAUSTED'; throw error; }
    return { status: 'ok', text, cloudId, modelId: CLOUD_MODELS[cloudId], modelVersion, responseId, requestId,
      latencyMs: performance.now() - started, tokens, meteredCostUsd: meteredUsd, providerReportedCostUsd, budget: budgetStatus,
      settings: { ...COMPARISON_SETTINGS, maxTokens, seedSupported: cloudId === 'gemini',
        seedNote: cloudId === 'gemini' ? 'Requested via generationConfig.seed; determinism is not guaranteed' : 'Responses API has no seed parameter',
        sdkRetries: 0, pricingAssumptions: true,leanPayloadVersion:structured?.version??null,systemCaching:system?'Shared stable system prefix; provider automatic cache opportunities; no assumed discount':'Legacy unstructured input; no shared cache prefix'}, inputHash: estimate.inputHash };
  } catch (original) {
    await budget.markUnknown(requestId);
    // Do not echo provider response bodies, prompts, keys, or SDK request headers.
    const error = new Error(`Direct ${cloudId} request failed${Number.isInteger(original.status) ? ` (HTTP ${original.status})` : ''}; full attempt reservation retained`);
    error.code = original.code === 'CLOUD_BUDGET_EXHAUSTED' ? original.code : 'CLOUD_ATTEMPT_FAILED';
    error.status = Number.isInteger(original.status) ? original.status : undefined;
    throw error;
  }
}
