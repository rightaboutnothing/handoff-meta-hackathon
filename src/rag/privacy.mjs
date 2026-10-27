import { createCipheriv, createDecipheriv, createHmac, randomBytes, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const PLACEHOLDER_SOURCE = String.raw`\[\[PII_(?:EMAIL|PHONE|NAME|SECRET)_[a-f0-9]{16}\]\]`;
const EMAIL_SOURCE = String.raw`[A-Z0-9.!#$%&'*+/=?^_\x60{|}~-]+@[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?(?:\.[A-Z0-9](?:[A-Z0-9-]*[A-Z0-9])?)+`;
const PHONE_SOURCE = String.raw`(?<![\p{L}\p{N}$])\+?\d(?:[\d \t().-]{6,23}\d)(?![\p{L}\p{N}])`;
const SECRET_SOURCE = String.raw`\b(?:sk-[A-Za-z0-9_-]{16,}|hf_[A-Za-z0-9]{20,})\b`;
const PERSON_SOURCE = String.raw`([A-Z][a-z]+(?:[-'][A-Za-z]+)?(?:[ \t]+[A-Z][a-z]+(?:[-'][A-Za-z]+)?){1,3})`;
const NAME_LABEL_SOURCE = String.raw`\b(?:[Cc]ustomer(?:[ _][Nn]ame)?|[Ee]mployee(?:[ _][Nn]ame)?|[Ff]ull[ _][Nn]ame|[Cc]ontact(?:[ _][Nn]ame)?|[Oo]wner(?:[ _][Nn]ame)?|[Nn]ame|[Mm]anager|[Ss]ales[ _][Rr]ep|[Ss]alesperson|[Aa]ssigned[ _][Tt]o)[ \t]*[:=][ \t]*${PERSON_SOURCE}(?=[ \t]*(?:[,;|\r\n]|$))`;
const NAME_PROSE_SOURCE = String.raw`\b(?:[Pp]repared by|[Hh]andled by|[Ss]igned by|[Mm]anaged by)[ \t]+${PERSON_SOURCE}(?=[ \t]*(?:[,;|.\r\n]|$))`;
const PHONE_LABEL_SOURCE = String.raw`\b(?:customer_phone|employee_phone|contact_phone|phone|mobile|telephone|tel)[ \t]*[:=][ \t]*([+\d][\d \t().-]{6,25}\d)`;
const pattern = (source, flags = "g") => new RegExp(source, flags);
const escaped = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function phoneCandidate(value, labeled = false) {
  const text = value.trim();
  const digits = text.replace(/\D/g, "");
  if (digits.length < 9 || digits.length > 15) return false;
  return labeled || text.startsWith("+") || (/^0/.test(text) && digits.length >= 10)
    || /^\(\d{2,4}\)[ -]?\d[\d -]+$/.test(text)
    || /^[2-9]\d{2}[ -]\d{3}[ -]\d{4}$/.test(text);
}

function canonicalValue(type, value) {
  const trimmed = value.trim();
  if (type === "PHONE") return trimmed.replace(/\D/g, "");
  if (type === "NAME" || type === "EMAIL") return trimmed.replace(/\s+/g, " ").toLowerCase();
  return trimmed;
}

export function countPlaceholders(text) {
  return (String(text).match(pattern(PLACEHOLDER_SOURCE)) ?? []).length;
}

async function privateKeyFile(file) {
  try { return await readFile(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const key = randomBytes(32);
  try { await writeFile(file, key, { mode: 0o600, flag: "wx" }); return key; }
  catch (error) { if (error.code !== "EEXIST") throw error; return readFile(file); }
}

function decryptMap(serialized, key) {
  const record = JSON.parse(serialized);
  if (record.version !== 1 || record.algorithm !== "aes-256-gcm") throw new Error("Unsupported local PII map format");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(record.iv, "base64"));
  decipher.setAAD(Buffer.from("handoff-pii-map-v1"));
  decipher.setAuthTag(Buffer.from(record.tag, "base64"));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(record.ciphertext, "base64")), decipher.final()]).toString("utf8"));
}

function encryptMap(entries, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from("handoff-pii-map-v1"));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(entries), "utf8"), cipher.final()]);
  return JSON.stringify({ version: 1, algorithm: "aes-256-gcm", iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ciphertext: ciphertext.toString("base64") });
}

async function loadEntries(file, key) {
  try { return decryptMap(await readFile(file, "utf8"), key); }
  catch (error) { if (error.code === "ENOENT") return []; throw new Error("The local PII map cannot be opened", { cause: error }); }
}

async function acquireLock(file) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try { return await open(file, "wx", 0o600); }
    catch (error) {
      if (error.code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error("The local PII map is busy. Retry after the current ingest or query finishes.");
}

// Rules recognize labeled names and remember them for later occurrences. This is
// intentionally local and conservative, not a universal named-entity detector.
// Deployments should supply additional sensitive terms and test their own corpus.
export async function createPrivacyVault(dataDir) {
  if (!dataDir) throw new Error("A local data directory is required for the privacy vault");
  const directory = path.resolve(dataDir);
  const keysDirectory = path.join(directory, "keys");
  await mkdir(keysDirectory, { recursive: true, mode: 0o700 });
  const key = await privateKeyFile(path.join(keysDirectory, "pii-map.key"));
  if (key.length !== 32) throw new Error("The local PII map key is invalid");
  const mapFile = path.join(directory, "pii-map.enc.json");
  const entries = new Map((await loadEntries(mapFile, key)).map(entry => [entry.token, entry]));
  let dirty = false;

  function register(type, value) {
    const original = String(value).trim();
    const canonical = canonicalValue(type, original);
    const token = `[[PII_${type}_${createHmac("sha256", key).update(type + "\0" + canonical).digest("hex").slice(0, 16)}]]`;
    if (!entries.has(token)) { entries.set(token, { token, type, value: original, canonical }); dirty = true; }
    return token;
  }

  function discover(text) {
    for (const match of text.matchAll(pattern(NAME_LABEL_SOURCE))) register("NAME", match[1]);
    for (const match of text.matchAll(pattern(NAME_PROSE_SOURCE))) register("NAME", match[1]);
    for (const match of text.matchAll(pattern(EMAIL_SOURCE, "gi"))) register("EMAIL", match[0]);
    for (const match of text.matchAll(pattern(SECRET_SOURCE))) register("SECRET", match[0]);
    for (const match of text.matchAll(pattern(PHONE_LABEL_SOURCE, "gi"))) if (phoneCandidate(match[1], true)) register("PHONE", match[1]);
    for (const match of text.matchAll(pattern(PHONE_SOURCE, "gu"))) if (phoneCandidate(match[0])) register("PHONE", match[0]);
  }

  function knownPattern(entry) {
    if (entry.type === "PHONE") {
      const digits = entry.canonical.split("").join("[ \\t().-]*");
      return pattern(`(?<![\\p{L}\\p{N}_$])\\+?${digits}(?![\\p{L}\\p{N}_])`, "gu");
    }
    const value = escaped(entry.value).replace(/\s+/g, "[ \\t]+");
    return pattern(`(?<![\\p{L}\\p{N}_])${value}(?![\\p{L}\\p{N}_])`, entry.type === "NAME" || entry.type === "EMAIL" ? "giu" : "gu");
  }

  function redact(text) {
    const input = String(text ?? "");
    discover(input);
    let count = 0;
    const placeholders = new Set();
    const records = [...entries.values()].sort((a, b) => b.value.length - a.value.length);
    const result = input.split(pattern(`(${PLACEHOLDER_SOURCE})`)).map(part => {
      if (pattern(`^${PLACEHOLDER_SOURCE}$`).test(part)) return part;
      let redacted = part;
      for (const entry of records) {
        redacted = redacted.replace(knownPattern(entry), () => { count += 1; placeholders.add(entry.token); return entry.token; });
      }
      return redacted;
    }).join("");
    return { text: result, count, placeholders: [...placeholders] };
  }

  function restore(text) {
    return String(text ?? "").replace(pattern(PLACEHOLDER_SOURCE), token => entries.get(token)?.value ?? token);
  }

  function findResidualPii(text) {
    const input = String(text ?? "").replace(pattern(PLACEHOLDER_SOURCE), " ");
    const findings = new Map();
    const add = (type, count = 1) => findings.set(type, (findings.get(type) ?? 0) + count);
    for (const entry of entries.values()) {
      const occurrences = [...input.matchAll(knownPattern(entry))].length;
      if (occurrences) add(entry.type, occurrences);
    }
    for (const _match of input.matchAll(pattern(EMAIL_SOURCE, "gi"))) add("EMAIL");
    for (const _match of input.matchAll(pattern(SECRET_SOURCE))) add("SECRET");
    for (const match of input.matchAll(pattern(PHONE_SOURCE, "gu"))) if (phoneCandidate(match[0])) add("PHONE");
    for (const match of input.matchAll(pattern(PHONE_LABEL_SOURCE, "gi"))) if (phoneCandidate(match[1], true)) add("PHONE");
    for (const _match of input.matchAll(pattern(NAME_LABEL_SOURCE))) add("NAME");
    for (const _match of input.matchAll(pattern(NAME_PROSE_SOURCE))) add("NAME");
    return [...findings].map(([type, count]) => ({ type, count }));
  }

  async function save() {
    if (!dirty) return;
    const lockFile = path.join(directory, "pii-map.lock");
    const lock = await acquireLock(lockFile);
    const temporary = path.join(directory, `.pii-map-${process.pid}-${randomUUID()}.tmp`);
    try {
      const merged = new Map((await loadEntries(mapFile, key)).map(entry => [entry.token, entry]));
      for (const [token, entry] of entries) if (!merged.has(token)) merged.set(token, entry);
      await writeFile(temporary, encryptMap([...merged.values()], key) + "\n", { mode: 0o600, flag: "wx" });
      await rename(temporary, mapFile);
      entries.clear();
      for (const [token, entry] of merged) entries.set(token, entry);
      dirty = false;
    } finally {
      await lock.close();
      await unlink(lockFile).catch(() => undefined);
      await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
    }
  }

  return {
    redact, restore, save, findResidualPii,
    containsPii: text => findResidualPii(text).length > 0,
    placeholderCount: countPlaceholders,
    registerNames(names) { for (const name of names) register("NAME", name); },
    stats: () => ({ entries: entries.size, encryptedAtRest: true }),
  };
}

export function assertNoResidualPii(text, vault) {
  if (!vault?.findResidualPii) throw new Error("A local privacy vault is required for the outbound check");
  const findings = vault.findResidualPii(text);
  if (findings.length) throw new Error("Outbound payload contains residual private data; cloud handoff blocked");
  return true;
}
