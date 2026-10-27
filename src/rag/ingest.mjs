import { mkdir, open, unlink } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { CHUNK_SETTINGS, chunkText, extractDocument, listDocumentFiles, sha256, stableChunkId } from "./documents.mjs";
import { embedTexts } from "./embeddings.mjs";
import { DEFAULT_DATA_DIR, getIndexStatus, LocalVectorStore } from "./store.mjs";
import { createPrivacyVault } from "./privacy.mjs";

export { getIndexStatus };

export async function ingestFolder(folder, {
  dataDir = DEFAULT_DATA_DIR, onEvent, embeddingProvider = "auto", embeddingOptions = {},
} = {}) {
  const startedAt = performance.now();
  const resolvedDataDir = path.resolve(dataDir);
  await mkdir(resolvedDataDir, { recursive: true, mode: 0o700 });
  const lockPath = path.join(resolvedDataDir, "ingest.lock");
  let lock;
  try { lock = await open(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error("An ingest is already running. If a prior ingest crashed, remove only its local ingest.lock before retrying");
    throw error;
  }
  try {
    const documents = await listDocumentFiles(path.resolve(folder));
    if (!documents.files.length) throw new Error("The folder contains no supported documents");
    const vault = await createPrivacyVault(resolvedDataDir);
    const chunks = [];
    const redactedUnits = [];
    let piiItemsRedacted = 0;
    await onEvent?.({ type: "ingest_started", files: documents.files.length });
    for (const document of documents.files) {
      const units = await extractDocument(document.absolutePath);
      for (const unit of units) {
        const redacted = vault.redact(unit.text);
        piiItemsRedacted += redacted.count;
        redactedUnits.push({ file: document.file, location: unit.location, text: redacted.text });
      }
    }
    // Finish discovering labeled names in every file before the embedding pass.
    // A later labeled mention can identify an earlier unlabeled occurrence.
    for (const unit of redactedUnits) {
      const redacted = vault.redact(unit.text);
      piiItemsRedacted += redacted.count;
      if (vault.findResidualPii(redacted.text).length) throw new Error("Recognized private data remained after local ingest redaction");
      const pieces = chunkText(redacted.text);
      pieces.forEach((text, index) => {
        const piiCount = typeof vault.placeholderCount === "function"
          ? vault.placeholderCount(text)
          : (text.match(/\[\[PII_[A-Z]+_[a-f0-9]+\]\]/g) || []).length;
        chunks.push({
          chunkId: stableChunkId(unit.file, unit.location, index),
          file: unit.file, location: unit.location, text, hash: sha256(text), piiCount,
        });
      });
    }
    if (!chunks.length) throw new Error("The supported documents contain no extractable text. Scanned PDF images require local OCR before ingest");
    await onEvent?.({ type: "embedding", chunks: chunks.length, provider: embeddingProvider });
    const embedding = await embedTexts(chunks.map(chunk => chunk.text), { ...embeddingOptions, provider: embeddingProvider, kind: "document" });
    // Save the reversible local mapping before atomically replacing the index.
    await vault.save();
    const store = new LocalVectorStore({ dataDir: resolvedDataDir });
    const indexFingerprint = sha256(JSON.stringify(chunks.map(chunk => [chunk.chunkId, chunk.hash])));
    try {
      store.replaceChunks(chunks, embedding, {
        files: documents.files.length, piiItemsRedacted, chunkSettings: CHUNK_SETTINGS, indexFingerprint,
      });
    } finally { store.close(); }
    const result = {
      ...getIndexStatus({ dataDir: resolvedDataDir }),
      latencyMs: Math.round(performance.now() - startedAt),
      fallbackReason: embedding.fallbackReason ?? null,
    };
    await onEvent?.({ type: "ingest_completed", ...result });
    return result;
  } finally {
    await lock.close();
    await unlink(lockPath).catch(() => undefined);
  }
}

export async function retrieve(question, {
  dataDir = DEFAULT_DATA_DIR, topK = 4, vault, embeddingOptions = {},
} = {}) {
  const startedAt = performance.now();
  const resolvedDataDir = path.resolve(dataDir);
  const status = getIndexStatus({ dataDir: resolvedDataDir });
  if (!status.ready) throw new Error("No documents have been indexed. Run handoff ingest <folder> first");
  const privacy = vault || await createPrivacyVault(resolvedDataDir);
  const redacted = privacy.redact(String(question));
  await privacy.save();
  const indexed = status.embeddingModel;
  const embedding = await embedTexts([redacted.text], {
    ...embeddingOptions, kind: "query", provider: indexed.provider, model: indexed.model,
  });
  const store = new LocalVectorStore({ dataDir: resolvedDataDir });
  let chunks;
  try { chunks = store.search(embedding.vectors[0], embedding, topK); }
  finally { store.close(); }
  return {
    chunks, quality: chunks[0]?.score ?? 0,
    embeddingModel: { provider: embedding.provider, model: embedding.model, dimensions: embedding.dimensions },
    redactedQuestion: redacted.text, piiItemsRedacted: redacted.count,
    latencyMs: Math.round(performance.now() - startedAt),
  };
}
