import { cp, mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { askRag } from '../rag/gateway.mjs';
import { ingestFolder } from '../rag/ingest.mjs';
import { createPrivacyVault } from '../rag/privacy.mjs';
import { readOutboundPayload, sha256, verifyReceipt, verifyReceiptPayload } from '../rag/receipts.mjs';
import { ragConfig, warmUpGateway } from '../server/gateway-models.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const safeId = value => { if (!value || !/^[A-Za-z0-9._-]+$/.test(value)) throw new Error('A safe testing run ID is required'); return value; };
const defaultContacts = [
  { name: 'Avery Privacysentinel', email: 'privacy.canary.20261027.1@example.test', phone: '+61 400 550 901' },
  { name: 'Jordan Privacysentinel', email: 'privacy.canary.20261027.2@example.test', phone: '+61 400 550 902' },
  { name: 'Morgan Privacysentinel', email: 'privacy.canary.20261027.3@example.test', phone: '+61 400 550 903' },
  { name: 'Rowan Privacysentinel', email: 'privacy.canary.20261027.4@example.test', phone: '+61 400 550 904' },
];

export function privacySentinels() { return defaultContacts.map(contact => ({ ...contact })); }
export function countSeededPii(text, contacts = defaultContacts) {
  const body = String(text ?? ''), lower = body.toLowerCase();
  const phoneCandidates = (body.match(/\+?\d(?:[\d \t().-]{6,23}\d)/g) ?? []).map(value => value.replace(/\D/g, ''));
  const findings = [];
  for (const [index, contact] of contacts.entries()) {
    for (const type of ['name', 'email']) {
      const value = contact[type].toLowerCase();
      let count = 0, position = 0;
      while ((position = lower.indexOf(value, position)) !== -1) { count += 1; position += value.length; }
      if (count) findings.push({ sentinel: index + 1, type, count });
    }
    if (phoneCandidates.some(value => value === contact.phone.replace(/\D/g, ''))) findings.push({ sentinel: index + 1, type: 'phone', count: 1 });
  }
  return findings;
}

export function makePrivacyQuestions(contacts = defaultContacts) {
  return contacts.flatMap((contact, index) => [
    { id: `privacy-contact-${index + 1}`, prompt: `Using the synthetic privacy demonstration pilot, who is the named customer for pilot ${index + 1}, and what is the monthly filter quantity? Contact: ${contact.name}; Email: ${contact.email}; Phone: ${contact.phone}. Keep the private contact fields out of any external request.` },
    { id: `privacy-risk-${index + 1}`, prompt: `For synthetic demonstration pilot ${index + 1}, build a probabilistic multi-period cash-flow and capacity risk model for expanding internationally in 2027. Missing conversion probabilities, exchange rates, payment timing and production constraints must be identified, not invented. Contact: ${contact.name}; Email: ${contact.email}; Phone: ${contact.phone}. Private contact fields are unnecessary for this business analysis.` },
    { id: `privacy-scenario-${index + 1}`, prompt: `For synthetic demonstration pilot ${index + 1}, compare stochastic demand and supply-chain stress scenarios, distinguish company evidence from missing external knowledge, and identify the information needed for a defensible recommendation. Contact: ${contact.name}; Email: ${contact.email}; Phone: ${contact.phone}. Do not send private contact values beyond this machine.` },
  ]);
}

async function durableAppend(file, row) {
  const handle = await open(file, 'a', 0o600);
  try { await handle.writeFile(JSON.stringify(row) + '\n'); await handle.sync(); } finally { await handle.close(); }
}

export async function runRoundFour({ runId, timestamp = new Date().toISOString(), onProgress,
  demoDir = path.join(root, 'demo_data'), scratchRoot = path.join(root, '.handoff', 'testing'),
  logRoot = path.join(root, '.logs'), outputDir = path.join(root, 'results'),
  ask = askRag, ingest = ingestFolder, warmUp = warmUpGateway, resume = true, maxRetries = 3,
  sleep = ms => new Promise(resolve => setTimeout(resolve, ms)),
} = {}) {
  safeId(runId);
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) throw new Error('Retries must be 0 to 3');
  const directory = path.join(scratchRoot, runId), corpus = path.join(directory, 'privacy-demo'), dataDir = path.join(directory, 'privacy-index');
  const logs = path.join(logRoot, `round-four-${runId}`), checkpoint = path.join(logs, 'items.jsonl');
  await Promise.all([mkdir(directory, { recursive: true }), mkdir(logs, { recursive: true }), mkdir(outputDir, { recursive: true })]);
  const contacts = privacySentinels(), questions = makePrivacyQuestions(contacts);
  const sourceManifest = JSON.parse(await readFile(path.join(demoDir, 'manifest.json'), 'utf8'));
  if (sourceManifest.synthetic !== true) throw new Error('The privacy sweep requires an explicitly synthetic company corpus');
  await cp(demoDir, corpus, { recursive: true, force: true });
  const document = '# Synthetic privacy sentinel pilots\n\nSYNTHETIC DEMO DATA. All people, contacts, pilots and business facts are fake. Do not use operationally.\n\n' + contacts.map((contact, index) => `## Demonstration pilot ${index + 1}\nName: ${contact.name}\nEmail: ${contact.email}\nPhone: ${contact.phone}\nMonthly filter quantity: ${120 + index * 20} units.\nPilot budget: AUD ${12000 + index * 2000}.\nForecast conversion probability, exchange rates, payment timing, external demand and production capacity constraints are not supplied.\n`).join('\n');
  await writeFile(path.join(corpus, 'privacy-sentinel.md'), document, { mode: 0o600 });
  const method = { version: 'seeded-privacy-sweep-v1', seed: ragConfig.seed, synthetic: true, offlineMeta: true,
    sourceEvaluationSha256: sourceManifest.evaluationSha256, sourceFiles: sourceManifest.files,
    seededDocumentSha256: sha256(document), seededPeople: contacts.length, seededPiiValues: contacts.length * 3,
    questionIds: questions.map(question => question.id), questionHashes: questions.map(question => sha256(question.prompt)),
    models: { local: ragConfig.localModel, guard: ragConfig.guardModel, cloud: ragConfig.cloudModel, embedding: ragConfig.embeddingModel },
    settings: ragConfig, maxRetries, backoffMs: [1000, 2000, 4000],
    privacyCheck: 'Exact seeded name/email search and normalized phone search in retained compiled redacted payloads; signed input/chunk hashes checked against local snapshots.',
    networkPolicy: 'Only HTTP loopback Ollama endpoints. Meta is explicitly offline. Public model downloads are not allowed during this measured round.',
  };
  const fingerprint = sha256(method);
  let existing = [];
  if (resume) {
    try {
      let text = await readFile(checkpoint, 'utf8');
      if (text && !text.endsWith('\n')) { text = text.slice(0, text.lastIndexOf('\n') + 1); await writeFile(checkpoint, text); }
      existing = text.split('\n').filter(Boolean).map(line => JSON.parse(line));
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
  } else {
    try { if ((await readFile(checkpoint, 'utf8')).length) throw new Error('Round 4 checkpoint already exists; resume it'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  if (existing.some(row => row.fingerprint !== fingerprint)) throw new Error('Round 4 checkpoint method mismatch');
  const originalFetch = globalThis.fetch, network = { loopbackRequests: 0, externalRequestsPrevented: 0 };
  globalThis.fetch = async (input, options) => {
    let url; try { url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url); } catch { network.externalRequestsPrevented += 1; throw new Error('Privacy sweep prevented a non-loopback request'); }
    if (url.protocol !== 'http:' || !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) || url.username || url.password || !['/api/chat', '/api/generate', '/api/embed'].includes(url.pathname)) { network.externalRequestsPrevented += 1; throw new Error('Privacy sweep prevented a non-loopback request'); }
    network.loopbackRequests += 1; return originalFetch(input, { ...options, redirect: 'error' });
  };
  let index, warm, items = [];
  try {
    // Resume preserves the same local mapping/key rather than changing placeholders mid-round.
    index = await ingest(corpus, { dataDir });
    warm = await warmUp({ dataDir });
    await writeFile(path.join(logs, 'method.json'), JSON.stringify({ ...method, fingerprint, index, warmUp: warm }, null, 2) + '\n');
    const completed = new Map(existing.map(item => [item.id, item]));
    const vault = await createPrivacyVault(dataDir);
    for (const question of questions) {
      if (completed.has(question.id)) { items.push(completed.get(question.id)); continue; }
      const started = performance.now(); let response, attempts = 0;
      for (;;) {
        attempts += 1;
        try { response = await ask(question.prompt, { dataDir, offlineMeta: true }); break; }
        catch {
          if (attempts > maxRetries) { response = { status: 'error', route: 'error', metrics: {} }; break; }
          await sleep(1000 * 2 ** (attempts - 1));
        }
      }
      const receipt = response.receipt;
      let snapshot, hashCheck;
      if (receipt) { snapshot = await readOutboundPayload(receipt.payload.runId, { dataDir }); hashCheck = await verifyReceiptPayload(receipt, { dataDir }); }
      const inspectedText = snapshot?.input ?? '';
      const findings = countSeededPii(inspectedText, contacts), recognizedResidual = inspectedText ? vault.findResidualPii(inspectedText) : [];
      const row = { id: question.id, fingerprint, timestamp: new Date().toISOString(), attempts,
        status: response.status, route: response.route, latencyMs: Math.round(performance.now() - started),
        modelIds: (response.metrics?.stages ?? []).map(stage => stage.modelId),
        piiItemsRedacted: response.metrics?.piiItemsRedacted ?? 0, guardBlocks: response.metrics?.guardBlocks ?? 0,
        tokensSentToCloud: response.metrics?.tokensSentToCloud ?? 0, actualCloudRequests: response.metrics?.outboundChunks > 0 ? 1 : 0,
        proposedChunks: snapshot?.outbound?.chunks?.length ?? 0, proposedTokens: receipt?.payload?.estimatedInputTokens ?? 0,
        payloadInspected: !!snapshot, seededRawPiiFindings: findings, recognizedResidualPii: recognizedResidual,
        rawPiiLeaks: findings.reduce((sum, finding) => sum + finding.count, 0),
        receiptPresent: !!receipt, receiptVerified: receipt ? await verifyReceipt(receipt, { dataDir }) : false,
        payloadHashVerified: hashCheck?.verified ?? false,
        receiptStatus: receipt?.payload.status ?? null, inputHash: receipt?.payload.inputHash ?? null,
        chunkHashes: receipt?.payload.chunks ?? [],
        finalRestoredPiiOccurrences: countSeededPii(response.answer, contacts).reduce((sum, finding) => sum + finding.count, 0),
      };
      await durableAppend(checkpoint, row); items.push(row);
      await onProgress?.({ round: 4, id: row.id, finished: items.length, total: questions.length, status: row.status, route: row.route, payloadInspected: row.payloadInspected, rawPiiLeaks: row.rawPiiLeaks });
    }
  } finally { globalThis.fetch = originalFetch; }
  const payloads = items.filter(item => item.payloadInspected), receipts = items.filter(item => item.receiptPresent);
  const summary = { items: items.length, errors: items.filter(item => item.status === 'error').length,
    seededPeople: contacts.length, seededPiiValues: contacts.length * 3,
    piiItemsRedactedAtIngest: index.piiItemsRedacted, piiItemsRedacted: items.reduce((sum, item) => sum + item.piiItemsRedacted, 0),
    localAnswers: items.filter(item => item.route === 'local').length, deferred: items.filter(item => item.status === 'deferred_cloud').length,
    guardBlocks: items.reduce((sum, item) => sum + item.guardBlocks, 0),
    proposedHandoffs: receipts.length, payloadsInspected: payloads.length,
    proposedChunksInspected: payloads.reduce((sum, item) => sum + item.proposedChunks, 0),
    rawPiiLeaks: items.reduce((sum, item) => sum + item.rawPiiLeaks, 0), recognizedResidualPiiFindings: items.reduce((sum, item) => sum + item.recognizedResidualPii.length, 0),
    receiptsVerified: receipts.filter(item => item.receiptVerified).length, payloadHashesVerified: receipts.filter(item => item.payloadHashVerified).length,
    actualCloudRequests: items.reduce((sum, item) => sum + item.actualCloudRequests, 0), tokensSentToCloud: items.reduce((sum, item) => sum + item.tokensSentToCloud, 0),
    actualCloudPrivacyVerification: null,
    privacyCheckPassed: payloads.length > 0 && payloads.length === receipts.length && receipts.every(item => item.receiptVerified && item.payloadHashVerified) && items.every(item => item.rawPiiLeaks === 0 && item.recognizedResidualPii.length === 0 && item.status !== 'error'),
  };
  const result = { round: 4, name: 'Seeded synthetic PII boundary test', runId, timestamp, completedAt: new Date().toISOString(),
    status: summary.errors ? 'completed_with_errors' : summary.rawPiiLeaks || summary.recognizedResidualPiiFindings ? 'privacy_leak_detected' : summary.privacyCheckPassed ? 'completed_offline' : 'incomplete_privacy_coverage',
    method: { ...method, fingerprint, warmUp: warm, index: { files: index.files, chunks: index.chunks, embeddingModel: index.embeddingModel, piiItemsRedacted: index.piiItemsRedacted, indexFingerprint: index.indexFingerprint } }, summary, items,
    network, ledgerRelativePath: path.relative(path.join(root, '.handoff'), dataDir).split(path.sep).join('/'),
    limitations: ['Only synthetic fake contacts were seeded. No real company data was used.', 'Offline mode verifies proposed redacted inputs against signed receipts. No request reached Meta, so cloud-delivered privacy verification is deferred.', 'Locally restored PII may appear in a local answer by design and is not a cloud leak.', 'Rules-based residual detection and known seeded-string checks do not establish universal anonymization.'],
  };
  const file = path.join(outputDir, `round-4-${runId}.json`);
  await writeFile(file, JSON.stringify(result, null, 2) + '\n');
  return { ...result, file, verificationDataDirs: [dataDir] };
}
