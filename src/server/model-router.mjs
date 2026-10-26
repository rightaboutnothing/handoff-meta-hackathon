import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { getModelApiKey, getOpenRouterApiKey } from "./env.mjs";

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, total: 0 });
export const LOCAL_ANSWER_CONFIDENCE_THRESHOLD = 0.8;
export const LOCAL_ROUTING_MAX_OUTPUT_TOKENS = 150;
export const CLOUD_REASONING_EFFORT = "medium";
export const HANDOFF_RUN_ORDER = Object.freeze([
  "meta-meta",
  "meta-grok",
  "gemma-meta",
  "gemma-grok",
]);
export const BENCHMARK_SETTINGS = Object.freeze({
  keepAlive: "-1",
  warmUp: "one empty Ollama generate call immediately before each local-model group; excluded from benchmark timings",
  runOrder: HANDOFF_RUN_ORDER,
  localRoutingMaxOutputTokens: LOCAL_ROUTING_MAX_OUTPUT_TOKENS,
  cloudReasoningEffort: CLOUD_REASONING_EFFORT,
});

export const MODEL_ROUTES = Object.freeze({
  meta: Object.freeze({
    baseURL: "https://api.meta.ai/v1",
    model: "muse-spark-1.3",
    getApiKey: getModelApiKey,
    pricePerMillionTokens: Object.freeze({ input: 0, output: 0 }),
    reasoningEffort: CLOUD_REASONING_EFFORT,
  }),
  grok: Object.freeze({
    baseURL: "https://openrouter.ai/api/v1",
    model: "x-ai/grok-4.7",
    getApiKey: getOpenRouterApiKey,
    pricePerMillionTokens: Object.freeze({ input: 2, output: 6 }),
    reasoningEffort: CLOUD_REASONING_EFFORT,
  }),
  gpt: Object.freeze({
    baseURL: "https://openrouter.ai/api/v1",
    model: "openai/gpt-6.1-sol",
    getApiKey: getOpenRouterApiKey,
    pricePerMillionTokens: Object.freeze({ input: 2, output: 10 }),
  }),
  llama: Object.freeze({
    baseURL: "http://localhost:11434/v1",
    model: "llama3.1:8b",
    getApiKey: () => "ollama",
    pricePerMillionTokens: Object.freeze({ input: 0, output: 0 }),
  }),
  gemma: Object.freeze({
    baseURL: "http://localhost:11434/v1",
    model: "gemma3:12b",
    getApiKey: () => "ollama",
    pricePerMillionTokens: Object.freeze({ input: 0, output: 0 }),
  }),
});

export const HANDOFF_PAIRINGS = Object.freeze({
  "meta-meta": Object.freeze({
    name: "Finkd",
    firstResponderRoute: "llama",
    escalationRoute: "meta",
  }),
  "meta-grok": Object.freeze({
    name: "Llamarok",
    firstResponderRoute: "llama",
    escalationRoute: "grok",
  }),
  "gemma-meta": Object.freeze({
    name: "Gemmuse",
    firstResponderRoute: "gemma",
    escalationRoute: "meta",
  }),
  "gemma-grok": Object.freeze({
    name: "Gemmok",
    firstResponderRoute: "gemma",
    escalationRoute: "grok",
  }),
});

const clients = new Map();

function getRoute(routeName) {
  const route = MODEL_ROUTES[routeName];

  if (!route) {
    throw new Error(`Unknown model route: ${routeName}`);
  }

  return route;
}

function getPairing(pairingName) {
  const pairing = HANDOFF_PAIRINGS[pairingName];

  if (!pairing) {
    throw new Error(`Unknown handoff pairing: ${pairingName}`);
  }

  return pairing;
}

function getClient(route) {
  const clientKey = route.baseURL;

  if (!clients.has(clientKey)) {
    clients.set(
      clientKey,
      new OpenAI({ baseURL: route.baseURL, apiKey: route.getApiKey() }),
    );
  }

  return clients.get(clientKey);
}

function round(value, places = 6) {
  return Number(value.toFixed(places));
}

function tokenMetrics(usage) {
  const input = Number(usage?.input_tokens ?? usage?.prompt_tokens ?? 0);
  const output = Number(
    usage?.output_tokens ?? usage?.completion_tokens ?? 0,
  );

  return { input, output, total: Number(usage?.total_tokens ?? input + output) };
}

function estimateCost(tokens, prices) {
  return round(
    (tokens.input * prices.input + tokens.output * prices.output) / 1_000_000,
    8,
  );
}

function addTokens(left, right) {
  return {
    input: left.input + right.input,
    output: left.output + right.output,
    total: left.total + right.total,
  };
}

export function createJsonlLogger(
  logPath,
  { pairing, handoffName, runId = randomUUID() },
) {
  return async function log(event, modelId, details = {}) {
    if (!modelId) {
      throw new Error("Every router log entry must include a modelId");
    }

    const {
      tokens = ZERO_TOKENS,
      latencyMs = 0,
      costEstimateUsd = 0,
      ...eventDetails
    } = details;
    const entry = {
      timestamp: new Date().toISOString(),
      runId,
      pairing,
      handoffName,
      event,
      modelId,
      keepAlive: BENCHMARK_SETTINGS.keepAlive,
      warmUp: BENCHMARK_SETTINGS.warmUp,
      runOrder: BENCHMARK_SETTINGS.runOrder,
      localRoutingMaxOutputTokens:
        BENCHMARK_SETTINGS.localRoutingMaxOutputTokens,
      cloudReasoningEffort: BENCHMARK_SETTINGS.cloudReasoningEffort,
      ...eventDetails,
      tokens,
      latencyMs,
      costEstimateUsd,
    };

    await mkdir(dirname(logPath), { recursive: true });
    await appendFile(logPath, `${JSON.stringify(entry)}\n`, "utf8");

    return entry;
  };
}

async function executeRoute(
  routeName,
  input,
  { log, stage, maxOutputTokens } = {},
) {
  const route = getRoute(routeName);
  const startedAt = performance.now();

  await log?.("request_started", route.model, { route: routeName, stage });

  try {
    const request = {
      model: route.model,
      input,
    };

    if (maxOutputTokens) {
      request.max_output_tokens = maxOutputTokens;
    }

    if (route.reasoningEffort) {
      request.reasoning = { effort: route.reasoningEffort };
    }

    const response = await getClient(route).responses.create(request);
    const tokens = tokenMetrics(response.usage);
    const latencyMs = round(performance.now() - startedAt, 2);
    const costEstimateUsd = estimateCost(
      tokens,
      route.pricePerMillionTokens,
    );
    const result = {
      modelId: route.model,
      responseModelId: response.model ?? route.model,
      outputText: response.output_text,
      tokens,
      latencyMs,
      costEstimateUsd,
    };

    await log?.("response_completed", route.model, {
      route: routeName,
      stage,
      ...result,
    });

    return result;
  } catch (error) {
    await log?.("request_failed", route.model, {
      route: routeName,
      stage,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: round(performance.now() - startedAt, 2),
    });

    throw error;
  }
}

export async function warmUpLocalRoute(routeName, { logPath, pairings }) {
  const route = getRoute(routeName);

  if (route.baseURL !== "http://localhost:11434/v1") {
    throw new Error(`Warm-up route must be local: ${routeName}`);
  }

  const log = createJsonlLogger(logPath, {
    pairing: `warmup-${routeName}`,
    handoffName: `${route.model} warm-up`,
  });
  const startedAt = performance.now();

  await log("warmup_started", route.model, {
    stage: "warmup",
    excludedFromBenchmark: true,
    appliesToPairings: pairings,
  });

  try {
    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: route.model,
        prompt: "",
        stream: false,
        keep_alive: -1,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama warm-up failed with HTTP ${response.status}`);
    }

    const result = await response.json();
    const tokens = {
      input: Number(result.prompt_eval_count ?? 0),
      output: Number(result.eval_count ?? 0),
      total: Number(result.prompt_eval_count ?? 0) + Number(result.eval_count ?? 0),
    };
    const latencyMs = round(performance.now() - startedAt, 2);

    await log("warmup_completed", route.model, {
      stage: "warmup",
      excludedFromBenchmark: true,
      appliesToPairings: pairings,
      outputText: result.response ?? "",
      loadLatencyMs: round(Number(result.load_duration ?? 0) / 1_000_000, 2),
      tokens,
      latencyMs,
    });

    return { modelId: route.model, tokens, latencyMs };
  } catch (error) {
    await log("warmup_failed", route.model, {
      stage: "warmup",
      excludedFromBenchmark: true,
      appliesToPairings: pairings,
      error: error instanceof Error ? error.message : String(error),
      latencyMs: round(performance.now() - startedAt, 2),
    });

    throw error;
  }
}

export async function routeText(routeName, input) {
  return (await executeRoute(routeName, input)).outputText;
}

// App AI features use the mandatory Meta route by default.
export function generateText(input) {
  return routeText("meta", input);
}

function parseFirstResponderDecision(outputText) {
  const jsonText = outputText
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/, "");
  const decision = JSON.parse(jsonText);

  if (decision.decision !== "answer" && decision.decision !== "escalate") {
    throw new Error("First responder returned an invalid decision");
  }

  decision.confidence = Number(decision.confidence);

  if (
    !Number.isFinite(decision.confidence) ||
    decision.confidence < 0 ||
    decision.confidence > 1
  ) {
    throw new Error("First responder returned an invalid confidence score");
  }

  if (typeof decision.reason !== "string") {
    throw new Error("First responder returned an invalid reason");
  }

  return decision;
}

function enforceConfidenceThreshold(decision) {
  if (
    decision.decision === "answer" &&
    decision.confidence < LOCAL_ANSWER_CONFIDENCE_THRESHOLD
  ) {
    return {
      ...decision,
      decision: "escalate",
      reason: `Local answer confidence ${decision.confidence} is below the ${LOCAL_ANSWER_CONFIDENCE_THRESHOLD} threshold. ${decision.reason}`,
    };
  }

  return decision;
}

function firstResponderPrompt(task) {
  return [
    "You are the local first responder in a model handoff router.",
    "Return only valid JSON with this exact shape:",
    '{"decision":"answer|escalate","confidence":0.0,"reason":"string"}',
    "Confidence is a number from 0 to 1 measuring how confident you are that your local answer is correct and complete.",
    `Choose answer when confidence is at least ${LOCAL_ANSWER_CONFIDENCE_THRESHOLD} and the task is directly solvable locally.`,
    "Simple greetings, basic arithmetic, definitions, short rewrites, and straightforward factual questions should normally be answered locally.",
    "Escalate only when the task is hard, high-stakes, requires deep multi-step or specialist reasoning, needs missing/current external information or tools, or your confidence is below the threshold.",
    "Do not escalate a task merely because it involves light writing, creativity, or code if it is otherwise straightforward.",
    "Do not answer the task in this routing response; return only the three JSON fields.",
    `Task: ${task}`,
  ].join("\n");
}

export async function runHandoff(pairingName, task, { logPath }) {
  const pairing = getPairing(pairingName);
  const firstRoute = getRoute(pairing.firstResponderRoute);
  const escalationRoute = getRoute(pairing.escalationRoute);
  const log = createJsonlLogger(logPath, {
    pairing: pairingName,
    handoffName: pairing.name,
  });
  const runStartedAt = performance.now();
  let firstResult;
  let decision;

  try {
    firstResult = await executeRoute(
      pairing.firstResponderRoute,
      firstResponderPrompt(task),
      {
        log,
        stage: "first_responder",
        maxOutputTokens: LOCAL_ROUTING_MAX_OUTPUT_TOKENS,
      },
    );
    decision = enforceConfidenceThreshold(
      parseFirstResponderDecision(firstResult.outputText),
    );
  } catch (error) {
    decision = {
      decision: "escalate",
      confidence: 0,
      reason: `Local first responder failed safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  await log("routing_decision", firstRoute.model, {
    stage: "first_responder",
    decision: decision.decision,
    confidence: decision.confidence,
    reason: decision.reason,
    outputText: firstResult?.outputText ?? "",
    tokens: firstResult?.tokens ?? ZERO_TOKENS,
    latencyMs: firstResult?.latencyMs ?? 0,
    costEstimateUsd: firstResult?.costEstimateUsd ?? 0,
  });

  if (decision.decision === "answer") {
    const answerResult = await executeRoute(
      pairing.firstResponderRoute,
      task,
      { log, stage: "local_answer" },
    );
    const tokens = addTokens(firstResult.tokens, answerResult.tokens);
    const latencyMs = round(performance.now() - runStartedAt, 2);
    const costEstimateUsd = round(
      firstResult.costEstimateUsd + answerResult.costEstimateUsd,
      8,
    );

    await log("task_completed", firstRoute.model, {
      routeDecision: "answer",
      routingConfidence: decision.confidence,
      responder: "first_responder",
      outputText: answerResult.outputText,
      tokens,
      latencyMs,
      costEstimateUsd,
    });

    return {
      pairing: pairingName,
      handoffName: pairing.name,
      decision: "answer",
      confidence: decision.confidence,
      firstResponderModelId: firstRoute.model,
      finalModelId: firstRoute.model,
      outputText: answerResult.outputText,
      tokens,
      latencyMs,
      costEstimateUsd,
      logPath,
    };
  }

  const escalationResult = await executeRoute(
    pairing.escalationRoute,
    task,
    { log, stage: "escalation" },
  );
  const tokens = addTokens(
    firstResult?.tokens ?? ZERO_TOKENS,
    escalationResult.tokens,
  );
  const latencyMs = round(performance.now() - runStartedAt, 2);
  const costEstimateUsd = round(
    (firstResult?.costEstimateUsd ?? 0) + escalationResult.costEstimateUsd,
    8,
  );

  await log("task_completed", escalationRoute.model, {
    routeDecision: "escalate",
    routingConfidence: decision.confidence,
    responder: "escalation",
    firstResponderModelId: firstRoute.model,
    outputText: escalationResult.outputText,
    tokens,
    latencyMs,
    costEstimateUsd,
  });

  return {
    pairing: pairingName,
    handoffName: pairing.name,
    decision: "escalate",
    confidence: decision.confidence,
    firstResponderModelId: firstRoute.model,
    finalModelId: escalationRoute.model,
    outputText: escalationResult.outputText,
    tokens,
    latencyMs,
    costEstimateUsd,
    logPath,
  };
}

export function runFirstResponderTask(task, { logPath }) {
  return runHandoff("meta-meta", task, { logPath });
}
