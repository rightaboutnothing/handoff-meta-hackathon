import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { listDocumentFiles } from '../rag/documents.mjs';
import { ingestFolder } from '../rag/ingest.mjs';
import { getIndexStatus, LocalVectorStore } from '../rag/store.mjs';
import { sha256 } from '../rag/receipts.mjs';

const embeddingModel = 'nomic-embed-text:v1.5';
async function optional(file) { try { return JSON.parse(await readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function contentsHash(dataDir) {
  const store = new LocalVectorStore({ dataDir });
  try { return sha256(store.database.prepare('SELECT chunk_id,file,location,text,hash,pii_count,hex(embedding) AS embedding FROM chunks ORDER BY chunk_id').all()); } finally { store.close(); }
}
export async function verifySyntheticSource(folder, expectedFiles, { list = listDocumentFiles } = {}) {
  if (!Array.isArray(expectedFiles) || !expectedFiles.length) throw new Error('Comparison requires a pinned synthetic corpus manifest');
  const actual = await list(folder), names = actual.files.map(file => file.file).sort();
  if (JSON.stringify(names) !== JSON.stringify(expectedFiles.map(file => file.file).sort())) throw new Error('Synthetic corpus file list differs from the pinned manifest');
  const buffers = new Map();
  for (const file of expectedFiles) {
    const resolved = path.resolve(folder, file.file);
    if (!resolved.startsWith(path.resolve(folder) + path.sep)) throw new Error('Synthetic corpus path escapes its folder');
    const bytes = await readFile(resolved);
    if (sha256(bytes) !== file.sha256) throw new Error('Synthetic corpus file hash differs from the pinned manifest');
    buffers.set(file.file, bytes);
  }
  return { buffers, corpusHash: sha256(expectedFiles.map(file => [file.file, file.sha256]).sort(([a], [b]) => a.localeCompare(b))) };
}
/** Paid tiers cannot retrieve a pre-existing real-company dashboard index. */
export async function ensureSyntheticCorpus({ root, manifest, directory, onEvent, dependencies = {} }) {
  if (manifest.companyCorpus?.synthetic !== true) throw new Error('Comparison accepts only the pinned synthetic company corpus');
  const source = path.join(root, 'demo_data'), snapshot = path.join(directory, 'source');
  const metadataFile = path.join(directory, 'corpus.json'), prior = await optional(metadataFile);
  const indexDirectory = prior?.indexDirectory ?? `index-${randomUUID()}`;
  if (!/^index-[a-zA-Z0-9-]+$/.test(indexDirectory)) throw new Error('Invalid isolated comparison index directory');
  const dataDir = path.join(directory, indexDirectory);
  const verified = await verifySyntheticSource(source, manifest.companyCorpus.files, dependencies);
  await mkdir(snapshot, { recursive: true });
  // Use the verified bytes, not a second source read, to prevent a source swap
  // between hashing and ingest. Existing snapshots must match, never overwrite.
  for (const [file, bytes] of verified.buffers) {
    const target = path.join(snapshot, file); await mkdir(path.dirname(target), { recursive: true });
    try { await writeFile(target, bytes, { flag: 'wx', mode: 0o600 }); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (sha256(await readFile(target)) !== sha256(bytes)) throw new Error('Frozen synthetic snapshot changed'); }
  }
  await verifySyntheticSource(snapshot, manifest.companyCorpus.files, dependencies);
  if (prior && prior.corpusHash !== verified.corpusHash) throw new Error('Comparison corpus changed since checkpoint');
  if (!prior) {
    // Incomplete builds receive a fresh generation, avoiding an ingest.lock
    // left by a crashed generation without deleting or trusting its contents.
    await (dependencies.ingest ?? ingestFolder)(snapshot, { dataDir, embeddingProvider: 'ollama', embeddingOptions: { model: embeddingModel }, onEvent });
  }
  const indexed = (dependencies.status ?? getIndexStatus)({ dataDir });
  if (!indexed.ready || indexed.embeddingModel?.provider !== 'ollama' || indexed.embeddingModel?.model !== embeddingModel) throw new Error('Comparison synthetic index must use the pinned local Ollama embedding model');
  const indexContentHash = await (dependencies.contentsHash ?? contentsHash)(dataDir);
  const record = { version: 'isolated-synthetic-index-v2', corpusHash: verified.corpusHash, indexDirectory, indexFingerprint: indexed.indexFingerprint, indexContentHash, embeddingModel: indexed.embeddingModel };
  if (prior && sha256(prior) !== sha256(record)) throw new Error('Comparison index changed since checkpoint');
  if (!prior) await writeFile(metadataFile, JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 });
  return { ...record, dataDir, snapshot, isolated: true };
}
