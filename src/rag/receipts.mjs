import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
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

export async function appendReceipt(receipt, { dataDir } = {}) {
  if (!await verifyReceipt(receipt, { dataDir })) throw new Error("An unverified receipt cannot be appended");
  const directory = path.resolve(dataDir);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const file = await open(path.join(directory, "receipts.jsonl"), "a", 0o600);
  try { await file.writeFile(JSON.stringify(receipt) + "\n", "utf8"); await file.sync(); }
  finally { await file.close(); }
  return receipt;
}
