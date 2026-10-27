import { mkdir, open, readFile, rename, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { canonicalJSON, recoverPending, sha256, signReceipt, verifyReceipt, verifyReceiptChain, verifyReceiptPayload } from '../rag/receipts.mjs';
import { acquireRunLock } from './run-lock.mjs';

const emptyHash = '0'.repeat(64);
function integrityError(error) {
  const failure = error instanceof Error ? error : new Error(String(error));
  if (failure.code && failure.code !== 'RECEIPT_INTEGRITY_FAILURE') failure.receiptCauseCode = failure.code;
  failure.code = 'RECEIPT_INTEGRITY_FAILURE';
  return failure;
}
const withoutChain = receipt => { const { chain, ...base } = receipt; return base; };
const equal = (left, right) => canonicalJSON(left) === canonicalJSON(right);
async function optionalText(file) { try { return await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } }
async function fileStamp(file) {
  try {
    const value = await stat(file, { bigint: true });
    return { size: value.size.toString(), mtimeNs: value.mtimeNs.toString(), ctimeNs: value.ctimeNs.toString(), device: value.dev.toString(), inode: value.ino.toString() };
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
async function durableWrite(file, text) {
  const handle = await open(file, 'w', 0o600);
  try { await handle.writeFile(text, 'utf8'); await handle.sync(); } finally { await handle.close(); }
}
async function atomicJson(file, value) {
  const temporary = `${file}.${process.pid}.tmp`;
  await durableWrite(temporary, `${JSON.stringify(value)}\n`);
  await rename(temporary, file);
}
function semanticPayload(receipt) {
  const { createdAt, timestamp, ...payload } = receipt.payload;
  return payload;
}
function eventKey(receipt) {
  const { runId, inputHash, modelId, status, responseId } = receipt.payload;
  return canonicalJSON({ runId, inputHash, modelId, status, responseId });
}
function strictAudit(report) {
  const breaks = [...report.breaks];
  if (report.total && !report.headVerified && !breaks.some(row => row.code === 'head_mismatch_or_truncation')) breaks.push({ code: 'comparison_signed_head_required', sequence: report.total });
  if (report.payloadsVerified !== report.total) breaks.push({ code: 'comparison_payloads_required', sequence: report.total });
  if (report.chained !== report.total || report.verifiedSignatures !== report.total) breaks.push({ code: 'comparison_signed_chain_required', sequence: report.total });
  return { ...report, breaks, valid: report.valid && breaks.length === 0 };
}

/**
 * Comparison-only O(1) appends with existing receipt/chain/journal bytes.
 * The full prefix is audited on open and close, rather than on every append.
 * Old payload tampering during a run is detected by the mandatory final audit.
 * Tier 0 keeps using the strict existing appendReceipt path.
 */
export async function openReceiptJournal({ dataDir } = {}) {
  if (!dataDir) throw integrityError('A comparison receipt directory is required');
  const directory = path.resolve(dataDir);
  let release;
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    release = await acquireRunLock(path.join(directory, 'receipts.lock'), { owner: { purpose: 'comparison-receipt-journal' }, attempts: 300, delayMs: 20 });
  } catch (error) { throw integrityError(error); }
  const ledgerFile = path.join(directory, 'receipts.jsonl'), headFile = path.join(directory, 'receipt-head.json');
  const pendingFile = path.join(directory, 'receipt-pending.json'), keyFile = path.join(directory, 'keys', 'receipt-public.pem');
  try {
    // Shared recovery performs a full verification once, including torn tails.
    await recoverPending(directory);
    const initialAudit = strictAudit(await verifyReceiptChain({ dataDir: directory }));
    if (!initialAudit.valid) throw new Error('Comparison receipt startup audit failed; publication and append refused');
    let count = initialAudit.total, lastEntryHash = initialAudit.lastEntryHash ?? emptyHash;
    let expectedLedgerStamp = await fileStamp(ledgerFile), expectedHeadStamp = await fileStamp(headFile);
    let expectedHead = await optionalText(headFile), pinnedKey = await optionalText(keyFile);
    let closed = false, failure = null, queue = Promise.resolve(), closePromise;
    const events = new Map();
    const text = await optionalText(ledgerFile);
    for (const line of (text ?? '').split('\n').filter(Boolean)) {
      const saved = JSON.parse(line), key = eventKey(saved), previous = events.get(key);
      if (previous && !equal(semanticPayload(previous), semanticPayload(saved))) throw new Error('Comparison receipt event identity conflicts with an existing event');
      events.set(key, saved);
    }
    async function assertUnchanged() {
      if (!equal(await fileStamp(ledgerFile), expectedLedgerStamp) || !equal(await fileStamp(headFile), expectedHeadStamp)) throw new Error('Comparison receipt files changed outside the exclusive writer');
      const actualKey = await optionalText(keyFile), actualHead = await optionalText(headFile);
      if (pinnedKey !== null && actualKey !== pinnedKey) throw new Error('Comparison receipt trust anchor changed');
      if (actualHead !== expectedHead) throw new Error('Comparison signed receipt head changed');
      if (actualHead !== null) {
        const head = JSON.parse(actualHead);
        const payload = { kind: 'receipt-chain-head-v1', version: 1, count, lastEntryHash, legacyUnchained: 0 };
        if (!equal(head.payload, payload) || !await verifyReceipt(head, { dataDir: directory })) throw new Error('Comparison signed receipt head failed verification');
      }
    }
    async function appendOne(receipt) {
      if (failure) throw new Error('Comparison receipt writer is closed to further appends after an error');
      await assertUnchanged();
      const base = withoutChain(receipt);
      if (!await verifyReceipt(base, { dataDir: directory })) throw new Error('An unverified comparison receipt cannot be appended');
      const payload = await verifyReceiptPayload(base, { dataDir: directory });
      if (!payload.available || !payload.verified) throw new Error('An exact verified outbound snapshot is required for every comparison receipt');
      const actualKey = await optionalText(keyFile);
      if (pinnedKey === null) pinnedKey = actualKey;
      if (!pinnedKey || actualKey !== pinnedKey) throw new Error('Comparison receipt trust anchor changed');
      const key = eventKey(base), existing = events.get(key);
      if (existing) {
        if (!equal(semanticPayload(existing), semanticPayload(base))) throw new Error('A comparison receipt event cannot be reused with different content');
        return existing;
      }
      const metadata = { kind: 'receipt-chain-entry-v1', version: 1, sequence: count + 1, previousEntryHash: lastEntryHash, receiptHash: sha256(base), snapshotHash: payload.snapshotHash };
      const attestation = await signReceipt(metadata, { dataDir: directory });
      const entryHash = sha256({ metadata, signature: attestation.signature });
      const saved = { ...base, chain: { ...metadata, attestation, entryHash } };
      const head = await signReceipt({ kind: 'receipt-chain-head-v1', version: 1, count: metadata.sequence, lastEntryHash: entryHash, legacyUnchained: 0 }, { dataDir: directory });
      const line = JSON.stringify(saved);
      await atomicJson(pendingFile, { head, line, lineHash: sha256(line) });
      const handle = await open(ledgerFile, 'a', 0o600);
      try { await handle.writeFile(`${line}\n`, 'utf8'); await handle.sync(); } finally { await handle.close(); }
      await atomicJson(headFile, head);
      await unlink(pendingFile);
      count = metadata.sequence; lastEntryHash = entryHash;
      expectedLedgerStamp = await fileStamp(ledgerFile); expectedHeadStamp = await fileStamp(headFile);
      expectedHead = `${JSON.stringify(head)}\n`;
      events.set(key, saved);
      return saved;
    }
    return {
      append(receipt) {
        if (closed) return Promise.reject(integrityError('Comparison receipt writer is closed'));
        const next = queue.then(() => appendOne(receipt)).catch(error => { throw integrityError(error); });
        queue = next.catch(error => { failure ??= error; });
        return next;
      },
      close() {
        if (closePromise) return closePromise;
        closed = true;
        closePromise = (async () => {
          try {
            await queue;
            try { await assertUnchanged(); } catch (error) { failure ??= error; }
            const report = strictAudit(await verifyReceiptChain({ dataDir: directory }));
            if (failure) { report.valid = false; report.breaks.push({ code: 'comparison_journal_append_failed', sequence: report.total }); }
            return { ...report, writer: 'comparison-journal-v1', fullAuditRequiredBeforePublication: true,
              auditTiming: 'Full prefix and payload audit at open and close; each append verifies only the new receipt/snapshot, cached file identity and signed head' };
          } finally { await release(); }
        })().catch(error => { throw integrityError(error); });
        return closePromise;
      },
    };
  } catch (error) {
    try { await release(); } catch { /* Preserve the original integrity failure. */ }
    throw integrityError(error);
  }
}
