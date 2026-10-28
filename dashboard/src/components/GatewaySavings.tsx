import { useState } from 'react';
import { motion } from 'framer-motion';
import { useMotionPreference } from '../hooks/useMotionPreference';
import { getRound, formatCount, formatLatency, formatMoney, formatPercent, type GatewayResults } from '../gatewayTypes';
import './GatewaySavings.css';
import { ComparisonSavings } from './ComparisonSavings';
import type { ComparisonReport } from '../comparisonTypes';
import {Stage4Results} from './Stage4Results';
import type {Stage4Report} from '../stage4Types';
import type {Stage5GuardReport} from '../stage5Types';

const usable = (value: number | null | undefined): value is number => typeof value === 'number' && Number.isFinite(value);

export function GatewaySavings({ data, comparison = null, stage4, stage5, routingEnabled }: { data: GatewayResults | null; comparison?: ComparisonReport | null; stage4?: Stage4Report | null; stage5?: Stage5GuardReport | null; routingEnabled?: boolean | null }) {
  return <>{stage4===undefined?<ComparisonSavings report={comparison}/>:<><Stage4Results report={stage4} initialTab="costs" stage5={stage5} routingEnabled={routingEnabled}/><details className="cmp-legacy"><summary>Earlier model matrix and cost audit</summary><ComparisonSavings report={comparison}/></details></>}<details className="cmp-legacy"><summary>Earlier company-data cost evidence</summary><LegacySavings data={data}/></details></>;
}
function LegacySavings({ data }: { data: GatewayResults | null }) {
  const round = getRound(data, 2);
  const measured = round?.summary;
  const pricing = data?.pricing;
  const unit = pricing?.queriesPerComparison;
  const [selectedVolume, setSelectedVolume] = useState<number | null>(null);
  const reduced = useMotionPreference() ?? false;
  const volume = selectedVolume ?? (unit ? unit * 100 : 0);
  const complete = measured?.projectionsComplete === true && usable(unit) && unit > 0;
  const handoff = complete && usable(measured?.estimatedHandoffPer1000Usd) ? measured.estimatedHandoffPer1000Usd : null;
  const allCloud = complete && usable(measured?.estimatedAllCloudPer1000Usd) ? measured.estimatedAllCloudPer1000Usd : null;
  const scale = Math.max(handoff ?? 0, allCloud ?? 0);
  const monthlyHandoff = handoff !== null && unit ? handoff / unit * volume : null;
  const monthlyAllCloud = allCloud !== null && unit ? allCloud / unit * volume : null;
  const monthlySaving = monthlyHandoff !== null && monthlyAllCloud !== null ? monthlyAllCloud - monthlyHandoff : null;
  const monthlyLocalQuestions = usable(measured?.localAnswerRate) && unit ? measured.localAnswerRate * volume : null;
  const projectedTokens = complete && usable(measured?.projectedTokensKeptLocalPer1000) && unit ? measured.projectedTokensKeptLocalPer1000 / unit * volume : null;
  const offline = round?.status.includes('offline');
  const transition = reduced ? { duration: 0 } : { duration: 0.45, ease: 'easeOut' as const };

  return <section className="gs-view" aria-labelledby="gs-title">
    <header className="gs-heading">
      <div><span className="gs-eyebrow">Savings</span><h1 id="gs-title">Keep the knowledge.<br />Reduce the cloud bill.</h1><p>Routine questions stay with local Llama. See what that changes for your monthly question volume.</p></div>
      <div className="gs-source"><span className={round ? 'gs-source-dot' : 'gs-source-dot gs-source-pending'} />{round ? <><strong>Measured on company demo data</strong><small>{formatCount(measured?.items)} questions · Round {round.round}</small><time dateTime={round.timestamp}>{new Date(round.timestamp).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}</time></> : <><strong>Evaluation pending</strong><small>Run the company-data round to populate this view.</small></>}</div>
    </header>

    <section className="gs-cost-comparison" aria-labelledby="gs-cost-title">
      <div className="gs-section-title"><div><span className="gs-eyebrow">One workload, two approaches</span><h2 id="gs-cost-title">Cost per {formatCount(unit)} queries</h2></div><span className="gs-assumption-tag">Pricing assumptions</span></div>
      <div className="gs-cost-chart" role="img" aria-label={`Assumed cost per ${formatCount(unit)} queries: Handoff ${formatMoney(handoff, 4)}, all-cloud ${formatMoney(allCloud, 4)}.`}>
        <div className="gs-cost-row"><div className="gs-cost-label"><strong>Handoff</strong><span>Local Llama, Muse Spark when needed</span></div><div className="gs-bar-track"><motion.span className="gs-bar gs-bar-handoff" initial={false} animate={{ scaleX: scale && handoff !== null ? handoff / scale : 0 }} transition={transition} /></div><strong className="gs-cost-amount">{formatMoney(handoff, 4)}</strong></div>
        <div className="gs-cost-row"><div className="gs-cost-label"><strong>All-cloud</strong><span>Muse Spark for every question</span></div><div className="gs-bar-track"><motion.span className="gs-bar gs-bar-cloud" initial={false} animate={{ scaleX: scale && allCloud !== null ? allCloud / scale : 0 }} transition={transition} /></div><strong className="gs-cost-amount">{formatMoney(allCloud, 4)}</strong></div>
      </div>
      <div className="gs-cost-caption"><p>{complete ? <><strong>{formatPercent(measured?.projectedSavingRate)} projected saving.</strong> Handoff includes {formatMoney(measured?.estimatedLocalAllowancePer1000Usd)} of assumed local electricity and hardware allocation per {formatCount(unit)} queries. All-cloud shows assumed API cost.</> : 'Cost projection pending. A complete company-data evaluation and pricing configuration are required.'}</p><p>Both approaches use the same question mix. The all-cloud comparison sends the full retrieved context on every query.</p></div>
    </section>

    <section className="gs-volume-section" aria-labelledby="gs-volume-title">
      <div className="gs-volume-controls"><span className="gs-eyebrow">Explore your volume</span><h2 id="gs-volume-title">How many questions<br />in a month?</h2><div className="gs-volume-label"><label htmlFor="gs-volume">Monthly queries</label><output htmlFor="gs-volume">{unit ? formatCount(volume) : 'Pending'}</output></div><input id="gs-volume" type="range" min={unit ?? 0} max={(unit ?? 1) * 1000} step={unit ?? 1} value={volume} disabled={!complete} onChange={event => setSelectedVolume(Number(event.target.value))} aria-valuetext={`${formatCount(volume)} monthly queries`} /><div className="gs-range-ends"><span>{formatCount(unit)}</span><span>{unit ? formatCount(unit * 1000) : 'Pending'}</span></div><p>Adjust the volume to explore a projection. The measured local-answer share and pricing assumptions stay fixed.</p></div>
      <div className="gs-monthly-projection" aria-live="polite" aria-atomic="true"><span>Projected monthly saving</span><motion.strong key={monthlySaving} initial={reduced ? false : { opacity: 0.6, y: 3 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: reduced ? 0 : 0.18 }}>{formatMoney(monthlySaving)}</motion.strong><div className="gs-monthly-costs"><span>Handoff <b>{formatMoney(monthlyHandoff)}</b></span><span>All-cloud <b>{formatMoney(monthlyAllCloud)}</b></span></div><p>{monthlyLocalQuestions !== null ? <><strong>About {formatCount(monthlyLocalQuestions)} questions</strong> would be answered on this machine.</> : 'The local-answer projection is pending.'}</p><small>Forecast from the recorded synthetic workload. Actual usage, answer length, hardware costs and provider pricing can differ.</small></div>
    </section>

    <section className="gs-local-section" aria-labelledby="gs-local-title">
      <div className="gs-local-intro"><span className="gs-eyebrow">What stays on your machine</span><h2 id="gs-local-title">The local share<br />does the work.</h2><p>Measured routing and latency come from the company-data round. Token savings below are a projection against the all-cloud context.</p></div>
      <dl className="gs-local-measurements"><div><dt>Questions answered locally</dt><dd>{formatPercent(measured?.localAnswerRate)}</dd><small>{formatPercent(measured?.handoffRate)} requested a handoff.</small></div><div><dt>Local processing latency</dt><dd>{formatLatency(measured?.medianLatencyMs)} <em>median</em></dd><small>{formatLatency(measured?.p95LatencyMs)} p95 · deferred cloud completion excluded.</small></div><div><dt>Projected input tokens kept local</dt><dd>{formatCount(projectedTokens)}</dd><small>At your selected monthly volume, compared with sending the full retrieved context each time.</small></div></dl>
    </section>

    {data?.baseline && <p className="gs-baseline">Historical Finkd reference: {formatLatency(data.baseline.medianLatencyMs)} median latency · {formatPercent(data.baseline.handoffRate)} handoffs. Different datasets and safety method; this is a descriptive reference.</p>}

    <details className="gs-assumptions"><summary>See the pricing assumptions and measurement scope <span aria-hidden="true">+</span></summary><div className="gs-assumptions-content"><div><h3>Muse Spark assumptions</h3><dl><div><dt>Input, per million tokens</dt><dd>{formatMoney(pricing?.museInputPerMillionUsd)}</dd></div><div><dt>Output, per million tokens</dt><dd>{formatMoney(pricing?.museOutputPerMillionUsd)}</dd></div><div><dt>Expected output tokens per query</dt><dd>{formatCount(pricing?.expectedOutputTokens)}</dd></div><div><dt>Local allocation per query</dt><dd>{formatMoney(pricing?.localPerQueryUsd, 4)}</dd></div></dl><p>{pricing?.label ?? 'Pricing configuration pending.'}</p></div><div><h3>What was measured</h3><p>{round ? <>{formatCount(measured?.items)} synthetic company questions were evaluated, with {formatCount(measured?.deferred)} cloud answers deferred. {offline ? <>This round ran offline: {formatCount(measured?.actualCloudCalls)} cloud requests and {formatCount(measured?.tokensSentToCloud)} tokens sent.</> : 'See the round record for actual cloud usage.'}</> : 'The company-data evaluation has not run yet.'}</p><p>Deferred handoffs are included in the cost projection as if eventually sent. The comparison is an assumed cost model; it does not represent a provider invoice.</p><p className="gs-provenance">Source: Round {round?.round ?? 'pending'} JSON · pricing configuration from the recorded run.</p></div></div></details>
  </section>;
}
