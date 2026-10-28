import { motion } from 'framer-motion';
import { useMotionPreference } from '../hooks/useMotionPreference';
import { formatCount, formatLatency, formatMoney, formatPercent, getRound, type GatewayResults, type RoundOneArm } from '../gatewayTypes';
import './GatewayBenchmarks.css';
import { ComparisonBenchmarks } from './ComparisonBenchmarks';
import type { ComparisonReport } from '../comparisonTypes';
import {Stage4Results} from './Stage4Results';
import type {Stage4Report} from '../stage4Types';

const suiteNames: Record<string, string> = {
  ifeval: 'IFEval', gpqa: 'GPQA', 'mmlu-pro': 'MMLU-Pro', strongreject: 'StrongREJECT', xstest: 'XSTest', 'ad-privacy': 'Ad privacy',
};
const cloudLabel = (model: string) => model === 'muse-spark-1.3' ? 'Muse Spark' : model.startsWith('x-ai/grok-') ? `Grok ${model.slice('x-ai/grok-'.length)}` : model;
const percentagePoints = (value: number | null | undefined) => value == null || !Number.isFinite(value) ? 'Pending' : `${value > 0 ? '+' : ''}${value.toFixed(1)} pp`;
const guardCalls = (arm: RoundOneArm | undefined) => arm ? Object.entries(arm.steps).filter(([key]) => key.toLowerCase().includes('guard')).reduce((total, [, step]) => total + step.count, 0) : null;

export function GatewayBenchmarks({ data, comparison = null, stage4 }: { data: GatewayResults | null; comparison?: ComparisonReport | null; stage4?: Stage4Report | null }) {
  const reduced = useMotionPreference();
  const roundOne = getRound(data, 1), roundTwo = getRound(data, 2);
  const withGuard = roundOne?.summary.withGuard, withoutGuard = roundOne?.summary.withoutGuard;
  const historical = data?.historical, pairings = historical?.pairings ?? [];
  const suiteIds = [...new Set(pairings.flatMap(pairing => Object.keys(pairing.benchmarks)))];
  const finkd = pairings.find(pairing => pairing.id === 'meta-meta');
  const screens = guardCalls(withGuard);
  const maxHistoricalLatency = Math.max(0, ...pairings.map(pairing => pairing.medianLatencyMs));
  const queryUnit = data?.pricing ? formatCount(data.pricing.queriesPerComparison) : null;
  const enter = { initial: { opacity: 0, y: reduced ? 0 : 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: reduced ? 0 : 0.35 } };

  return <div className="gb-view">
    {stage4===undefined?<ComparisonBenchmarks report={comparison}/>:<><Stage4Results report={stage4}/><details className="cmp-legacy"><summary>Earlier model matrix and Tier 0 cost audit</summary><ComparisonBenchmarks report={comparison}/></details></>}
    <details className="cmp-legacy"><summary>Earlier gateway testing rounds and historical evidence</summary>
    <motion.header className="gb-heading" {...enter}>
      <span className="gb-eyebrow">Benchmarks</span>
      <h1>Why Finkd is the private pipeline.</h1>
      <p>Local Llama answers over company data. Llama Guard checks the boundary. Muse Spark handles the questions that need a handoff.</p>
    </motion.header>

    <motion.section className="gb-pipeline" aria-label="Finkd pipeline choice" {...enter}>
      <div className="gb-pipeline-copy"><span className="gb-choice">The gateway choice</span><h2>Designed around what stays local.</h2><p>Finkd brings retrieval, reversible redaction and signed receipts into one path. That makes it the product pipeline. The historical results below show tradeoffs across models; they do not establish an overall accuracy winner.</p>{finkd && <code>{finkd.localModel} <span>→</span> {cloudLabel(finkd.cloudModel)}</code>}</div>
      <div className="gb-pipeline-route" aria-label="Local Llama through the safety boundary to Muse Spark"><div><span className="gb-route-icon">↳</span><strong>Llama</strong><small>Search & answer locally</small></div><span className="gb-route-arrow" aria-hidden="true">→</span><div><span className="gb-route-icon gb-route-guard">◇</span><strong>Llama Guard</strong><small>Screen & redact</small></div><span className="gb-route-arrow" aria-hidden="true">→</span><div><span className="gb-route-icon gb-route-cloud">↗</span><strong>Muse Spark</strong><small>Only when needed</small></div></div>
    </motion.section>

    <section className="gb-current" aria-labelledby="gb-current-title">
      <div className="gb-section-heading"><div><span className="gb-eyebrow">Company data · current round</span><h2 id="gb-current-title">The gateway on its own workload.</h2></div><span className="gb-source-state">{roundTwo ? roundTwo.status.replaceAll('_', ' ') : 'Pending'}</span></div>
      <div className="gb-current-values"><div><span>Answered locally</span><strong>{formatPercent(roundTwo?.summary.localAnswerRate)}</strong><small>{formatCount(roundTwo?.summary.completed)} completed / {formatCount(roundTwo?.summary.items)} questions</small></div><div><span>Handoffs requested</span><strong>{formatPercent(roundTwo?.summary.handoffRate)}</strong><small>{formatCount(roundTwo?.summary.deferred)} cloud answers deferred</small></div><div><span>Median latency</span><strong>{formatLatency(roundTwo?.summary.medianLatencyMs)}</strong><small>p95 {formatLatency(roundTwo?.summary.p95LatencyMs)}</small></div><div><span>Answer fact coverage</span><strong>{formatPercent(roundTwo?.summary.answerAccuracy)}</strong><small>Conditional on {formatCount(roundTwo?.summary.scored)} scored answers</small></div></div>
      <p className="gb-measurement-note">Offline latency measures local processing and handoff preparation. Deferred cloud completion is excluded. Answer fact coverage is an automated required-fact check, not an expert quality score.</p>
      <div className="gb-baseline"><span>Historical Finkd reference</span><strong>{formatLatency(data?.baseline?.medianLatencyMs)} <small>median</small></strong><strong>{formatPercent(data?.baseline?.handoffRate)} <small>handoff</small></strong><p>Different task suites and safety method. This reference is descriptive; the difference cannot be attributed to retrieval alone.</p></div>
    </section>

    <section className="gb-guard" aria-labelledby="gb-guard-title">
      <div className="gb-section-heading"><div><span className="gb-eyebrow">With Guard / without Guard</span><h2 id="gb-guard-title">Measure the boundary where it runs.</h2></div><span className="gb-source-state">{roundOne ? `${formatCount(withGuard?.items)} questions per arm` : 'Pending'}</span></div>
      <div className="gb-table-scroll"><table className="gb-table"><caption className="gb-sr-only">Finkd with and without Llama Guard on the same saved benchmark slice</caption><thead><tr><th scope="col">Finkd arm</th><th scope="col">Accuracy</th><th scope="col">Handoff</th><th scope="col">Median</th><th scope="col">p95</th><th scope="col">Outbound blocks</th><th scope="col">Inbound flags</th><th scope="col">Assumed saving{queryUnit ? ` / ${queryUnit}` : ''}</th></tr></thead><tbody>{([['With Guard', withGuard], ['Without Guard', withoutGuard]] as const).map(([label, arm]) => <tr key={label}><th scope="row">{label}<small>{formatCount(arm?.scored)} scored / {formatCount(arm?.items)} items</small></th><td>{formatPercent(arm?.accuracy)}</td><td>{formatPercent(arm?.handoffRate)}</td><td>{formatLatency(arm?.medianLatencyMs)}</td><td>{formatLatency(arm?.p95LatencyMs)}</td><td>{formatCount(arm?.outboundBlocked)}</td><td>{formatCount(arm?.inboundFlagged)}</td><td>{formatMoney(arm?.projectedSavingPer1000Usd)}</td></tr>)}</tbody></table></div>
      <div className="gb-guard-readout"><div><span>Measured boundary screens</span><strong>{formatCount(screens)}</strong></div><div><span>Added Guard time / question</span><strong>{formatLatency(roundOne?.summary.comparison.addedGuardLatencyMsPerQuestion)}</strong></div><div><span>Median Guard time / screen</span><strong>{formatLatency(withGuard?.medianGuardLatencyMsPerScreen)}</strong></div><div><span>Change in handoff rate</span><strong>{percentagePoints(roundOne?.summary.comparison.handoffRateChangePercentagePoints)}</strong></div></div>
      {screens === 0 ? <p className="gb-coverage-notice"><strong>Guard overhead is not measured on this slice.</strong> Every question was answered locally, so the boundary was never exercised. The recorded added time per question does not estimate real screening overhead. Per-screen latency and inbound cloud checks remain pending.</p> : <p className="gb-measurement-note">Guard latency is measured only on boundary screens. Warm-up is excluded. Inbound flags stay pending where there was no cloud reply to screen.</p>}
      <p className="gb-measurement-note">These cost savings use the pricing assumptions and local allowance in the saved round. They are projections, not provider invoices. Accuracy is conditional on the scored slice.</p>
    </section>

    <section className="gb-history" aria-labelledby="gb-history-title">
      <div className="gb-section-heading"><div><span className="gb-eyebrow">Historical pairings · interim coverage</span><h2 id="gb-history-title">Historical (retired)</h2></div><span className="gb-source-state">{historical ? `${formatCount(historical.progress.completed)} / ${formatCount(historical.progress.total)} results` : 'Pending'}</span></div>
      <p className="gb-measurement-note">This earlier four-pairing experiment is read-only. Llamarok and Gemmok used Grok, which is retired. Live comparisons above use direct Meta and Google APIs.</p>
      <p className="gb-history-warning">{historical?.coverage.warning ?? 'Historical pairing results are pending. The comparison will appear after the saved benchmark reference is available.'}</p>
      <div className="gb-table-scroll"><table className="gb-table gb-pairing-table"><caption className="gb-sr-only">Historical pairings with unequal benchmark coverage, not a fair ranking</caption><thead><tr><th scope="col">Pairing</th><th scope="col">Available-suite mean</th><th scope="col">Suite coverage</th><th scope="col">Handoff</th><th scope="col">Median latency</th><th scope="col">Recorded total cost</th></tr></thead><tbody>{pairings.length ? pairings.map(pairing => {
        const coverage = historical?.coverage.pairings.find(item => item.id === pairing.id);
        return <tr key={pairing.id} className={pairing.id === 'meta-meta' ? 'gb-selected' : ''}><th scope="row"><span>{pairing.name}</span><small>{pairing.localModel} <b>→</b> {cloudLabel(pairing.cloudModel)}</small></th><td>{formatPercent(pairing.accuracy / 100)}</td><td>{coverage ? `${formatCount(coverage.completedSuites.length)} / ${formatCount(coverage.completedSuites.length + coverage.missingSuites.length)}` : 'Pending'}<small>{coverage?.missingSuites.length ? `Pending: ${coverage.missingSuites.map(suite => suiteNames[suite] ?? suite).join(', ')}` : coverage ? 'All saved suites represented' : 'Coverage pending'}</small></td><td>{formatPercent(pairing.handoffRate / 100)}</td><td><span>{formatLatency(pairing.medianLatencyMs)}</span><div className="gb-latency-track" aria-hidden="true"><i style={{ width: maxHistoricalLatency > 0 ? `${pairing.medianLatencyMs / maxHistoricalLatency * 100}%` : '0%' }} /></div></td><td>{formatMoney(pairing.costUsd, 4)}</td></tr>;
      }) : <tr><td colSpan={6} className="gb-pending">Pending historical pairing results</td></tr>}</tbody></table></div>
      <p className="gb-measurement-note">The mean uses only the available suite scores. A high score with missing suites does not imply better overall accuracy. Recorded total cost covers each saved slice, not a matched per-question cost. Bar lengths show saved medians; unequal coverage prevents a fair ranking.</p>

      <details className="gb-suite-detail"><summary>Inspect accuracy and missing suites</summary><div className="gb-table-scroll"><table className="gb-table gb-suite-table"><caption className="gb-sr-only">Historical per-suite accuracy with missing measurements shown as pending</caption><thead><tr><th scope="col">Pairing</th>{suiteIds.map(suite => <th key={suite} scope="col">{suiteNames[suite] ?? suite}</th>)}</tr></thead><tbody>{pairings.length ? pairings.map(pairing => <tr key={pairing.id}><th scope="row">{pairing.name}</th>{suiteIds.map(suite => <td key={suite}>{pairing.benchmarks[suite] == null ? <span className="gb-pending-label">Pending</span> : formatPercent(pairing.benchmarks[suite] / 100)}</td>)}</tr>) : <tr><td className="gb-pending">Pending</td></tr>}</tbody></table></div></details>
      <p className="gb-measurement-note">{formatCount(historical?.progress.deferred)} historical Meta items remain deferred. GPQA question text is excluded from the dashboard.</p>
    </section>

    <footer className="gb-provenance"><span>Read from saved results JSON</span><code>{data?.manifest?.runId ?? 'Pending run'}</code>{data?.manifest?.sourceCommit && <span>Source commit <code>{data.manifest.sourceCommit.slice(0, 7)}</code></span>}</footer>
    </details>
  </div>;
}
