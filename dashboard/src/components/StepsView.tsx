import { useMotionPreference } from "../hooks/useMotionPreference";
import { motion } from "framer-motion";
import type { DemoScenario, HandoffEvent, PairingMetric } from "../types";
import { stepLabels } from "../data/scenarios";

interface StepsViewProps {
  scenario: DemoScenario;
  activeEvent: HandoffEvent;
  pairing: PairingMetric;
}

function formatAt(ms: number) {
  return `${(ms / 1000).toFixed(1)}s`;
}

export function StepsView({ scenario, activeEvent, pairing }: StepsViewProps) {
  const reduced = useMotionPreference();
  const cloudName = pairing.cloudModel === "muse-spark-1.3" ? "Muse Spark" : "Grok 4.7";
  const localName = pairing.localModel.startsWith("gemma") ? "Gemma" : "Llama";
  const caption = (text: string) => text.replace(/(?:Muse )?\bSpark\b/g, cloudName).replaceAll("Llama", localName);
  return (
    <section className="steps-shell" aria-label="Technical Handoff event steps">
      <div className="steps-heading">
        <div><span className="eyebrow">Technical trace</span><h2>One stream, every decision</h2></div>
        <div className="model-route"><span>{pairing.localModel}</span><i>→</i><span>{pairing.cloudModel}</span></div>
      </div>
      <div className="steps-list">
        {stepLabels.map((step) => {
          const events = scenario.events.filter((item) => item.step === step.number);
          const primary = events.at(-1);
          const reached = step.number <= activeEvent.step;
          const current = step.number === activeEvent.step;
          return (
            <motion.article
              key={step.number}
              className={`technical-step ${current ? "active" : ""} ${reached ? "reached" : ""}`}
              animate={{ opacity: 1, x: !reduced && current ? 6 : 0 }}
              transition={{ duration: 0.3 }}
            >
              <div className="technical-step-number">{reached && !current ? "✓" : step.number}</div>
              <div className="technical-step-body">
                <div><strong>{step.label}</strong>{primary && <time>{formatAt(primary.at)}</time>}</div>
                <p>{caption(current ? activeEvent.caption : primary?.caption ?? "Waiting for the previous stage")}</p>
                {current && activeEvent.data?.reason && <small>Reason: {activeEvent.data.reason}</small>}
              </div>
              <div className="technical-step-state">{current ? "Now" : reached ? "Done" : "Waiting"}</div>
            </motion.article>
          );
        })}
      </div>
      <div className="trace-footnote">
        <span className="lock-mark">⌾</span>
        <div><strong>Payload boundary</strong><p>Only a safe request can cross from the local model to the selected cloud model.</p></div>
      </div>
    </section>
  );
}
