import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertNoResidualPii, countPlaceholders, createPrivacyVault } from "../src/rag/privacy.mjs";
import { appendReceipt, canonicalJSON, sha256, signReceipt, verifyReceipt } from "../src/rag/receipts.mjs";

async function workspace(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "handoff-privacy-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

test("PII is redacted consistently, encrypted at rest and restored locally", async t => {
  const dataDir = await workspace(t);
  const vault = await createPrivacyVault(dataDir);
  const source = "SYNTHETIC DATA ONLY\nName: Avery Chen\nEmail: avery.chen@example.invalid\nPhone: +61 400 000 001\nAvery Chen manages support.";
  const redacted = vault.redact(source);
  assert.equal(redacted.count, 4);
  assert.equal(countPlaceholders(redacted.text), 4);
  assert.equal(vault.placeholderCount(redacted.text), 4);
  assert.equal(redacted.placeholders.length, 3);
  assert.equal(redacted.text.includes("Avery Chen"), false);
  assert.equal(redacted.text.includes("avery.chen@example.invalid"), false);
  assert.equal(vault.restore(redacted.text), source);
  assertNoResidualPii(redacted.text, vault);
  assert.throws(() => assertNoResidualPii(source, vault), /private data/);
  await vault.save();
  const encrypted = await readFile(path.join(dataDir, "pii-map.enc.json"), "utf8");
  assert.equal(encrypted.includes("Avery"), false);
  assert.equal(encrypted.includes("example.invalid"), false);
  const reopened = await createPrivacyVault(dataDir);
  assert.equal(reopened.restore(redacted.text), source);
  assert.equal(reopened.redact("Who is Avery Chen?").text, vault.redact("Who is Avery Chen?").text);
});

test("business numbers and existing placeholders are preserved; unknown secrets block outbound", async t => {
  const vault = await createPrivacyVault(await workspace(t));
  const source = "Revenue $1000000000 or $1 000 000 000. CPA $21.50. Width 1000 2000 3000 mm. Flow 500 L/min. Date 2026-10-28. Model llama3.1:8b.";
  assert.equal(vault.redact(source).text, source);
  const email = vault.redact("Contact: support@example.invalid");
  assert.equal(vault.redact(email.text).count, 0);
  assert.equal(vault.redact(email.text).text, email.text);
  const secret = ["s", "k", "-"].join("") + "x".repeat(24);
  assert.throws(() => assertNoResidualPii(secret, vault), /private data/);
  assert.equal(vault.redact(secret).count, 1);
  const phone = vault.redact("Phone: +61 400 000 001");
  assert.equal(vault.redact("Call +61400000001").text, `Call ${phone.placeholders[0]}`);
});

test("labeled CSV names and plain labeled phone numbers are recognized", async t => {
  const vault = await createPrivacyVault(await workspace(t));
  const source = "customer_name: Morgan Vale; customer_phone: 5551234567; ticket: AQ-101\nPrepared by Jordan Reed.";
  const redacted = vault.redact(source);
  assert.equal(redacted.count, 3);
  assert.equal(vault.restore(redacted.text), source);
  assert.equal(vault.containsPii("Morgan Vale contacted Jordan Reed."), true);
});

test("concurrent vault saves merge mappings without exposing plaintext", async t => {
  const dataDir = await workspace(t);
  const first = await createPrivacyVault(dataDir);
  const second = await createPrivacyVault(dataDir);
  const a = first.redact("a@example.invalid");
  const b = second.redact("b@example.invalid");
  await Promise.all([first.save(), second.save()]);
  const reopened = await createPrivacyVault(dataDir);
  assert.equal(reopened.restore(a.text), "a@example.invalid");
  assert.equal(reopened.restore(b.text), "b@example.invalid");
});

test("receipts bind chunk hashes and payload, and pin the local signing identity", async t => {
  const dataDir = await workspace(t);
  const payload = { runId: "test-001", status: "sent", chunkHashes: [{ chunkId: "opaque-001", sha256: sha256("redacted text") }], inputHash: sha256("input"), tokensSent: 42 };
  const receipt = await signReceipt(payload, { dataDir });
  assert.equal(await verifyReceipt(receipt, { dataDir }), true);
  assert.equal(await verifyReceipt({ ...receipt, payload: { ...receipt.payload, tokensSent: 43 } }, { dataDir }), false);
  const changedChunk = structuredClone(receipt);
  changedChunk.payload.chunkHashes[0].sha256 = sha256("different text");
  assert.equal(await verifyReceipt(changedChunk, { dataDir }), false);
  const impostor = generateKeyPairSync("ed25519");
  const publicKey = impostor.publicKey.export({ type: "spki", format: "pem" });
  const forged = { ...receipt, publicKey, signature: sign(null, Buffer.from(canonicalJSON(payload)), impostor.privateKey).toString("base64url") };
  assert.equal(await verifyReceipt(forged, { dataDir }), false);
  assert.equal(await verifyReceipt(receipt, { dataDir: path.join(dataDir, "unknown") }), false);
  await appendReceipt(receipt, { dataDir });
  const saved = JSON.parse((await readFile(path.join(dataDir, "receipts.jsonl"), "utf8")).trim());
  assert.equal(await verifyReceipt(saved, { dataDir }), true);
});

test("canonical JSON is independent of object key order", () => {
  assert.equal(canonicalJSON({ z: 1, a: { y: 2, b: [3, 4] } }), canonicalJSON({ a: { b: [3, 4], y: 2 }, z: 1 }));
  assert.throws(() => canonicalJSON({ value: Infinity }), /finite/);
});
