import { useEffect, useMemo, useState } from 'react';
import { motion } from 'framer-motion';
import { formatCount, formatLatency, formatPercent, getRound } from '../gatewayTypes';
import type { GatewayResults, ReceiptDetail, RoundFive } from '../gatewayTypes';
import { useMotionPreference } from '../hooks/useMotionPreference';
import './GatewayTrust.css';

type Scope = 'all' | 'outbound' | 'inbound' | 'redteam';
type Decision = { key: string; id: string; scope: Exclude<Scope, 'all'>; source: string; modelId: string; classification: string; latencyMs: number; categories?: string[] };
const modelLabel = (modelId: string) => modelId === 'muse-spark-1.3' ? 'Muse Spark' : modelId;
const classificationLabel = (classification: string) => classification === 'safe' ? 'Safe' : classification === 'unsafe' ? 'Blocked' : 'Unavailable';
function decisionAppearance(item: Decision) {
  if (item.scope === 'redteam' && item.source === 'StrongREJECT' && item.classification === 'safe') return { label: 'Unsafe pass', tone: 'miss' };
  if (item.scope === 'redteam' && item.source === 'XSTest · safe' && item.classification === 'unsafe') return { label: 'Over-block', tone: 'overblock' };
  if (item.scope === 'redteam' && item.source === 'StrongREJECT' && item.classification === 'unsafe') return { label: 'Blocked', tone: 'protected' };
  return { label: classificationLabel(item.classification), tone: item.classification };
}
const formatDate = (value?: string | null) => value && Number.isFinite(new Date(value).getTime()) ? new Date(value).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }) + ' UTC' : 'Pending';

function ShieldIcon() {
  return <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6l8-3Z" /><path d="m8 12 3 3 5-6" /></svg>;
}

function EntryHash({ entry }: { entry: ReceiptDetail }) {
  const runId = typeof entry.runId === 'string' && entry.runId ? entry.runId : 'Unknown run';
  return <details className="gt-entry-hash"><summary><span>{runId === 'Unknown run' ? runId : runId.slice(0, 8) + '…'}</span><span aria-hidden="true">↗</span></summary><dl><dt>Run ID</dt><dd>{runId}</dd><dt>Entry SHA-256</dt><dd>{entry.entryHash}</dd><dt>Compiled input SHA-256</dt><dd>{entry.inputHash ?? 'Unavailable'}</dd><dt>Receipt status</dt><dd>{entry.status}</dd><dt>Chunks actually sent</dt><dd>{entry.actualChunksSent === null ? 'Unknown' : formatCount(entry.actualChunksSent)}</dd><dt>Outbound Guard / inbound Guard</dt><dd>{entry.guardOutbound ?? 'Not recorded'} / {entry.guardInbound ?? 'Pending'}</dd></dl></details>;
}

export function GatewayTrust({ data, onRefresh }: { data: GatewayResults | null; onRefresh?: () => void }) {
  const rag = getRound(data, 2), redteam = getRound(data, 3), privacy = getRound(data, 4), recordedVerification = getRound(data, 5);
  const [scope, setScope] = useState<Scope>('all');
  const [ledgerFilter, setLedgerFilter] = useState('all');
  const [verifiedNow, setVerifiedNow] = useState<RoundFive | null>(null);
  const [verifying, setVerifying] = useState(false);
  const [verificationError, setVerificationError] = useState('');
  const reduced = useMotionPreference();
  const verification = verifiedNow ?? recordedVerification;
  const chain = verification?.summary;
  const pii = privacy?.summary;
  const safety = redteam?.summary;
  const livePrivacyResult = !pii ? 'Pending' : pii.actualCloudPrivacyVerification == null ? 'Deferred' : formatCount(pii.actualCloudPrivacyVerification);

  useEffect(() => { setVerifiedNow(null); setLedgerFilter('all'); }, [data?.manifest?.runId]);

  const decisions = useMemo<Decision[]>(() => [
    ...(rag?.items ?? []).flatMap(item => (item.metrics.stages ?? []).filter(stage => stage.stage === 'guard_outbound' || stage.stage === 'guard_inbound').map((stage, index) => ({
      key: `rag-${item.id}-${index}`, id: item.id, scope: stage.stage === 'guard_inbound' ? 'inbound' as const : 'outbound' as const,
      source: 'Company data', modelId: stage.modelId, classification: stage.classification ?? (stage.safe === true ? 'safe' : stage.safe === false ? 'unsafe' : 'unavailable'), latencyMs: stage.latencyMs,
    }))),
    ...(redteam?.items ?? []).map(item => ({ key: `redteam-${item.id}`, id: item.id, scope: 'redteam' as const,
      source: item.suite === 'strongreject' ? 'StrongREJECT' : 'XSTest · safe', modelId: redteam?.summary.modelId ?? '', classification: item.classification, latencyMs: item.latencyMs, categories: item.categories,
    })),
  ], [rag, redteam]);
  const filteredDecisions = decisions.filter(item => scope === 'all' || item.scope === scope);
  const inboundCount = decisions.filter(item => item.scope === 'inbound').length;
  const ledgerRows = (verification?.ledgers ?? []).filter(ledger => ledgerFilter === 'all' || ledger.ledger === ledgerFilter).flatMap(ledger => ledger.details.map(entry => ({ ledger: ledger.ledger, entry })));

  const verify = async () => {
    setVerifying(true); setVerificationError('');
    try {
      const response = await fetch('/api/company/verify-receipts', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const payload = await response.json();
      const report = payload.result ?? payload;
      if (!response.ok || !report.summary || !Array.isArray(report.ledgers)) throw new Error(payload.error || 'Receipt verification could not finish. Check the local gateway and try again.');
      setVerifiedNow(report as RoundFive); onRefresh?.();
    } catch (error) { setVerificationError(error instanceof Error ? error.message : 'Receipt verification is unavailable.'); }
    finally { setVerifying(false); }
  };

  return <motion.div className="gt-view" initial={{ opacity: reduced ? 1 : 0, y: reduced ? 0 : 8 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}>
    <header className="gt-heading"><div><span className="gt-eyebrow">Trust</span><h1>Inspect every boundary decision.</h1><p>Review local safety decisions, privacy checks and the signed receipt chain.</p></div><span className="gt-local-label"><span /> Local verification</span></header>

    <section className="gt-overview" aria-label="Trust measurements">
      <div><span>Signatures verified</span><strong>{chain ? <>{formatCount(chain.signaturesVerified)}<small> / {formatCount(chain.receipts)}</small></> : 'Pending'}</strong><p>Across the local receipt ledgers</p></div>
      <div><span>Linked receipt entries</span><strong>{formatCount(chain?.chained)}</strong><p>{chain ? `${formatCount(chain.legacyUnchained)} earlier entries have legacy coverage` : 'Chain verification has not run'}</p></div>
      <div><span>Raw PII in inspected payloads</span><strong className={pii?.rawPiiLeaks === 0 ? 'gt-good-number' : ''}>{formatCount(pii?.rawPiiLeaks)}</strong><p>{pii ? `${formatCount(pii.payloadsInspected)} proposed payloads inspected locally` : 'Privacy round pending'}</p></div>
      <div><span>Harmful prompts Guard missed</span><strong className={safety && safety.unsafePasses > 0 ? 'gt-alert-number' : ''}>{formatCount(safety?.unsafePasses)}</strong><p>Unsafe passes remain in the results</p></div>
    </section>

    <div className="gt-evidence-grid">
      <section className="gt-panel gt-decisions" aria-labelledby="gt-decisions-title">
        <div className="gt-section-heading"><div><span className="gt-eyebrow">Llama Guard</span><h2 id="gt-decisions-title">The decision feed</h2></div><span className="gt-source-label">Measured records</span></div>
        <div className="gt-filters" aria-label="Filter Guard decisions">{(['all', 'outbound', 'inbound', 'redteam'] as Scope[]).map(option => <button type="button" key={option} aria-pressed={scope === option} onClick={() => setScope(option)}>{option === 'all' ? 'All decisions' : option === 'outbound' ? 'Outbound' : option === 'inbound' ? 'Inbound' : 'Red-team'}<span>{formatCount(option === 'all' ? decisions.length : decisions.filter(item => item.scope === option).length)}</span></button>)}</div>
        {inboundCount === 0 && <p className="gt-pending-note">Inbound review: <strong>Pending</strong>. No Muse Spark reply was reviewed in this offline round.</p>}
        {filteredDecisions.length > 0 ? <div className="gt-feed-scroll"><table className="gt-table"><thead><tr><th>Task</th><th>Boundary</th><th>Decision</th><th>Latency</th></tr></thead><tbody>{filteredDecisions.map(item => { const appearance = decisionAppearance(item); return <tr key={item.key}><td><strong>{item.id}</strong><small>{item.source}</small></td><td><span>{item.scope === 'redteam' ? 'Local red-team' : item.scope === 'outbound' ? 'Outbound' : 'Inbound'}</span><small>{item.modelId}</small></td><td><span className={`gt-decision gt-decision-${appearance.tone}`}>{appearance.label}</span>{item.categories?.length ? <small>{item.categories.join(', ')}</small> : null}</td><td className="gt-numeric">{formatLatency(item.latencyMs)}</td></tr>; })}</tbody></table></div> : <p className="gt-empty">{scope === 'inbound' ? 'Inbound decisions will appear after a permitted cloud answer is checked locally.' : 'Pending. No measured decisions are available for this filter.'}</p>}
        <p className="gt-panel-note">Task IDs, classifications and timing come from the company evaluation and local red-team sweep. Harmful prompt text stays out of this view.</p>
      </section>

      <aside className="gt-privacy gt-panel" aria-labelledby="gt-privacy-title">
        <span className="gt-eyebrow">PII boundary check</span><h2 id="gt-privacy-title">Private fields stay local.</h2>
        <div className="gt-privacy-number"><strong>{formatCount(pii?.piiItemsRedacted)}</strong><span>PII occurrences processed<br />during the seeded privacy round</span></div>
        <dl className="gt-key-values"><div><dt>Fake PII values seeded</dt><dd>{formatCount(pii?.seededPiiValues)}</dd></div><div><dt>Redactions at ingest</dt><dd>{formatCount(pii?.piiItemsRedactedAtIngest)}</dd></div><div><dt>Payload hashes checked</dt><dd>{formatCount(pii?.payloadHashesVerified)}</dd></div><div><dt>Raw PII leaks</dt><dd className={pii?.rawPiiLeaks === 0 ? 'gt-good-number' : 'gt-alert-number'}>{formatCount(pii?.rawPiiLeaks)}</dd></div><div><dt>Actual cloud requests</dt><dd>{formatCount(pii?.actualCloudRequests)}</dd></div><div><dt>Live cloud privacy result</dt><dd>{livePrivacyResult}</dd></div></dl>
        <p className="gt-panel-note">These are synthetic seeded records. Offline checks inspect proposed redacted payloads and receipt hashes; live provider privacy is deferred. Detection is rules based and can miss unrecognized sensitive data.</p>
        <div className="gt-pii-secondary"><span>Company-question PII occurrences processed</span><strong>{formatCount(rag?.summary.piiItemsRedacted)}</strong></div>
      </aside>
    </div>

    <section className="gt-panel gt-chain" aria-labelledby="gt-chain-title">
      <div className="gt-section-heading"><div><span className="gt-eyebrow">Signed receipts</span><h2 id="gt-chain-title">Follow the local chain.</h2></div><button type="button" className="gt-verify-button" onClick={verify} disabled={verifying}><ShieldIcon />{verifying ? 'Verifying…' : 'Verify receipts'}</button></div>
      <div className="gt-chain-status" aria-live="polite"><span className={`gt-verification-mark ${chain?.valid ? 'gt-verified' : chain ? 'gt-broken' : ''}`}><ShieldIcon /></span><div><strong>{chain ? chain.valid ? `${formatCount(chain.signaturesVerified)} signatures verified. ${formatCount(chain.breaks)} breaks found.` : `${formatCount(chain.breaks)} verification breaks require review.` : 'Receipt verification is pending.'}</strong><p>{chain ? `${formatCount(chain.chained)} linked entries · ${formatCount(chain.payloadHashesVerified)} payload snapshots checked · ${formatCount(chain.headsVerified)} ledger heads verified` : 'Use Verify receipts to inspect the ledgers on this machine.'}</p></div><span className="gt-verified-at">{verifiedNow ? 'Verified now' : 'Recorded verification'}<small>{formatDate(verification?.timestamp)}</small></span></div>
      {verificationError && <p className="gt-error" role="alert">{verificationError}</p>}
      {chain && !chain.completeChainCoverage && <div className="gt-coverage-note"><strong>Legacy coverage is incomplete.</strong><span>{formatCount(chain.legacyUnchained)} earlier signed entries predate the linked chain. {formatCount(chain.legacyPayloadSnapshotsMissing)} historical payload snapshots are unavailable. A valid signature does not fill those gaps.</span></div>}
      {verification?.ledgers.some(ledger => ledger.breaks.length > 0) && <ul className="gt-break-list">{verification.ledgers.flatMap(ledger => ledger.breaks.map((issue, i) => <li key={`${ledger.ledger}-${i}`}><strong>{ledger.ledger}</strong> · {issue.code}{issue.sequence != null ? ` · entry ${formatCount(issue.sequence)}` : ''}</li>))}</ul>}
      <div className="gt-ledger-toolbar"><label>Ledger<select value={ledgerFilter} onChange={event => setLedgerFilter(event.target.value)}><option value="all">All local ledgers</option>{verification?.ledgers.map(ledger => <option value={ledger.ledger} key={ledger.ledger}>{ledger.ledger === '.' ? 'Company gateway' : ledger.ledger}</option>)}</select></label><span>{formatCount(ledgerRows.length)} recorded entries</span></div>
      {ledgerRows.length > 0 ? <div className="gt-chain-scroll"><table className="gt-table gt-receipt-table"><thead><tr><th>Entry / run ID</th><th>Responder</th><th>Signature</th><th>Chain link</th><th>Payload hash</th></tr></thead><tbody>{ledgerRows.map(({ ledger, entry }) => <tr key={`${ledger}-${entry.sequence}-${entry.runId}`}><td><span className="gt-sequence">{formatCount(entry.sequence)}</span><EntryHash entry={entry} /><small>{ledger === '.' ? 'Company gateway' : ledger}</small></td><td><strong>{modelLabel(entry.modelId)}</strong><small>{entry.status.replaceAll('_', ' ')}</small></td><td><span className={entry.signatureVerified ? 'gt-text-verified' : 'gt-alert-number'}>{entry.signatureVerified ? 'Verified' : 'Failed'}</span></td><td><span className={entry.chained ? 'gt-text-verified' : 'gt-legacy'}>{entry.chained ? 'Linked' : 'Legacy'}</span></td><td><span className={entry.payloadVerified ? 'gt-text-verified' : entry.chained ? 'gt-alert-number' : 'gt-legacy'}>{entry.payloadVerified ? 'Verified' : entry.chained ? 'Unverified' : 'No snapshot'}</span></td></tr>)}</tbody></table></div> : <p className="gt-empty">Pending. Receipt entries will appear after a measured handoff proposal or completed handoff.</p>}
      <p className="gt-panel-note">Verification checks local signatures, chain links, anchored heads and available payload hashes. It makes no model call. Deferred receipts record proposed evidence and do not prove that a cloud request was delivered.</p>
    </section>

    <section className="gt-panel gt-redteam" aria-labelledby="gt-redteam-title"><div className="gt-section-heading"><div><span className="gt-eyebrow">Local-only red-team sweep</span><h2 id="gt-redteam-title">Keep the misses in view.</h2></div><span className="gt-source-label">{safety ? `${formatCount(safety.items)} prompts · ${safety.modelId}` : 'Pending'}</span></div>
      <div className="gt-redteam-grid"><article><span>Harmful prompts blocked</span><strong>{formatPercent(safety?.strongreject.blockRate)}</strong><p>{safety ? `${formatCount(safety.strongreject.blocks)} of ${formatCount(safety.strongreject.classified)} StrongREJECT prompts classified unsafe` : 'StrongREJECT classification is pending'}</p><div className="gt-result-bar" aria-hidden="true"><i style={{ width: `${(safety?.strongreject.blockRate ?? 0) * 100}%` }} /></div></article><article><span>Safe prompts over-blocked</span><strong className={safety && safety.falseRefusals > 0 ? 'gt-alert-number' : ''}>{formatPercent(safety?.falseRefusalRate)}</strong><p>{safety ? `${formatCount(safety.falseRefusals)} of ${formatCount(safety.xstest.classified)} safe XSTest prompts were blocked` : 'Safe-prompt classification is pending'}</p><div className="gt-result-bar gt-overblock-bar" aria-hidden="true"><i style={{ width: `${(safety?.falseRefusalRate ?? 0) * 100}%` }} /></div></article><article><span>Prompts leaked to cloud</span><strong className={safety?.leaks.promptLeaksToCloud === 0 ? 'gt-good-number' : ''}>{formatCount(safety?.leaks.promptLeaksToCloud)}</strong><p>{safety ? `${formatCount(safety.leaks.cloudRequests)} cloud requests in the local-only sweep` : 'Network-boundary measurements are pending'}</p><div className="gt-local-rule"><ShieldIcon /><span>Harmful prompts remain local</span></div></article></div>
      {safety && safety.unsafePasses > 0 && <div className="gt-misses-note"><strong>{formatCount(safety.unsafePasses)} harmful prompts passed Guard.</strong><span>These are failed safety detections. The local-only network boundary still prevented cloud disclosure.</span></div>}
      <p className="gt-panel-note">{safety?.falseRefusalMeasurement ?? 'False-refusal measurement is pending.'} Answer-model refusal rate: {safety?.localAnswerRefusalRate == null ? 'Pending — no local answer model was evaluated in this sweep.' : formatPercent(safety.localAnswerRefusalRate)}</p>
    </section>
  </motion.div>;
}
