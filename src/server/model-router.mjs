import OpenAI from "openai";
import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { performance } from "node:perf_hooks";
import { getModelApiKey, getOpenRouterApiKey } from "./env.mjs";

const ZERO_TOKENS = Object.freeze({ input: 0, output: 0, total: 0 });

export const MODEL_ROUTES = Object.freeze({
  meta: Object.freeze({
    baseURL: "https://api.meta.ai/v1",
    model: "muse-spark-1.3",
    getApiKey: getModelApiKey,
    pricePerMillionTokens: Object.freeze({ input: 0, output: 0 }),
  }),
  grok: Object.freeze({
    baseURL: "https://openrouter.ai/api/v1",
    model: "x-ai/grok-4.7",
    getApiKey: getOpenRouterApiKey,
    pricePerMillionTokens: Object.freeze({ input: 2, output: 6 }),
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

async function executeRoute(routeName, input, { log, stage } = {}) {
  const route = getRoute(routeName);
  const startedAt = performance.now();

  await log?.("request_started", route.model, { route: routeName, stage });

  try {
    const response = await getClient(route).responses.create({
      model: route.model,
      input,
    });
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

  return decision;
}

function firstResponderPrompt(task) {
  return [
    "You are the local first responder in a model handoff router.",
    "Return only valid JSON with this exact shape:",
    '{"decision":"answer|escalate","answer":"string","reason":"string"}',
    "Answer directly only for simple, low-risk tasks needing no specialist judgment.",
    "Escalate every multi-step planning, implementation, creative, uncertain, or specialist task.",
    "When escalating, set answer to an empty string.",
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
      { log, stage: "first_responder" },
    );
    decision = parseFirstResponderDecision(firstResult.outputText);
  } catch (error) {
    decision = {
      decision: "escalate",
      answer: "",
      reason: `Local first responder failed safely: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  await log("routing_decision", firstRoute.model, {
    stage: "first_responder",
    decision: decision.decision,
    reason: decision.reason,
    outputText: firstResult?.outputText ?? "",
    tokens: firstResult?.tokens ?? ZERO_TOKENS,
    latencyMs: firstResult?.latencyMs ?? 0,
    costEstimateUsd: firstResult?.costEstimateUsd ?? 0,
  });

  if (decision.decision === "answer" && decision.answer) {
    const latencyMs = round(performance.now() - runStartedAt, 2);

    await log("task_completed", firstRoute.model, {
      routeDecision: "answer",
      responder: "first_responder",
      outputText: decision.answer,
      tokens: firstResult.tokens,
      latencyMs,
      costEstimateUsd: firstResult.costEstimateUsd,
    });

    return {
      pairing: pairingName,
      handoffName: pairing.name,
      decision: "answer",
      firstResponderModelId: firstRoute.model,
      finalModelId: firstRoute.model,
      outputText: decision.answer,
      tokens: firstResult.tokens,
      latencyMs,
      costEstimateUsd: firstResult.costEstimateUsd,
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
