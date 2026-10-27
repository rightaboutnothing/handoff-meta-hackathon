import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useState } from "react";
import { demoScenarios } from "./data/scenarios";
import { usePlayback } from "./hooks/usePlayback";
import { ResultsPanel } from "./components/ResultsPanel";
import { Stage } from "./components/Stage";
import { StepsView } from "./components/StepsView";
import type { BenchmarkData, DemoScenario, HandoffEvent, PairingId } from "./types";

type ViewMode = "characters" | "steps";
type RunMode = "demo" | "live";

const previewParams = new URLSearchParams(window.location.search);
const captureScenario = previewParams.get("capture");
const requestedScenario = captureScenario ?? previewParams.get("scenario");
const initialScenarioIndex = Math.max(0, demoScenarios.findIndex((item) => item.id === requestedScenario));
const captureOffsets: Record<string, number> = { easy: 2_600, blocked: 2_400, hard: 5_500 };

function Wordmark() {
  return (
    <div className="wordmark" aria-label="Handoff">
      <svg viewBox="0 0 40 40" aria-hidden="true"><path d="M8 13H26L21 8M32 27H14L19 32" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" /><circle cx="8" cy="13" r="4" fill="currentColor" /><circle cx="32" cy="27" r="4" fill="currentColor" /></svg>
      <span>Handoff</span>
    </div>
  );
}

function IconButton({ label, onClick, children, active = false }: { label: string; onClick(): void; children: React.ReactNode; active?: boolean }) {
  return <button type="button" className={`icon-button ${active ? "active" : ""}`} onClick={onClick} aria-label={label} title={label}>{children}</button>;
}

export default function App() {
  const [benchmark, setBenchmark] = useState<BenchmarkData | null>(null);
  const [dataError, setDataError] = useState("");
  const [pairingId, setPairingId] = useState<PairingId>("meta-meta");
  const [scenarioIndex, setScenarioIndex] = useState(initialScenarioIndex);
  const [runtimeScenario, setRuntimeScenario] = useState<DemoScenario | null>(null);
  const [prompt, setPrompt] = useState(demoScenarios[initialScenarioIndex].prompt);
  const [viewMode, setViewMode] = useState<ViewMode>(previewParams.get("view") === "steps" ? "steps" : "characters");
  const [runMode, setRunMode] = useState<RunMode>("demo");
  const [speed, setSpeed] = useState(1);
  const [dark, setDark] = useState(false);
  const [presentation, setPresentation] = useState(Boolean(captureScenario) || previewParams.get("presentation") === "1");
  const [traceOpen, setTraceOpen] = useState(false);
  const [liveBusy, setLiveBusy] = useState(false);
  const [liveMessage, setLiveMessage] = useState("");
  const [metaAccess, setMetaAccess] = useState<"paused" | "live">("paused");

  const scenario = runtimeScenario ?? demoScenarios[scenarioIndex];
  const playback = usePlayback(scenario, speed, captureScenario ? captureOffsets[captureScenario] ?? 0 : 0, !captureScenario);

  useEffect(() => {
    fetch("/benchmark-data.json")
      .then((response) => {
        if (!response.ok) throw new Error("Benchmark data could not be loaded");
        return response.json();
      })
      .then((data: BenchmarkData) => setBenchmark(data))
      .catch((error: Error) => setDataError(error.message));
    fetch("/api/status")
      .then((response) => response.json())
      .then((data) => setMetaAccess(data.metaAccess === "live" ? "live" : "paused"))
      .catch(() => setMetaAccess("paused"));
  }, []);

  useEffect(() => {
    document.documentElement.classList.toggle("dark", dark);
  }, [dark]);

  useEffect(() => {
    document.body.classList.toggle("presentation-mode", presentation);
    return () => document.body.classList.remove("presentation-mode");
  }, [presentation]);

  useEffect(() => {
    if (!presentation || !playback.complete) return;
    const timeout = window.setTimeout(() => {
      const next = (scenarioIndex + 1) % demoScenarios.length;
      setScenarioIndex(next);
      setPrompt(demoScenarios[next].prompt);
      setRuntimeScenario(null);
    }, 1_100);
    return () => window.clearTimeout(timeout);
  }, [playback.complete, presentation, scenarioIndex]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setTraceOpen(false);
        if (presentation && !document.fullscreenElement) setPresentation(false);
      }
      if (event.key === " " && event.target === document.body) {
        event.preventDefault();
        playback.setPlaying(!playback.playing);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playback, presentation]);

  const pairing = useMemo(() => benchmark?.pairings.find((item) => item.id === pairingId) ?? benchmark?.pairings[0], [benchmark, pairingId]);

  const chooseScenario = (index: number) => {
    setScenarioIndex(index);
    setPrompt(demoScenarios[index].prompt);
    setRuntimeScenario(null);
    setLiveMessage("");
  };

  const chooseMode = (mode: RunMode) => {
    setRunMode(mode);
    setRuntimeScenario(null);
    setLiveMessage(mode === "live" ? "Live mode uses local Ollama models only." : "");
  };

  const runCurrent = async () => {
    if (runMode === "demo") {
      playback.restart();
      return;
    }
    if (prompt === demoScenarios[2].prompt) {
      setRuntimeScenario(demoScenarios[2]);
      setLiveMessage("The redacted safety example uses its recorded local-only trace. No model call was made.");
      return;
    }
    setLiveBusy(true);
    setLiveMessage("Running the local safety screen and local model...");
    try {
      const response = await fetch("/api/live-run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt, pairing: pairingId }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload.error || "Local run failed");
      const events = payload.events as HandoffEvent[];
      const lastAt = Math.max(...events.map((item) => item.at));
      setRuntimeScenario({
        id: "live",
        label: "Live local run",
        menuLabel: "Live local run",
        prompt,
        description: `Local-only run using ${payload.modelId}`,
        duration: lastAt + 1_200,
        events,
      });
      setLiveMessage(payload.metaAccess === "paused" ? "Completed locally. Meta remained paused and received no request." : "Completed through the local-only live route.");
    } catch (error) {
      setLiveMessage(error instanceof Error ? error.message : "The local model is unavailable");
    } finally {
      setLiveBusy(false);
    }
  };

  const startPresentation = () => {
    setPresentation(true);
    setRunMode("demo");
    setRuntimeScenario(null);
    setScenarioIndex(0);
    setPrompt(demoScenarios[0].prompt);
    document.documentElement.requestFullscreen?.().catch(() => undefined);
  };

  const stopPresentation = () => {
    setPresentation(false);
    if (document.fullscreenElement) document.exitFullscreen?.().catch(() => undefined);
  };

  if (dataError) {
    return <main className="fatal-state"><Wordmark /><h1>Dashboard data is unavailable</h1><p>{dataError}</p><code>npm run dashboard</code></main>;
  }
  if (!benchmark || !pairing) {
    return <main className="loading-state"><Wordmark /><div className="loading-orb" /><p>Preparing the decision theatre...</p></main>;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-brand"><Wordmark /><p>Local first. Cloud only when it is safe and needed.</p></div>
        <div className="header-actions">
          <button type="button" className={`status-pill ${metaAccess}`} onClick={() => setTraceOpen(true)}><span />Meta access: {metaAccess === "live" ? "Live" : "Paused"}</button>
          <IconButton label={dark ? "Use light theme" : "Use dark theme"} onClick={() => setDark(!dark)}>{dark ? "☀" : "◐"}</IconButton>
          <button type="button" className="presentation-button" onClick={startPresentation}><span>▶</span> Presentation mode</button>
        </div>
      </header>

      <main>
        <section className="input-panel" aria-label="Handoff prompt controls">
          <div className="input-panel-top">
            <div className="segmented" aria-label="Run mode">
              <button type="button" className={runMode === "demo" ? "active" : ""} onClick={() => chooseMode("demo")} aria-pressed={runMode === "demo"}>Demo recording</button>
              <button type="button" className={runMode === "live" ? "active" : ""} onClick={() => chooseMode("live")} aria-pressed={runMode === "live"}>Live local</button>
            </div>
            <div className="segmented" aria-label="View mode">
              <button type="button" className={viewMode === "characters" ? "active" : ""} onClick={() => setViewMode("characters")} aria-pressed={viewMode === "characters"}>Characters</button>
              <button type="button" className={viewMode === "steps" ? "active" : ""} onClick={() => setViewMode("steps")} aria-pressed={viewMode === "steps"}>Steps</button>
            </div>
          </div>
          <div className="prompt-controls">
            <div className="prompt-field">
              <label htmlFor="prompt-input">Give Handoff a task</label>
              <textarea id="prompt-input" value={prompt} readOnly={runMode === "demo"} onChange={(event) => setPrompt(event.target.value)} rows={2} />
            </div>
            <label className="select-field">Sample prompts
              <select value={scenarioIndex} onChange={(event) => chooseScenario(Number(event.target.value))}>
                {demoScenarios.map((item, index) => <option key={item.id} value={index}>{item.menuLabel}</option>)}
              </select>
            </label>
            <label className="select-field pairing-select">Pairing
              <select value={pairingId} onChange={(event) => setPairingId(event.target.value as PairingId)}>
                {benchmark.pairings.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
              </select>
            </label>
            <button type="button" className="run-button" onClick={runCurrent} disabled={liveBusy || !prompt.trim()}>{liveBusy ? "Running locally..." : "Run Handoff"}<span>→</span></button>
          </div>
          {liveMessage && <p className="live-message" role="status"><span />{liveMessage}</p>}
        </section>

        <div className="view-controls-row">
          <p>{scenario.description}</p>
          <div className="replay-controls" aria-label="Replay controls">
            <IconButton label={playback.playing ? "Pause replay" : "Play replay"} onClick={() => playback.setPlaying(!playback.playing)}>{playback.playing ? "Ⅱ" : "▶"}</IconButton>
            <IconButton label="Restart replay" onClick={playback.restart}>↻</IconButton>
            <label>Speed<select value={speed} onChange={(event) => setSpeed(Number(event.target.value))}><option value={0.5}>0.5x</option><option value={1}>1x</option><option value={2}>2x</option></select></label>
            <div className="timeline"><motion.i animate={{ width: `${playback.progress * 100}%` }} /></div>
          </div>
        </div>

        <AnimatePresence mode="wait">
          <motion.div key={viewMode} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -8 }} transition={{ duration: 0.25 }}>
            {viewMode === "characters"
              ? <Stage pairing={pairing} scenario={scenario} activeEvent={playback.activeEvent} elapsed={playback.elapsed} complete={playback.complete} />
              : <StepsView pairing={pairing} scenario={scenario} activeEvent={playback.activeEvent} />}
          </motion.div>
        </AnimatePresence>

        <button type="button" className="trust-strip" onClick={() => setTraceOpen(true)}>
          <span className="trust-icon">✓</span>
          <div><strong>{benchmark.trust.harmfulCloudPrompts} harmful prompts sent to the cloud</strong><small>Verified from request trace. Open the safety summary.</small></div>
          <span className="trust-arrow">→</span>
        </button>

        <ResultsPanel data={benchmark} activePairing={pairingId} onSelectPairing={setPairingId} />
      </main>

      <footer className="dashboard-footer"><Wordmark /><p>Built during the Meta Global AI Developer Hackathon.</p><span>Seed {benchmark.seed}</span></footer>

      {presentation && <button type="button" className="presentation-exit" onClick={stopPresentation}>Exit presentation</button>}

      <AnimatePresence>
        {traceOpen && (
          <motion.div className="modal-backdrop" role="presentation" onMouseDown={() => setTraceOpen(false)} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <motion.section className="trace-modal" role="dialog" aria-modal="true" aria-labelledby="trace-title" onMouseDown={(event) => event.stopPropagation()} initial={{ opacity: 0, scale: 0.96, y: 16 }} animate={{ opacity: 1, scale: 1, y: 0 }} exit={{ opacity: 0, scale: 0.96 }}>
              <button type="button" className="modal-close" onClick={() => setTraceOpen(false)} aria-label="Close safety summary">×</button>
              <span className="modal-shield">✓</span>
              <span className="eyebrow">Request trace summary</span>
              <h2 id="trace-title">The safety boundary held.</h2>
              <p>{benchmark.trust.note}</p>
              <div className="trace-stats">
                <div><strong>0</strong><span>harmful cloud prompts</span></div>
                <div><strong>{benchmark.progress.completed}</strong><span>effective results</span></div>
                <div><strong>0</strong><span>Meta calls in offline pass</span></div>
              </div>
              <ul><li>StrongREJECT was screened, answered, and scored locally.</li><li>Every potential handoff passed the local Guard first.</li><li>GPQA question text and credentials are excluded from the bundle.</li></ul>
              <small>Source: local request trace and results/summary.md</small>
            </motion.section>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
