import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as sqliteVec from "sqlite-vec";

export const DEFAULT_DATA_DIR = path.resolve(".handoff");
const INDEX_FILE = "index.sqlite";

function vectorBytes(values) {
  if (!Array.isArray(values) || values.length === 0 || values.some(value => !Number.isFinite(value))) throw new Error("A finite embedding vector is required");
  const vector = new Float32Array(values);
  return new Uint8Array(vector.buffer);
}

export function assertEmbeddingCompatibility(indexed, query) {
  if (!indexed || !query || indexed.provider !== query.provider || indexed.model !== query.model || indexed.dimensions !== query.dimensions) {
    throw new Error("Embedding provider, model or dimensions differ from the local index. Re-ingest before switching embedding models");
  }
}

export class LocalVectorStore {
  constructor({ dataDir = DEFAULT_DATA_DIR } = {}) {
    this.dataDir = path.resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    this.database = new DatabaseSync(path.join(this.dataDir, INDEX_FILE), { allowExtension: true });
    try {
      sqliteVec.load(this.database);
      this.database.enableLoadExtension(false);
      this.database.exec(`
        PRAGMA journal_mode=WAL;
        PRAGMA busy_timeout=10000;
        CREATE TABLE IF NOT EXISTS index_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS chunks (
          chunk_id TEXT PRIMARY KEY,
          file TEXT NOT NULL,
          location TEXT NOT NULL,
          text TEXT NOT NULL,
          hash TEXT NOT NULL,
          pii_count INTEGER NOT NULL,
          embedding BLOB NOT NULL
        );
      `);
    } catch (error) { this.database.close(); throw error; }
  }

  close() { this.database.close(); }

  metadata() {
    return Object.fromEntries(this.database.prepare("SELECT key, value FROM index_metadata").all().map(row => [row.key, JSON.parse(row.value)]));
  }

  replaceChunks(chunks, embedding, metadata = {}) {
    if (!chunks.length || chunks.length !== embedding.vectors.length) throw new Error("Each indexed chunk needs one embedding");
    if (embedding.vectors.some(vector => vector.length !== embedding.dimensions)) throw new Error("Index embedding dimensions are inconsistent");
    const insert = this.database.prepare("INSERT INTO chunks (chunk_id,file,location,text,hash,pii_count,embedding) VALUES (?,?,?,?,?,?,?)");
    const putMetadata = this.database.prepare("INSERT INTO index_metadata (key,value) VALUES (?,?)");
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.exec("DELETE FROM chunks; DELETE FROM index_metadata;");
      chunks.forEach((chunk, index) => insert.run(chunk.chunkId, chunk.file, chunk.location, chunk.text, chunk.hash, chunk.piiCount ?? 0, vectorBytes(embedding.vectors[index])));
      const model = { provider: embedding.provider, model: embedding.model, dimensions: embedding.dimensions };
      for (const [key, value] of Object.entries({ schemaVersion: 1, ...metadata, embedding: model, chunks: chunks.length, indexedAt: new Date().toISOString() })) {
        putMetadata.run(key, JSON.stringify(value));
      }
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  search(vector, embedding, topK = 4) {
    const indexed = this.metadata().embedding;
    if (!indexed) throw new Error("No documents have been indexed. Run handoff ingest <folder> first");
    assertEmbeddingCompatibility(indexed, embedding);
    if (vector.length !== indexed.dimensions) throw new Error("Query vector dimensions differ from the index");
    const limit = Math.max(1, Math.min(20, Math.floor(topK)));
    const rows = this.database.prepare(`
      SELECT chunk_id, file, location, text, hash, pii_count,
        vec_distance_cosine(embedding, ?) AS distance
      FROM chunks ORDER BY distance ASC, chunk_id ASC LIMIT ?
    `).all(vectorBytes(vector), limit);
    return rows.map(row => ({
      chunkId: row.chunk_id, file: row.file, location: row.location, text: row.text,
      hash: row.hash, piiCount: Number(row.pii_count),
      score: Math.max(0, Math.min(1, 1 - Number(row.distance))),
    }));
  }
}

export function getIndexStatus({ dataDir = DEFAULT_DATA_DIR } = {}) {
  if (!existsSync(path.join(path.resolve(dataDir), INDEX_FILE))) return { ready: false, chunks: 0, files: 0, embeddingModel: null };
  const store = new LocalVectorStore({ dataDir });
  try {
    const metadata = store.metadata();
    return {
      ready: Boolean(metadata.embedding),
      chunks: Number(metadata.chunks ?? 0),
      files: Number(metadata.files ?? 0),
      embeddingModel: metadata.embedding ?? null,
      indexedAt: metadata.indexedAt ?? null,
      piiItemsRedacted: Number(metadata.piiItemsRedacted ?? 0),
      indexFingerprint: metadata.indexFingerprint ?? null,
      chunkSettings: metadata.chunkSettings ?? null,
    };
  } finally { store.close(); }
}
