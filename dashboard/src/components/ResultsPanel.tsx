import { motion } from "framer-motion";
import { Bar, BarChart, CartesianGrid, Legend, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { BenchmarkData, PairingId } from "../types";

interface ResultsPanelProps {
  data: BenchmarkData;
  activePairing: PairingId;
  onSelectPairing(id: PairingId): void;
}

const colors: Record<PairingId, string> = {
  "meta-meta": "#0866FF",
  "meta-grok": "#4C8DFF",
  "gemma-meta": "#8A63E8",
  "gemma-grok": "#C390FF",
};

const benchmarkNames: Record<string, string> = {
  ifeval: "IFEval",
  gpqa: "GPQA",
  "mmlu-pro": "MMLU-Pro",
  strongreject: "StrongREJECT",
  xstest: "XSTest",
  "ad-privacy": "Ad privacy",
};

export function ResultsPanel({ data, activePairing, onSelectPairing }: ResultsPanelProps) {
  const chartData = Object.keys(benchmarkNames).map((benchmark) => ({
    benchmark: benchmarkNames[benchmark],
    ...Object.fromEntries(data.pairings.map((pairing) => [pairing.id, pairing.benchmarks[benchmark]])),
  }));
  const completion = data.progress.completed / data.progress.total;

  return (
    <section className="results-section" aria-labelledby="results-heading">
      <div className="results-heading-row">
        <div>
          <span className="eyebrow">Measured, not mocked</span>
          <h2 id="results-heading">Real benchmark results</h2>
          <p>Seed {data.seed}, loaded from {data.generatedFrom}</p>
        </div>
        <div className="progress-summary">
          <div className="progress-ring" style={{ background: `conic-gradient(#0866FF ${completion * 360}deg, var(--ring-track) 0deg)` }}>
            <div><strong>{Math.round(completion * 100)}%</strong><span>complete</span></div>
          </div>
          <div><strong>{data.progress.completed.toLocaleString()} / {data.progress.total.toLocaleString()}</strong><span>{data.progress.deferred} deferred pending Meta access</span></div>
        </div>
      </div>

      <div className="pairing-cards">
        {data.pairings.map((pairing, index) => (
          <motion.button
            key={pairing.id}
            type="button"
            className={`pairing-card ${pairing.id === activePairing ? "active" : ""}`}
            onClick={() => onSelectPairing(pairing.id)}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: index * 0.06 }}
            aria-pressed={pairing.id === activePairing}
          >
            <div className="pairing-card-head"><span style={{ background: colors[pairing.id] }} /><div><strong>{pairing.name}</strong><small>{pairing.localModel} to {pairing.cloudModel}</small></div></div>
            <div className="pairing-metrics">
              <div><strong>{pairing.accuracy.toFixed(1)}%</strong><span>covered accuracy</span></div>
              <div><strong>{pairing.handoffRate.toFixed(1)}%</strong><span>handoff rate</span></div>
              <div><strong>{(pairing.medianLatencyMs / 1000).toFixed(1)}s</strong><span>median latency</span></div>
              <div><strong>${pairing.estimatedCostSavedUsd.toFixed(2)}</strong><span>est. cost saved</span></div>
            </div>
          </motion.button>
        ))}
      </div>

      <div className="chart-card">
        <div className="chart-heading"><div><strong>Accuracy by benchmark</strong><span>Unavailable deferred cells remain empty</span></div><span className="chart-unit">Score %</span></div>
        <div className="chart-area" aria-label="Benchmark comparison chart">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={chartData} margin={{ top: 12, right: 12, left: -14, bottom: 4 }}>
              <CartesianGrid stroke="var(--chart-grid)" vertical={false} />
              <XAxis dataKey="benchmark" tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <YAxis domain={[0, 100]} tick={{ fill: "var(--text-muted)", fontSize: 12 }} axisLine={false} tickLine={false} />
              <Tooltip contentStyle={{ borderRadius: 14, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)" }} />
              <Legend iconType="circle" wrapperStyle={{ fontSize: 12, paddingTop: 10 }} formatter={(value) => data.pairings.find((pairing) => pairing.id === value)?.name ?? value} />
              {data.pairings.map((pairing) => <Bar key={pairing.id} dataKey={pairing.id} fill={colors[pairing.id]} radius={[5, 5, 0, 0]} maxBarSize={18} />)}
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>
    </section>
  );
}
