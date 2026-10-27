import { useMotionPreference } from "../hooks/useMotionPreference";
import { animate, motion, useInView } from "framer-motion";
import { memo, useEffect, useRef, useState, type CSSProperties } from "react";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BenchmarkData, PairingId } from "../types";
import "./ResultsPanel.css";

interface ResultsPanelProps {
  data: BenchmarkData;
  activePairing: PairingId;
  onSelectPairing(id: PairingId): void;
}

const colors: Record<PairingId, string> = {
  "meta-meta": "#B87513",
  "meta-grok": "#0866FF",
  "gemma-meta": "#087E8B",
  "gemma-grok": "#15845E",
};

const benchmarkNames: Record<string, string> = {
  ifeval: "IFEval",
  gpqa: "GPQA",
  "mmlu-pro": "MMLU-Pro",
  strongreject: "StrongREJECT",
  xstest: "XSTest",
  "ad-privacy": "Ad privacy",
};

const suiteColors = ["#0866FF", "#087E8B", "#B87513", "#15845E", "#6950C8", "#C34865"];
const easeOut = [0.22, 1, 0.36, 1] as const;

function CountNumber({ value, suffix = "", prefix = "", decimals = 1, start }: { value: number; suffix?: string; prefix?: string; decimals?: number; start: boolean }) {
  const reduced = useMotionPreference();
  const [display, setDisplay] = useState(reduced ? value : 0);
  useEffect(() => {
    if (!start) return;
    if (reduced) { setDisplay(value); return; }
    const animation = animate(0, value, { duration: 1, ease: easeOut, onUpdate: setDisplay });
    return () => animation.stop();
  }, [start, value, reduced]);
  return <span aria-label={`${prefix}${value.toFixed(decimals)}${suffix}`}>{prefix}{display.toLocaleString("en-US", { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}{suffix}</span>;
}

function Sparkline({ values, color }: { values: Array<number | null>; color: string }) {
  // Null scores break the line. Deferred results never become a zero point.
  const segments: string[] = [];
  let current = "";
  values.forEach((value, index) => {
    if (value === null) { if (current) segments.push(current); current = ""; return; }
    current += `${current ? " L" : "M"}${12 + index * 32},${48 - value * 0.36}`;
  });
  if (current) segments.push(current);
  return <svg className="result-sparkline" viewBox="0 0 184 58" aria-hidden="true">
    <path d="M12 48H172" stroke="currentColor" strokeOpacity=".1" fill="none" />
    {segments.map((d, index) => <path key={index} d={d} fill="none" stroke={color} strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" />)}
    {values.map((value, index) => value === null ? null : <circle key={index} cx={12 + index * 32} cy={48 - value * 0.36} r="3" fill={color} stroke="var(--surface, white)" strokeWidth="1.5" />)}
  </svg>;
}

interface ChartSeries { key: string; name: string; color: string }
type ChartRow = { label: string; [key: string]: string | number | null };

function ScoreTooltip({ active, label, rows, series }: { active?: boolean; label?: string | number; rows: ChartRow[]; series: ChartSeries[] }) {
  if (!active) return null;
  const row = rows.find(item => item.label === label);
  if (!row) return null;
  return <div className="result-tooltip"><strong>{label}</strong>{series.map(item => {
    const value = row[item.key];
    return <div key={item.key}><span><i style={{ background: item.color }} />{item.name}</span><b>{typeof value === "number" ? `${value.toFixed(1)}%` : "Unavailable"}</b></div>;
  })}</div>;
}

function ScoreBar(props: Record<string, unknown> & { index?: number }, reduced: boolean, seriesIndex: number) {
  const { x, y, width, height, fill } = props as { x?: number; y?: number; width?: number; height?: number; fill?: string };
  if (x === undefined || y === undefined || !width || !height) return <g />;
  return <rect x={x} y={y} width={width} height={height} rx={Math.min(6, width / 2)} fill={fill}
    className={`score-bar${reduced ? " is-static" : ""}`}
    style={{ "--bar-delay": `${seriesIndex * 0.045 + (props.index ?? 0) * 0.025}s` } as CSSProperties} />;
}

function ResultsPanelView({ data, activePairing, onSelectPairing }: ResultsPanelProps) {
  const [grouping, setGrouping] = useState<"benchmark" | "pairing">("benchmark");
  const reduced = useMotionPreference() ?? false;
  const sectionRef = useRef<HTMLElement>(null);
  const chartRef = useRef<HTMLDivElement>(null);
  const entered = useInView(sectionRef, { once: true, amount: 0.15 });
  const chartEntered = useInView(chartRef, { once: true, amount: 0.2 });
  const completion = data.progress.completed / data.progress.total;
  const suiteKeys = Object.keys(benchmarkNames);
  const series: ChartSeries[] = grouping === "benchmark"
    ? data.pairings.map(pairing => ({ key: pairing.id, name: pairing.name, color: colors[pairing.id] }))
    : suiteKeys.map((suite, index) => ({ key: suite, name: benchmarkNames[suite], color: suiteColors[index] }));
  const chartData: ChartRow[] = grouping === "benchmark"
    ? suiteKeys.map(suite => ({ label: benchmarkNames[suite], ...Object.fromEntries(data.pairings.map(pairing => [pairing.id, pairing.benchmarks[suite]])) }))
    : data.pairings.map(pairing => ({ label: pairing.name, ...pairing.benchmarks }));

  return (
    <section ref={sectionRef} className="results-section premium-results" aria-labelledby="results-heading">
      <div className="results-heading-row">
        <div><span className="eyebrow">The evidence</span><h2 id="results-heading">Local first. Measurably.</h2><p>Real benchmark results. Six suites, four pairings, one fixed seed.</p></div>
        <div className="progress-summary">
          <div className="progress-ring" role="img" aria-label={`${data.progress.completed} of ${data.progress.total} complete`} style={{ "--completion": `${completion * 360}deg` } as CSSProperties}><div><strong>{Math.round(completion * 100)}<span>%</span></strong></div></div>
          <div><strong><CountNumber value={data.progress.completed} decimals={0} start={entered} /> <span>/ {data.progress.total.toLocaleString()}</span></strong><span>complete</span><p>{data.progress.deferred} deferred pending Meta access</p></div>
        </div>
      </div>

      <div className="pairing-cards">
        {data.pairings.map((pairing, index) => (
          <motion.button key={pairing.id} type="button" className={`pairing-card ${pairing.id === activePairing ? "active" : ""}`}
            style={{ "--pairing-color": colors[pairing.id] } as CSSProperties}
            onClick={() => onSelectPairing(pairing.id)} aria-pressed={pairing.id === activePairing}
            initial={reduced ? false : { opacity: 0, y: 18 }} whileInView={{ opacity: 1, y: 0 }} viewport={{ once: true, amount: 0.15 }}
            transition={{ duration: reduced ? 0 : 0.5, delay: reduced ? 0 : index * 0.07, ease: easeOut }}>
            <div className="pairing-card-head"><div><strong>{pairing.name}</strong><small>{pairing.localModel} → {pairing.cloudModel}</small></div><span className="pairing-selected" aria-hidden="true">{pairing.id === activePairing ? "✓" : "↗"}</span></div>
            <div className="pairing-primary"><strong><CountNumber value={pairing.accuracy} suffix="%" start={entered} /></strong><span>Covered accuracy</span><Sparkline values={suiteKeys.map(key => pairing.benchmarks[key])} color={colors[pairing.id]} /></div>
            <div className="pairing-metrics">
              <div><strong><CountNumber value={pairing.handoffRate} suffix="%" start={entered} /></strong><span>Handoff rate</span></div>
              <div><strong><CountNumber value={pairing.medianLatencyMs / 1000} suffix="s" start={entered} /></strong><span>Median latency</span></div>
              <div><strong><CountNumber value={pairing.estimatedCostSavedUsd} prefix="$" decimals={2} start={entered} /></strong><span>Est. cost saved</span></div>
            </div>
          </motion.button>
        ))}
      </div>

      <div className={`chart-card${chartEntered ? " chart-visible" : ""}`} ref={chartRef}>
        <div className="chart-heading"><div><strong>Every benchmark, in perspective</strong><span>Accuracy across the available results. Deferred cells stay empty.</span></div>
          <div className="results-segmented" role="group" aria-label="Chart grouping"><button type="button" aria-pressed={grouping === "benchmark"} onClick={() => setGrouping("benchmark")}>By benchmark</button><button type="button" aria-pressed={grouping === "pairing"} onClick={() => setGrouping("pairing")}>By pairing</button></div>
        </div>
        <div className="chart-area" aria-label={`Accuracy grouped by ${grouping}`}>
          <ResponsiveContainer width="100%" height="100%">
            <BarChart key={grouping} data={chartData} margin={{ top: 15, right: 12, left: -8, bottom: 5 }} barGap={5} accessibilityLayer>
              <defs>{series.map(item => <linearGradient key={item.key} id={`score-${item.key}`} x1="0" y1="0" x2="0" y2="1"><stop offset="0%" stopColor={item.color} /><stop offset="100%" stopColor={item.color} stopOpacity={0.66} /></linearGradient>)}</defs>
              <CartesianGrid stroke="var(--chart-grid, #E9EDF2)" strokeDasharray="3 5" vertical={false} />
              <XAxis dataKey="label" tick={{ fill: "var(--text-muted, #475569)", fontSize: 13, fontWeight: 550 }} axisLine={false} tickLine={false} dy={10} interval={0} height={44} />
              <YAxis domain={[0, 100]} ticks={[0, 25, 50, 75, 100]} tick={{ fill: "var(--text-muted, #475569)", fontSize: 13 }} axisLine={false} tickLine={false} tickFormatter={value => `${value}%`} width={52} />
              <Tooltip cursor={{ fill: "rgba(8,102,255,0.035)", radius: 8 }} content={<ScoreTooltip rows={chartData} series={series} />} />
              {series.map((item, index) => <Bar key={item.key} dataKey={item.key} fill={`url(#score-${item.key})`} maxBarSize={25} isAnimationActive={false} shape={props => ScoreBar(props as unknown as Record<string, unknown>, reduced, index)} />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
        <div className="results-chart-legend" aria-label="Chart legend">{series.map(item => <span key={item.key}><i style={{ background: item.color }} />{item.name}</span>)}</div>
      </div>

      <div className="results-provenance"><span>Interim results</span><p>Seed {data.seed} · Loaded from {data.generatedFrom}</p><details><summary>View score table</summary><div className="results-table-scroll"><table><caption>Benchmark scores, percent. Empty cells are unavailable.</caption><thead><tr><th scope="col">Pairing</th>{suiteKeys.map(key => <th scope="col" key={key}>{benchmarkNames[key]}</th>)}</tr></thead><tbody>{data.pairings.map(pairing => <tr key={pairing.id}><th scope="row">{pairing.name}</th>{suiteKeys.map(key => <td key={key} title={pairing.benchmarks[key] === null ? "Unavailable" : undefined} aria-label={pairing.benchmarks[key] === null ? "Unavailable" : undefined}>{pairing.benchmarks[key] === null ? <span className="score-unavailable" aria-hidden="true" /> : `${pairing.benchmarks[key].toFixed(1)}%`}</td>)}</tr>)}</tbody></table></div></details></div>
    </section>
  );
}

// Playback advances every frame. Keep the independent chart from remounting its
// custom SVG shapes on each replay tick and restarting their entry animation.
export const ResultsPanel = memo(ResultsPanelView);
