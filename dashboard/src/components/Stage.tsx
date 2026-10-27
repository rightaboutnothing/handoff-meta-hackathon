import { useMotionPreference } from "../hooks/useMotionPreference";
import { AnimatePresence, motion } from "framer-motion";
import { useEffect, useMemo, useRef, useState } from "react";
import type { CharacterAnimator, CharacterState, DemoScenario, HandoffEvent, PairingMetric } from "../types";
import { stepLabels } from "../data/scenarios";
import { SvgCharacter } from "./Character";

interface StageProps {
  pairing: PairingMetric;
  scenario: DemoScenario;
  activeEvent: HandoffEvent;
  elapsed: number;
  complete: boolean;
}

function characterStates(event: HandoffEvent, complete: boolean): { local: CharacterState; guard: CharacterState; cloud: CharacterState } {
  if (complete && event.type !== "blocked") return { local: "celebrate", guard: "celebrate", cloud: "celebrate" };
  switch (event.type) {
    case "received": return { local: "receive", guard: "idle", cloud: "idle" };
    case "screened": return { local: "idle", guard: event.data?.status === "safe" ? "confident" : "think", cloud: "idle" };
    case "thinking": return event.actor === "cloud" ? { local: "idle", guard: "confident", cloud: "think" } : { local: "think", guard: "idle", cloud: "idle" };
    case "confidence": return { local: (event.data?.confidence ?? 0) >= 0.8 ? "confident" : "unsure", guard: "idle", cloud: "idle" };
    case "decision": return { local: event.data?.route === "local" ? "confident" : "unsure", guard: "idle", cloud: "idle" };
    case "handed_off": return { local: "hand_off", guard: "confident", cloud: "receive" };
    case "answered": return event.actor === "cloud" ? { local: "idle", guard: "confident", cloud: "answer" } : { local: "answer", guard: "confident", cloud: "idle" };
    case "blocked": return { local: "unsure", guard: "block", cloud: "idle" };
  }
}

const formatTimer = (ms: number) => (ms / 1000).toFixed(1) + "s";

export function StepTracker({ activeEvent, scenario, elapsed }: { activeEvent: HandoffEvent; scenario: DemoScenario; elapsed: number }) {
  const reduced = useMotionPreference();
  return (
    <div className="step-tracker" aria-label="Handoff progress">
      <div className="progress-rail" aria-hidden="true"><motion.i animate={{ scaleX: (activeEvent.step - 1) / 5 }} transition={reduced ? { duration: 0 } : { type: "spring", stiffness: 160, damping: 26 }} /></div>
      {stepLabels.map(item => {
        const active = item.number === activeEvent.step;
        const done = item.number < activeEvent.step;
        const start = scenario.events.find(event => event.step === item.number)?.at;
        const next = scenario.events.find(event => event.step > item.number)?.at;
        const timing = start === undefined || start > elapsed ? null : Math.round(Math.max(0, Math.min(elapsed, next ?? scenario.duration) - start));
        return <div className={"step-marker " + (active ? "active " : "") + (done ? "done" : "")} key={item.number} aria-current={active ? "step" : undefined}>
          <span className="step-node"><AnimatePresence mode="wait"><motion.b key={done ? "done" : "number"} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: reduced ? 0 : 0.15 }}>{done ? "✓" : item.number}</motion.b></AnimatePresence></span>
          <strong>{item.label}</strong><small>{timing === null ? "Pending" : timing.toLocaleString() + " ms"}</small>
        </div>;
      })}
    </div>
  );
}

export function Stage({ pairing, scenario, activeEvent, elapsed, complete }: StageProps) {
  const localRef = useRef<CharacterAnimator>(null);
  const guardRef = useRef<CharacterAnimator>(null);
  const cloudRef = useRef<CharacterAnimator>(null);
  const sceneRef = useRef<HTMLDivElement>(null);
  const [sceneWidth, setSceneWidth] = useState(1600);
  const reduced = useMotionPreference() ?? false;
  const localKind = pairing.id.startsWith("gemma") ? "gemma" : "llama";
  const localName = localKind === "gemma" ? "Gemma" : "Llama";
  const cloudName = pairing.cloudModel === "muse-spark-1.3" ? "Muse Spark" : "Grok 4.7";
  const states = useMemo(() => characterStates(activeEvent, complete), [activeEvent, complete]);
  useEffect(() => {
    localRef.current?.setState(states.local);
    guardRef.current?.setState(states.guard);
    cloudRef.current?.setState(states.cloud);
  }, [states]);
  useEffect(() => {
    if (!sceneRef.current) return;
    const observer = new ResizeObserver(entries => setSceneWidth(entries[0].contentRect.width));
    observer.observe(sceneRef.current);
    return () => observer.disconnect();
  }, []);

  const blocked = activeEvent.type === "blocked";
  const handoff = activeEvent.type === "handed_off";
  const cloud = activeEvent.actor === "cloud";
  const confidence = activeEvent.data?.confidence;
  const answer = activeEvent.type === "answered" ? activeEvent.data?.answer : null;
  const caption = activeEvent.caption.replace(/(?:Muse )?\bSpark\b/g, cloudName).replaceAll("Llama", localName);
  const handoffProgress = Math.min(1, Math.max(0, (elapsed - activeEvent.at) / 1050));
  const cardRatio = handoff ? 0.24 + 0.52 * handoffProgress : cloud ? 0.76 : activeEvent.type === "screened" || blocked ? 0.38 : 0.24;
  const cardY = handoff && !reduced ? -Math.sin(handoffProgress * Math.PI) * 62 : activeEvent.type === "received" ? -18 : 0;
  const narrow = sceneWidth < 700;

  return (
    <section className={"stage-shell " + (blocked ? "route-blocked" : "")} aria-label="Animated Handoff routing scene" data-event={activeEvent.type}>
      <div className="stage-topline">
        <div><span className="eyebrow">Decision Theatre</span><h1>{scenario.label}</h1></div>
        <div className="pairing-legend" aria-label={pairing.name + " character legend"}><strong>{pairing.name}</strong><span><i className={"legend-dot " + localKind} />{localName}</span><span><i className="legend-dot guard" />Guard</span><span><i className="legend-dot spark" />{cloudName}</span></div>
      </div>
      <div className="stage-scene" ref={sceneRef}>
        <div className="stage-camera" data-key-moment={handoff ? "handoff" : blocked ? "block" : "none"}>
          <div className="zone local-zone"><div className="zone-label"><svg viewBox="0 0 20 20" aria-hidden="true"><rect x="3" y="3" width="14" height="10" rx="2" /><path d="M1 16h18" /></svg>On your device</div><div className="zone-floor" /><div className="character-position local-character"><div className="pedestal" /><SvgCharacter ref={localRef} kind={localKind} label={localName} />{activeEvent.type === "thinking" && !cloud && <div className="live-timer"><i />Thinking {formatTimer(Math.max(0, elapsed - activeEvent.at))}</div>}</div></div>
          <div className="boundary" aria-label="Local to cloud boundary"><i className="boundary-shimmer" /><span>Safety boundary</span></div>
          <div className="guard-position"><SvgCharacter ref={guardRef} kind="guard" label="Guard" compact /></div>
          <div className="zone cloud-zone"><div className="zone-label"><svg viewBox="0 0 20 20" aria-hidden="true"><path d="M5 15a4 4 0 0 1-1-8 6 6 0 0 1 11-1 5 5 0 0 1 0 9Z" /></svg>Cloud</div><div className="light-bloom" /><div className="cloud-layer cloud-layer-back" /><div className="cloud-layer cloud-layer-front" /><div className="star-field" aria-hidden="true">{Array.from({ length: 12 }, (_, i) => <i key={i} style={{ left: (8 + (i * 23) % 85) + "%", top: (14 + (i * 17) % 60) + "%", animationDelay: (i * -0.7) + "s" }} />)}</div><div className="character-position cloud-character"><div className="pedestal cloud-pedestal" /><SvgCharacter ref={cloudRef} kind="spark" label={cloudName} cloudModel={pairing.cloudModel} />{activeEvent.type === "thinking" && cloud && <div className="live-timer cloud-timer"><i />Thinking {formatTimer(Math.max(0, elapsed - activeEvent.at))}</div>}</div></div>
          {handoff && <svg className="handoff-arc" viewBox="0 0 1000 400" preserveAspectRatio="none" aria-hidden="true"><defs><linearGradient id="arc-light"><stop stopColor="#FDBA74" /><stop offset=".5" stopColor="#86EFAC" /><stop offset="1" stopColor="#60A5FA" /></linearGradient></defs><path d="M240 160 Q500 -35 760 160" stroke="url(#arc-light)" fill="none" strokeWidth="2" /><path className="arc-trail" d="M240 160 Q500 -35 760 160" stroke="#DBEAFE" fill="none" strokeWidth="5" /></svg>}
          <motion.div className={"prompt-card " + (blocked ? "is-blocked" : "")} initial={false} animate={reduced ? { opacity: answer ? 0 : 1, x: narrow ? (cardRatio - 0.5) * sceneWidth * 0.75 : (cardRatio - 0.5) * sceneWidth, y: 0, rotate: 0 } : { opacity: answer ? 0 : 1, x: narrow ? (cardRatio - 0.5) * sceneWidth * 0.75 : (cardRatio - 0.5) * sceneWidth, y: cardY, rotate: handoff ? -7 + handoffProgress * 14 : 0 }} transition={handoff || reduced ? { duration: 0 } : { type: "spring", stiffness: 100, damping: 23 }}>
            <div className="prompt-card-kicker"><svg viewBox="0 0 16 16" aria-hidden="true"><rect x="3" y="1" width="10" height="14" rx="2" /><path d="M6 5h4M6 8h4" /></svg> {blocked ? "Private request" : "Your request"}<span>{blocked ? "Locked" : "Local first"}</span></div><p>{scenario.prompt}</p>
            {activeEvent.type === "screened" && activeEvent.data?.status === "checking" && <div className="scan-beam" />}
            {activeEvent.data?.status === "safe" && <span className="card-status safe">✓ Safety check passed</span>}{blocked && <span className="card-status blocked">🔒 Kept on your device</span>}
          </motion.div>
          {blocked && <div className="boundary-ripple" aria-hidden="true" />}
          {confidence !== undefined && activeEvent.type === "confidence" && <motion.div className="confidence-card" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><div><span>Local confidence</span><strong>{Math.round(confidence * 100)}%</strong></div><div className="confidence-track"><motion.i initial={false} animate={{ scaleX: confidence }} transition={{ duration: reduced ? 0 : 0.5 }} /></div><small>{activeEvent.data?.reason}</small></motion.div>}
          {blocked && <motion.div className="blocked-banner" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2 21 6v6c0 5-9 10-9 10S3 17 3 12V6Z" /><path d="m8 12 3 3 5-6" /></svg><div><strong>Kept local, never sent</strong><small>Guard stopped the request at the boundary.</small></div></motion.div>}
          {answer && <motion.div className="answer-panel" initial={{ opacity: 0 }} animate={{ opacity: 1 }}><div className="answer-meta"><span className="answer-check">✓</span><strong>{cloud ? cloudName : localName} answered</strong><span>{formatTimer(activeEvent.data?.latencyMs ?? 0)}</span><span>{(activeEvent.data?.costUsd ?? 0) === 0 ? "No cloud cost" : "$" + activeEvent.data?.costUsd?.toFixed(3)}</span></div><p>{answer}</p></motion.div>}
        </div>
      </div>
      <div className="caption-area" aria-live="polite"><span className={"caption-status " + (blocked ? "blocked" : "")} /><motion.p key={activeEvent.id} aria-label={caption}>{caption.split(" ").map((word, index) => <motion.span aria-hidden="true" key={index} initial={{ opacity: reduced ? 1 : 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.2, delay: reduced ? 0 : index * 0.022 }}>{word}{" "}</motion.span>)}</motion.p></div>
      <StepTracker activeEvent={activeEvent} scenario={scenario} elapsed={elapsed} />
    </section>
  );
}
