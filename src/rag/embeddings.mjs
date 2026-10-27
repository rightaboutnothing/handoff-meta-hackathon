import path from "node:path";

export const OLLAMA_EMBEDDING_MODEL = "nomic-embed-text:v1.5";
export const FALLBACK_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const extractors = new Map();

function localOllamaOrigin() {
  const address = new URL(process.env.OLLAMA_BASE_URL || "http://127.0.0.1:11434");
  if (!["localhost", "127.0.0.1", "[::1]"].includes(address.hostname) || address.protocol !== "http:" || address.username || address.password) {
    throw new Error("Embeddings require a loopback Ollama URL");
  }
  return address.origin;
}

export function normalizeVector(vector) {
  const values = Array.from(vector, Number);
  if (!values.length || values.some(value => !Number.isFinite(value))) throw new Error("Embedding is not a finite vector");
  const length = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0));
  if (length === 0) throw new Error("Embedding has zero length");
  return values.map(value => value / length);
}

async function embedOllama(texts, { kind, model, fetchImpl, timeoutMs }) {
  const vectors = [];
  for (let offset = 0; offset < texts.length; offset += 16) {
    const batch = texts.slice(offset, offset + 16).map(text => `${kind === "query" ? "search_query" : "search_document"}: ${text}`);
    const response = await fetchImpl(`${localOllamaOrigin()}/api/embed`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, input: batch, keep_alive: -1, truncate: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) throw new Error(`Local Ollama embedding request failed with HTTP ${response.status}`);
    const result = await response.json();
    if (!Array.isArray(result.embeddings) || result.embeddings.length !== batch.length) throw new Error("Local Ollama returned an incomplete embedding batch");
    vectors.push(...result.embeddings.map(normalizeVector));
  }
  return vectors;
}

async function embedSentenceTransformer(texts, { model, cacheDir, extractorFactory }) {
  const key = `${model}|${cacheDir}`;
  if (!extractors.has(key)) {
    extractors.set(key, (async () => {
      if (extractorFactory) return extractorFactory(model);
      const { env, pipeline } = await import("@huggingface/transformers");
      env.cacheDir = cacheDir;
      env.allowLocalModels = true;
      env.allowRemoteModels = process.env.HANDOFF_ALLOW_MODEL_DOWNLOADS !== "false";
      // Model weights may be downloaded once. Document and question inference stays local.
      return pipeline("feature-extraction", model, { dtype: "q8", device: "cpu" });
    })().catch(error => { extractors.delete(key); throw error; }));
  }
  const extractor = await extractors.get(key);
  const vectors = [];
  for (let offset = 0; offset < texts.length; offset += 16) {
    const result = await extractor(texts.slice(offset, offset + 16), { pooling: "mean", normalize: true });
    vectors.push(...result.tolist().map(normalizeVector));
  }
  return vectors;
}

export async function embedTexts(texts, {
  kind = "document", provider = "auto", model,
  cacheDir = path.resolve(".cache", "sentence-transformers"), fetchImpl = globalThis.fetch,
  extractorFactory, timeoutMs = 120_000,
} = {}) {
  if (!Array.isArray(texts) || !texts.length || texts.some(text => typeof text !== "string" || !text.trim())) throw new Error("Embeddings require nonempty text inputs");
  if (!["auto", "ollama", "sentence-transformers"].includes(provider)) throw new Error("Unknown local embedding provider");
  let vectors;
  let chosen = provider;
  let chosenModel = model;
  let fallbackReason;
  if (provider !== "sentence-transformers") {
    try {
      chosen = "ollama";
      chosenModel = model || OLLAMA_EMBEDDING_MODEL;
      vectors = await embedOllama(texts, { kind, model: chosenModel, fetchImpl, timeoutMs });
    } catch (error) {
      if (provider === "ollama") throw new Error("The indexed Ollama embedding model is unavailable. Restore it or re-ingest the folder with sentence-transformers; mixed embedding spaces are not allowed", { cause: error });
      fallbackReason = "Ollama embeddings unavailable; all chunks embedded with the local fallback";
    }
  }
  if (!vectors) {
    chosen = "sentence-transformers";
    chosenModel = provider === "sentence-transformers" && model ? model : FALLBACK_EMBEDDING_MODEL;
    vectors = await embedSentenceTransformer(texts, { model: chosenModel, cacheDir, extractorFactory });
  }
  const dimensions = vectors[0].length;
  if (vectors.length !== texts.length || vectors.some(vector => vector.length !== dimensions)) throw new Error("Embedding dimensions are inconsistent");
  return { vectors, provider: chosen, model: chosenModel, dimensions, fallbackReason };
}
