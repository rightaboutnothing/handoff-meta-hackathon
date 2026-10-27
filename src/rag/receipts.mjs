import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

function normalized(value, ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Receipt numbers must be finite"); return value; }
  if (value === undefined) return undefined;
  if (typeof value !== "object" || ancestors.has(value)) throw new Error("Receipt payload must be acyclic JSON data");
  ancestors.add(value);
  let result;
  if (Array.isArray(value)) result = value.map(item => normalized(item, ancestors) ?? null);
  else {
    result = Object.create(null);
    for (const key of Object.keys(value).sort()) {
      const item = normalized(value[key], ancestors);
      if (item !== undefined) result[key] = item;
    }
  }
  ancestors.delete(value);
  return result;
}

export function canonicalJSON(value) {
  const serialized = JSON.stringify(normalized(value));
  if (serialized === undefined) throw new Error("Receipt payload must be JSON data");
  return serialized;
}

export function sha256(value) {
  return createHash("sha256").update(typeof value === "string" || Buffer.isBuffer(value) || value instanceof Uint8Array ? value : canonicalJSON(value)).digest("hex");
}

const fingerprintOf = publicKey => sha256(createPublicKey(publicKey).export({ type: "spki", format: "der" }));

async function signingKeys(dataDir) {
  if (!dataDir) throw new Error("A local data directory is required for receipt signing");
  const directory = path.join(path.resolve(dataDir), "keys");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privatePath = path.join(directory, "receipt-private.pem");
  const publicPath = path.join(directory, "receipt-public.pem");
  let privatePem;
  try { privatePem = await readFile(privatePath, "utf8"); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const pair = generateKeyPairSync("ed25519");
    const created = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    try { await writeFile(privatePath, created, { mode: 0o600, flag: "wx" }); privatePem = created; }
    catch (writeError) { if (writeError.code !== "EEXIST") throw writeError; privatePem = await readFile(privatePath, "utf8"); }
  }
  const privateKey = createPrivateKey(privatePem);
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Receipt signing key must be Ed25519");
  const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
  try {
    const pinned = await readFile(publicPath, "utf8");
    if (fingerprintOf(pinned) !== fingerprintOf(publicPem)) throw new Error("Local receipt trust anchor does not match the signing key");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    try { await writeFile(publicPath, publicPem, { mode: 0o600, flag: "wx" }); }
    catch (writeError) {
      if (writeError.code !== "EEXIST") throw writeError;
      if (fingerprintOf(await readFile(publicPath, "utf8")) !== fingerprintOf(publicPem)) throw new Error("Local receipt trust anchor does not match the signing key");
    }
  }
  return { privateKey, publicPem };
}

export async function signReceipt(payload, { dataDir } = {}) {
  const { privateKey, publicPem } = await signingKeys(dataDir);
  const canonical = canonicalJSON(payload);
  return {
    payload: JSON.parse(canonical),
    signature: sign(null, Buffer.from(canonical), privateKey).toString("base64url"),
    publicKey: publicPem,
    fingerprint: fingerprintOf(publicPem),
    algorithm: "Ed25519",
  };
}

export async function verifyReceipt(receipt, { dataDir } = {}) {
  try {
    if (!dataDir || receipt?.algorithm !== "Ed25519" || typeof receipt.signature !== "string" || typeof receipt.publicKey !== "string") return false;
    // The embedded public key is an artifact for auditors, not its own trust anchor.
    const pinned = await readFile(path.join(path.resolve(dataDir), "keys", "receipt-public.pem"), "utf8");
    const fingerprint = fingerprintOf(pinned);
    if (receipt.fingerprint !== fingerprint || fingerprintOf(receipt.publicKey) !== fingerprint) return false;
    const signature = Buffer.from(receipt.signature, "base64url");
    if (signature.length !== 64) return false;
    return verify(null, Buffer.from(canonicalJSON(receipt.payload)), createPublicKey(pinned), signature);
  } catch { return false; }
}

const emptyHash = "0".repeat(64);
const withoutChain = receipt => { const { chain, ...base } = receipt; return base; };
const sameJson = (a, b) => { try { return canonicalJSON(a) === canonicalJSON(b); } catch { return false; } };
const safeRunId = runId => { if (typeof runId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,100}$/.test(runId)) throw new Error("A safe receipt run ID is required"); return runId; };
async function optionalJson(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch (error) { if (error.code === "ENOENT") return null; throw error; } }
async function durableWrite(file, text) { const handle = await open(file, "w", 0o600); try { await handle.writeFile(text, "utf8"); await handle.sync(); } finally { await handle.close(); } }
async function atomicJson(file, value) { const temporary = `${file}.${process.pid}.tmp`; await durableWrite(temporary, JSON.stringify(value) + "\n"); await rename(temporary, file); }
async function lockLedger(directory) {
  const file = path.join(directory, "receipts.lock");
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try { const handle = await open(file, "wx", 0o600); await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })); return async () => { await handle.close(); await unlink(file).catch(() => undefined); }; }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      try {
        const contents = await readFile(file, "utf8"), owner = JSON.parse(contents);
        if (Number.isInteger(owner.pid) && owner.pid > 0) {
          try { process.kill(owner.pid, 0); }
          catch (aliveError) { if (aliveError.code === "ESRCH" && await readFile(file, "utf8") === contents) { await unlink(file); continue; } }
        }
      } catch { /* A current writer may still be creating its lock record. */ }
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error("The receipt ledger is busy; retry after the current append finishes");
}

export async function recordOutboundPayload({ runId, input, outbound }, { dataDir } = {}) {
  safeRunId(runId);
  if (typeof input !== "string" || !outbound || !Array.isArray(outbound.chunks)) throw new Error("An exact outbound payload is required");
  const record = { version: 1, runId, input, outbound, inputHash: sha256(input) };
  for (const chunk of outbound.chunks) if (typeof chunk.text !== "string" || chunk.hash !== sha256(chunk.text)) throw new Error("Outbound chunk hash mismatch");
  const directory = path.join(path.resolve(dataDir), "payloads");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, `${runId}.json`);
  try { const handle = await open(file, "wx", 0o600); try { await handle.writeFile(canonicalJSON(record) + "\n"); await handle.sync(); } finally { await handle.close(); } }
  catch (error) { if (error.code !== "EEXIST") throw error; if (canonicalJSON(await optionalJson(file)) !== canonicalJSON(record)) throw new Error("An outbound run cannot be overwritten with different content"); }
  return { runId, inputHash: record.inputHash, snapshotHash: sha256(record) };
}

export async function readOutboundPayload(runId, { dataDir } = {}) {
  safeRunId(runId);
  return optionalJson(path.join(path.resolve(dataDir), "payloads", `${runId}.json`));
}

export async function verifyReceiptPayload(receipt, { dataDir } = {}) {
  if (!receipt.payload?.inputHash || !receipt.payload?.runId) return { available: false, verified: false, reason: "Receipt has no outbound input identity" };
  const snapshot = await readOutboundPayload(receipt.payload.runId, { dataDir });
  if (!snapshot) return { available: false, verified: false, reason: "Historical receipt has no retained payload snapshot" };
  const chunks = snapshot.outbound?.chunks;
  const expected = receipt.payload.chunks ?? [];
  const verified = snapshot.runId === receipt.payload.runId && snapshot.inputHash === sha256(snapshot.input) && snapshot.inputHash === receipt.payload.inputHash
    && Array.isArray(chunks) && chunks.length === expected.length && chunks.every((chunk, index) => chunk.id === expected[index].chunkId && chunk.hash === sha256(chunk.text) && chunk.hash === expected[index].hash);
  return { available: true, verified, snapshotHash: sha256(snapshot), reason: verified ? "Exact redacted input and chunk hashes match" : "Retained payload differs from the signed receipt" };
}

async function inspectLedger(directory, { verifyPayloads = true, requireHead = true } = {}) {
  let text;
  try { text = await readFile(path.join(directory, "receipts.jsonl"), "utf8"); } catch (error) { if (error.code === "ENOENT") text = ""; else throw error; }
  const lines = text.split("\n").filter(Boolean), entries = [], breaks = [], details = [];
  let previousEntryHash = emptyHash, legacyUnchained = 0, chained = 0, verifiedSignatures = 0, payloadsVerified = 0, payloadsMissing = 0;
  if (text && !text.endsWith("\n")) breaks.push({ code: "incomplete_tail", sequence: lines.length });
  for (const [index, line] of lines.entries()) {
    let entry;
    try { entry = JSON.parse(line); } catch { breaks.push({ code: "invalid_json", sequence: index + 1 }); break; }
    entries.push(entry);
    const receipt = withoutChain(entry), receiptHash = sha256(receipt), sequence = index + 1;
    const signatureValid = await verifyReceipt(receipt, { dataDir: directory });
    if (signatureValid) verifiedSignatures += 1; else breaks.push({ code: "invalid_receipt_signature", sequence });
    let payload;
    if (verifyPayloads) {
      try { payload = await verifyReceiptPayload(receipt, { dataDir: directory }); }
      catch { payload = { available: true, verified: false, reason: "Payload snapshot is unreadable" }; }
      if (payload.available && payload.verified) payloadsVerified += 1;
      else if (payload.available) breaks.push({ code: "payload_hash_mismatch", sequence });
      else if (receipt.payload?.inputHash) payloadsMissing += 1;
    }
    if (entry.chain) {
      chained += 1;
      const chain = entry.chain;
      const metadata = { kind: "receipt-chain-entry-v1", version: 1, sequence, previousEntryHash, receiptHash, snapshotHash: chain.snapshotHash ?? null };
      if (chain.sequence !== sequence || chain.previousEntryHash !== previousEntryHash || chain.receiptHash !== receiptHash || !sameJson(chain.attestation?.payload, metadata) || !await verifyReceipt(chain.attestation, { dataDir: directory })) breaks.push({ code: "chain_link_or_attestation_invalid", sequence });
      if (chain.snapshotHash && verifyPayloads && (!payload?.available || !payload.verified || payload.snapshotHash !== chain.snapshotHash)) breaks.push({ code: "bound_snapshot_invalid", sequence });
      const entryHash = sha256({ metadata, signature: chain.attestation?.signature });
      if (chain.entryHash !== entryHash) breaks.push({ code: "entry_hash_invalid", sequence });
      previousEntryHash = entryHash;
    } else {
      legacyUnchained += 1;
      previousEntryHash = sha256({ sequence, previousEntryHash, receiptHash });
    }
    details.push({ sequence, runId: receipt.payload?.runId ?? null, timestamp: receipt.payload?.timestamp ?? null, status: receipt.payload?.status ?? null, modelId: receipt.payload?.modelId ?? null, signatureVerified: signatureValid, chained: !!entry.chain, payloadVerified: payload?.verified ?? null, inputHash: receipt.payload?.inputHash ?? null, chunkCount: receipt.payload?.chunks?.length ?? 0, actualChunksSent: receipt.payload?.actualChunksSent ?? null, guardOutbound: receipt.payload?.guardOutbound ?? null, guardInbound: receipt.payload?.guardInbound ?? null, entryHash: previousEntryHash });
  }
  let head;
  try { head = await optionalJson(path.join(directory, "receipt-head.json")); } catch { breaks.push({ code: "head_unreadable", sequence: entries.length }); }
  const expectedHead = { kind: "receipt-chain-head-v1", version: 1, count: entries.length, lastEntryHash: previousEntryHash, legacyUnchained };
  const headVerified = !!head && await verifyReceipt(head, { dataDir: directory }) && sameJson(head.payload, expectedHead);
  if (requireHead && (head || chained) && !headVerified) breaks.push({ code: "head_mismatch_or_truncation", sequence: entries.length });
  return { valid: breaks.length === 0, total: entries.length, verifiedSignatures, chained, legacyUnchained, legacyPrefixAnchored: legacyUnchained > 0 && chained > 0 && headVerified, payloadsVerified, payloadsMissing, headVerified, lastEntryHash: previousEntryHash, breaks, details, entries, expectedHead };
}

async function recoverPending(directory) {
  const pendingFile = path.join(directory, "receipt-pending.json"), pending = await optionalJson(pendingFile);
  if (!pending) return;
  if (!await verifyReceipt(pending.head, { dataDir: directory }) || sha256(pending.line) !== pending.lineHash) throw new Error("Receipt recovery journal failed verification");
  const ledger = path.join(directory, "receipts.jsonl");
  let text = ""; try { text = await readFile(ledger, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const expectedLine = pending.line + "\n", complete = text.endsWith("\n") || !text;
  const prefix = complete ? text : text.slice(0, text.lastIndexOf("\n") + 1);
  const prefixLines = prefix.split("\n").filter(Boolean);
  if (prefixLines.length === pending.head.payload.count && prefixLines.at(-1) === pending.line) {
    const state = await inspectLedger(directory, { verifyPayloads: true, requireHead: false });
    if (!state.valid || canonicalJSON(state.expectedHead) !== canonicalJSON(pending.head.payload)) throw new Error("Receipt recovery ledger does not match its signed journal");
  } else {
    if (prefixLines.length !== pending.head.payload.count - 1 || (!complete && !expectedLine.startsWith(text.slice(prefix.length)))) throw new Error("Receipt recovery found an unexpected ledger tail");
    await durableWrite(ledger, prefix + expectedLine);
    const state = await inspectLedger(directory, { verifyPayloads: true, requireHead: false });
    if (!state.valid || canonicalJSON(state.expectedHead) !== canonicalJSON(pending.head.payload)) throw new Error("Receipt recovery could not establish the signed head");
  }
  await atomicJson(path.join(directory, "receipt-head.json"), pending.head);
  await unlink(pendingFile);
}

export async function appendReceipt(receipt, { dataDir } = {}) {
  if (!await verifyReceipt(receipt, { dataDir })) throw new Error("An unverified receipt cannot be appended");
  const directory = path.resolve(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const release = await lockLedger(directory);
  try {
    await recoverPending(directory);
    const state = await inspectLedger(directory);
    if (!state.valid) throw new Error("The existing receipt ledger has an integrity break; append refused");
    const base = withoutChain(receipt), payload = await verifyReceiptPayload(base, { dataDir: directory });
    if (payload.available && !payload.verified) throw new Error("The outbound payload does not match the signed receipt");
    const metadata = { kind: "receipt-chain-entry-v1", version: 1, sequence: state.total + 1, previousEntryHash: state.lastEntryHash, receiptHash: sha256(base), snapshotHash: payload.available ? payload.snapshotHash : null };
    const attestation = await signReceipt(metadata, { dataDir: directory });
    const entryHash = sha256({ metadata, signature: attestation.signature });
    const saved = { ...base, chain: { ...metadata, attestation, entryHash } };
    const head = await signReceipt({ kind: "receipt-chain-head-v1", version: 1, count: metadata.sequence, lastEntryHash: entryHash, legacyUnchained: state.legacyUnchained }, { dataDir: directory });
    const line = JSON.stringify(saved);
    await atomicJson(path.join(directory, "receipt-pending.json"), { head, line, lineHash: sha256(line) });
    const file = await open(path.join(directory, "receipts.jsonl"), "a", 0o600);
    try { await file.writeFile(line + "\n", "utf8"); await file.sync(); } finally { await file.close(); }
    await atomicJson(path.join(directory, "receipt-head.json"), head);
    await unlink(path.join(directory, "receipt-pending.json"));
    return saved;
  } finally { await release(); }
}

export async function verifyReceiptChain({ dataDir, verifyPayloads = true } = {}) {
  if (!dataDir) throw new Error("A local data directory is required for receipt verification");
  const state = await inspectLedger(path.resolve(dataDir), { verifyPayloads });
  let pending;
  try { pending = await optionalJson(path.join(path.resolve(dataDir), "receipt-pending.json")); } catch { state.breaks.push({ code: "unreadable_recovery_journal", sequence: state.total }); state.valid = false; }
  if (pending) { state.breaks.push({ code: "pending_recovery", sequence: state.total }); state.valid = false; }
  const { entries, expectedHead, ...report } = state;
  return { ...report, verificationScope: "Pinned local Ed25519 signatures, signed hash links and retained redacted payload hashes. Does not prove remote delivery or prevent simultaneous rollback of ledger and signed head.", legacyNote: state.legacyUnchained ? "Historical receipts retain signature verification; they were not originally chained and may lack exact payload snapshots." : null };
}
