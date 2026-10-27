import { motion, useReducedMotion } from "framer-motion";
import { useEffect, useMemo, useRef } from "react";
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
    case "thinking": return event.actor === "cloud"
      ? { local: "idle", guard: "confident", cloud: "think" }
      : { local: "think", guard: "idle", cloud: "idle" };
    case "confidence": return { local: (event.data?.confidence ?? 0) >= 0.8 ? "confident" : "unsure", guard: "idle", cloud: "idle" };
    case "decision": return { local: event.data?.route === "local" ? "confident" : "unsure", guard: "idle", cloud: "idle" };
    case "handed_off": return { local: "hand_off", guard: "confident", cloud: "receive" };
    case "answered": return event.actor === "cloud"
      ? { local: "idle", guard: "confident", cloud: "answer" }
      : { local: "answer", guard: "confident", cloud: "idle" };
    case "blocked": return { local: "unsure", guard: "block", cloud: "idle" };
  }
}

function formatTimer(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function StepTracker({ activeEvent }: { activeEvent: HandoffEvent }) {
  return (
    <div className="step-tracker" aria-label="Handoff progress">
      {stepLabels.map((item) => {
        const active = item.number === activeEvent.step;
        const done = item.number < activeEvent.step;
        return (
          <div className={`step-marker ${active ? "active" : ""} ${done ? "done" : ""}`} key={item.number}>
            <span>{done ? "✓" : item.number}</span>
            <small>{item.label}</small>
          </div>
        );
      })}
      <div className="step-caption" aria-live="polite">
        <span className="pulse-dot" />
        {activeEvent.caption}
      </div>
    </div>
  );
}

export function Stage({ pairing, scenario, activeEvent, elapsed, complete }: StageProps) {
  const localRef = useRef<CharacterAnimator>(null);
  const guardRef = useRef<CharacterAnimator>(null);
  const cloudRef = useRef<CharacterAnimator>(null);
  const reduced = useReducedMotion() ?? false;
  const localKind = pairing.id.startsWith("gemma") ? "gemma" : "llama";
  const localName = localKind === "gemma" ? "Gemma" : "Llama";
  const cloudName = pairing.cloudModel.includes("grok") ? "Spark for Grok" : "Spark";
  const states = useMemo(() => characterStates(activeEvent, complete), [activeEvent, complete]);

  useEffect(() => {
    localRef.current?.setState(states.local);
    guardRef.current?.setState(states.guard);
    cloudRef.current?.setState(states.cloud);
  }, [states]);

  const cardLeft = activeEvent.type === "blocked" || activeEvent.type === "screened"
    ? "46%"
    : activeEvent.type === "handed_off"
      ? "71%"
      : activeEvent.actor === "cloud" || (activeEvent.type === "answered" && activeEvent.data?.route === "cloud")
        ? "79%"
        : "24%";
  const confidence = activeEvent.data?.confidence;
  const answer = activeEvent.type === "answered" ? activeEvent.data?.answer : null;
  const blocked = activeEvent.type === "blocked";
  const isThinking = activeEvent.type === "thinking";

  return (
    <section className="stage-shell" aria-label="Animated Handoff routing scene">
      <div className="stage-topline">
        <div>
          <span className="eyebrow">Live decision theatre</span>
          <h2>{scenario.label}</h2>
        </div>
        <div className="pairing-legend" aria-label={`${pairing.name} character legend`}>
          <strong>{pairing.name}</strong>
          <span><i className={`legend-dot ${localKind}`} />{localName}</span>
          <span><i className="legend-dot guard" />Guard</span>
          <span><i className="legend-dot spark" />{cloudName}</span>
        </div>
      </div>

      <div className="stage-scene">
        <div className="zone local-zone">
          <div className="zone-label"><span className="device-icon">⌁</span> On your device</div>
          <div className="desk-line" />
          <div className="character-position local-character">
            <SvgCharacter ref={localRef} kind={localKind} label={localName} />
            {isThinking && activeEvent.actor === "local" && <div className="stage-thought-bubble" aria-hidden="true"><i /><i /><i /></div>}
            {isThinking && activeEvent.actor === "local" && <div className="live-timer">Thinking {formatTimer(Math.max(0, elapsed - activeEvent.at))}</div>}
          </div>
        </div>

        <div className="boundary" aria-label="Local to cloud boundary">
          <span>Safety boundary</span>
        </div>

        <div className="guard-position">
          <SvgCharacter ref={guardRef} kind="guard" label="Guard" compact />
        </div>

        <div className="zone cloud-zone">
          <div className="cloud-orb cloud-orb-one" />
          <div className="cloud-orb cloud-orb-two" />
          <div className="zone-label"><span className="cloud-icon">☁</span> Cloud</div>
          <div className="character-position cloud-character">
            <SvgCharacter ref={cloudRef} kind="spark" label={cloudName} />
            {isThinking && activeEvent.actor === "cloud" && <div className="stage-thought-bubble cloud-thought" aria-hidden="true"><i /><i /><i /></div>}
            {isThinking && activeEvent.actor === "cloud" && <div className="live-timer cloud-timer">Thinking {formatTimer(Math.max(0, elapsed - activeEvent.at))}</div>}
          </div>
        </div>

        <motion.div
          className={`prompt-card ${blocked ? "is-blocked" : ""}`}
          initial={false}
          animate={{ left: cardLeft, top: activeEvent.type === "received" ? "16%" : activeEvent.actor === "cloud" ? "37%" : "34%", rotate: activeEvent.type === "handed_off" ? 8 : 0, scale: activeEvent.type === "received" ? 1.05 : 0.92 }}
          transition={reduced ? { duration: 0.15 } : { type: "spring", stiffness: 85, damping: 18 }}
        >
          <span className="prompt-card-kicker">Request</span>
          <p>{scenario.prompt}</p>
          {activeEvent.type === "screened" && activeEvent.data?.status === "checking" && <motion.div className="scan-beam" animate={reduced ? { opacity: 0.5 } : { y: [0, 58, 0] }} transition={{ duration: 1.4, repeat: Infinity }} />}
          {activeEvent.data?.status === "safe" && <span className="card-status safe">✓ Safe</span>}
          {blocked && <span className="card-status blocked">⌕ Locked</span>}
        </motion.div>

        {activeEvent.type === "handed_off" && !reduced && (
          <motion.div className="handoff-trail" initial={{ opacity: 0, scaleX: 0 }} animate={{ opacity: [0, 1, 0], scaleX: 1 }} transition={{ duration: 1.1 }} />
        )}

        {confidence !== undefined && activeEvent.type === "confidence" && (
          <motion.div className="confidence-card" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }}>
            <div><span>Local confidence</span><strong>{Math.round(confidence * 100)}%</strong></div>
            <div className="confidence-track"><motion.i initial={{ width: 0 }} animate={{ width: `${confidence * 100}%` }} /></div>
            <small>{activeEvent.data?.reason}</small>
          </motion.div>
        )}

        {blocked && (
          <motion.div className="blocked-banner" initial={{ opacity: 0, scale: 0.92 }} animate={{ opacity: 1, scale: 1 }}>
            <span>🔒</span><div><strong>Kept local, never sent</strong><small>Guard stopped the route at the safety boundary.</small></div>
          </motion.div>
        )}

        {answer && (
          <motion.div className="answer-panel" initial={{ opacity: 0, y: 24 }} animate={{ opacity: 1, y: 0 }}>
            <div className="answer-meta">
              <span>{activeEvent.actor === "cloud" ? cloudName : localName} answered</span>
              <span>{formatTimer(activeEvent.data?.latencyMs ?? 0)}</span>
              <span>{(activeEvent.data?.costUsd ?? 0) === 0 ? "No cloud cost" : `$${activeEvent.data?.costUsd?.toFixed(3)}`}</span>
            </div>
            <p>{answer}</p>
          </motion.div>
        )}
      </div>

      <StepTracker activeEvent={activeEvent} />
    </section>
  );
}
