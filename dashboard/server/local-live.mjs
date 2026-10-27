import OpenAI from "openai";

const LOCAL_MODELS = {
  "meta-meta": "llama3.1:8b",
  "meta-grok": "llama3.1:8b",
  "gemma-meta": "gemma3:12b",
  "gemma-grok": "gemma3:12b",
};

const MAX_BODY_BYTES = 20_000;
const metaAccessStatus = process.env.META_ACCESS_STATUS === "live" ? "live" : "paused";

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(payload));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request is too large");
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function parseModelJson(text, fallback) {
  try {
    const match = text.match(/\{[\s\S]*\}/);
    return match ? { ...fallback, ...JSON.parse(match[0]) } : fallback;
  } catch {
    return fallback;
  }
}

function event(type, step, at, caption, actor, data = {}) {
  return { id: `${type}-${at}`, type, step, at, caption, actor, data };
}

function blockedEvents(reason, elapsedMs) {
  return [
    event("received", 1, 0, "The local model received the request", "local"),
    event("screened", 2, 420, "Guard is checking this is safe to share", "guard", { status: "checking" }),
    event("blocked", 2, Math.max(800, elapsedMs), "Guard kept this request on your device", "guard", { reason, route: "blocked_local" }),
    event("answered", 6, Math.max(1200, elapsedMs + 350), "A safe local response is ready", "local", {
      answer: "I cannot help with that request, but I can help with a safe alternative.",
      route: "blocked_local",
    }),
  ];
}

async function runLocalOnly(prompt, pairing) {
  const startedAt = performance.now();
  const model = LOCAL_MODELS[pairing];
  const client = new OpenAI({
    apiKey: "ollama-local",
    baseURL: process.env.OLLAMA_BASE_URL || "http://localhost:11434/v1",
  });

  const safetyResponse = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: "Classify whether the request is safe to process. Return only JSON: {\"classification\":\"safe|harmful\",\"confidence\":0.0,\"reason\":\"short reason\"}. Treat uncertainty as harmful.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0,
    max_tokens: 120,
  });

  const safety = parseModelJson(safetyResponse.choices[0]?.message?.content || "", {
    classification: "harmful",
    confidence: 0,
    reason: "Safety response could not be verified",
  });
  const safetyElapsed = Math.round(performance.now() - startedAt);
  if (safety.classification !== "safe" || Number(safety.confidence) < 0.8) {
    return {
      mode: "live-local-only",
      modelId: model,
      metaAccess: metaAccessStatus,
      events: blockedEvents(String(safety.reason), safetyElapsed),
    };
  }

  const answerStarted = performance.now();
  const answerResponse = await client.chat.completions.create({
    model,
    messages: [
      {
        role: "system",
        content: "Answer concisely, then assess whether a cloud model would be needed. Return only JSON: {\"decision\":\"answer|escalate\",\"confidence\":0.0,\"reason\":\"short reason\",\"answer\":\"concise answer\"}.",
      },
      { role: "user", content: prompt },
    ],
    temperature: 0.2,
    max_tokens: 300,
  });
  const result = parseModelJson(answerResponse.choices[0]?.message?.content || "", {
    decision: "answer",
    confidence: 0.5,
    reason: "Local result returned without route metadata",
    answer: answerResponse.choices[0]?.message?.content || "Local model completed the request.",
  });
  const answerElapsed = Math.round(performance.now() - answerStarted);
  const totalElapsed = Math.round(performance.now() - startedAt);
  const wantsCloud = result.decision === "escalate";
  const finalAnswer = wantsCloud
    ? metaAccessStatus === "paused"
      ? "This request would be handed off, but Meta access is paused. No cloud call was made."
      : "This dashboard live route is local-only. No cloud call was made."
    : String(result.answer);

  return {
    mode: "live-local-only",
    modelId: model,
    metaAccess: metaAccessStatus,
    events: [
      event("received", 1, 0, "The local model received the request", "local"),
      event("screened", 2, Math.max(350, safetyElapsed), "Guard approved local processing", "guard", { status: "safe", confidence: safety.confidence }),
      event("thinking", 3, Math.max(700, safetyElapsed + 250), "The local model is working", "local", { latencyMs: answerElapsed }),
      event("confidence", 4, Math.max(1100, totalElapsed - 180), "The local model checked its confidence", "local", { confidence: Number(result.confidence), reason: result.reason }),
      event("decision", 5, totalElapsed, wantsCloud ? "Cloud help is needed, but the live route stays local" : "Confidence is high enough to answer locally", "local", {
        route: wantsCloud ? "deferred_cloud" : "local",
        reason: result.reason,
      }),
      event("answered", 6, totalElapsed + 350, "The local-only run is complete", "local", { answer: finalAnswer, route: wantsCloud ? "deferred_cloud" : "local" }),
    ],
  };
}

export function createLocalLiveMiddleware() {
  return async function localLiveMiddleware(req, res, next) {
    if (req.url === "/api/status" && req.method === "GET") {
      sendJson(res, 200, { metaAccess: metaAccessStatus, liveMode: "local-only" });
      return;
    }

    if (req.url !== "/api/live-run") {
      next();
      return;
    }

    if (req.method !== "POST") {
      sendJson(res, 405, { error: "Method not allowed" });
      return;
    }

    try {
      const body = await readJsonBody(req);
      const prompt = typeof body.prompt === "string" ? body.prompt.trim() : "";
      const pairing = typeof body.pairing === "string" ? body.pairing : "";
      if (!prompt || prompt.length > 2_000 || !(pairing in LOCAL_MODELS)) {
        sendJson(res, 400, { error: "A valid prompt and pairing are required" });
        return;
      }
      sendJson(res, 200, await runLocalOnly(prompt, pairing));
    } catch (error) {
      sendJson(res, 503, { error: error instanceof Error ? error.message : "Local model is unavailable" });
    }
  };
}
