import { AnimatePresence, motion, type Variants } from "framer-motion";
import { forwardRef, useEffect, useImperativeHandle, useState } from "react";
import type { CharacterAnimator, CharacterKind, CharacterState } from "../types";
import { useMotionPreference } from "../hooks/useMotionPreference";
import "./Character.css";

interface CharacterProps {
  kind: CharacterKind;
  label: string;
  compact?: boolean;
  cloudModel?: string;
}

const bodies: Record<CharacterKind, string> = {
  llama: "M61 106Q61 62 105 62H135Q179 62 179 106V174Q179 226 120 226Q61 226 61 174Z",
  gemma: "M58 112Q58 69 101 69H139Q182 69 182 112V175Q182 226 120 226Q58 226 58 175Z",
  guard: "M120 58Q148 72 180 77L175 151Q173 193 120 227Q67 193 65 151L60 77Q92 72 120 58Z",
  spark: "M61 111A38 38 0 0 1 103 77A40 40 0 0 1 180 104A43 43 0 0 1 177 190H66A40 40 0 0 1 61 111Z",
};
const sides: Record<CharacterKind, string> = {
  llama: "M161 85Q179 96 179 116V174Q179 226 120 226Q88 226 74 211Q157 220 161 169Z",
  gemma: "M166 91Q182 103 182 120V175Q182 226 120 226Q85 226 71 209Q163 221 166 170Z",
  guard: "M163 75L180 77L175 151Q173 193 120 227Q93 209 80 191Q151 205 163 138Z",
  spark: "M196 118Q215 135 214 153Q213 190 177 190H66Q43 190 33 170Q67 179 164 176Q199 173 196 118Z",
};

function poses(reduced: boolean): Variants {
  const spring = { type: "spring" as const, stiffness: 180, damping: 18 };
  const still = { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1 };
  if (reduced) return Object.fromEntries(
    ["idle", "receive", "think", "confident", "unsure", "hand_off", "answer", "block", "celebrate"]
      .map(name => [name, { ...still, opacity: 1, transition: { duration: 0.12 } }]),
  );
  return {
    idle: { ...still, transition: spring },
    receive: { ...still, y: [0, 5, 0], rotate: [0, -3, 0], transition: { duration: 0.55 } },
    think: { ...still, rotate: -2, transition: spring },
    confident: { ...still, y: [0, 4, 0], rotate: [0, 3, 0], transition: { duration: 0.6 } },
    unsure: { ...still, rotate: -7, transition: spring },
    hand_off: { ...still, x: 16, rotate: 5, scaleX: [1, 1.07, 0.97, 1], scaleY: [1, 0.94, 1.05, 1], transition: { duration: 0.75 } },
    answer: { ...still, y: -4, transition: spring },
    block: { ...still, scaleX: 1.035, scaleY: 1.035, transition: spring },
    celebrate: { ...still, y: [0, -10, 0], rotate: [0, -3, 3, 0], transition: { duration: 0.8 } },
  };
}

export const SvgCharacter = forwardRef<CharacterAnimator, CharacterProps>(function SvgCharacter({
  kind, label, compact = false, cloudModel,
}, ref) {
  const [state, setState] = useState<CharacterState>("idle");
  const [blink, setBlink] = useState(false);
  const reduced = useMotionPreference();
  const cloud = kind === "spark";
  const variant = cloud && cloudModel === "x-ai/grok-4.7" ? "grok" : "muse";
  const thinking = state === "think";
  const happy = ["confident", "answer", "celebrate"].includes(state);
  const unsure = state === "unsure";
  const blocked = state === "block";
  const holding = ["receive", "hand_off", "answer"].includes(state);
  const faceY = cloud ? 132 : 131;

  useImperativeHandle(ref, () => ({ setState }), []);

  useEffect(() => {
    if (reduced) { setBlink(false); return; }
    let timer: ReturnType<typeof setTimeout>;
    let reopen: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setBlink(true);
        reopen = setTimeout(() => { setBlink(false); schedule(); }, 125);
      }, 3000 + Math.random() * 3000);
    };
    schedule();
    return () => { clearTimeout(timer); clearTimeout(reopen); };
  }, [reduced]);

  const mouth = unsure
    ? "M108 163Q120 154 132 163"
    : happy
      ? "M107 157Q120 172 133 157"
      : thinking
        ? "M116 161Q120 156 124 161"
        : "M109 158Q120 167 131 158";

  return (
    <div className={"character-wrap flat-character " + (compact ? "is-compact" : "")}
      data-state={state} data-kind={kind} data-variant={cloud ? variant : undefined}>
      <svg key={reduced ? "reduced" : "motion"} viewBox="0 0 240 280" role="img"
        aria-label={label + ", " + state.replace("_", " ")}>
        <motion.ellipse className="character-ground-shadow" cx="120" cy="260" rx={kind === "guard" ? 51 : 65} ry="10"
          fill="#0B1220" opacity="0.25" style={{ transformOrigin: "120px 260px" }}
          animate={reduced || !cloud ? { scaleX: 1 } : { scaleX: [1, 0.8, 1] }}
          transition={reduced || !cloud ? { duration: 0.12 } : { duration: 4, repeat: Infinity, ease: "easeInOut" }} />
        <motion.g className="character-float"
          animate={reduced || !cloud ? { y: 0 } : { y: [0, -7, 0] }}
          transition={reduced || !cloud ? { duration: 0.12 } : { duration: 4, repeat: Infinity, ease: "easeInOut" }}>
          <motion.g className="character-pose" variants={poses(reduced)} animate={state} initial={false}
            style={{ transformOrigin: "120px 220px" }}>
            {!cloud && <path className="character-shade" d="M83 213h22v29q0 8-11 8h-6q-11 0-11-8v-9q0-13 6-20Zm52 0h22q6 7 6 20v9q0 8-11 8h-6q-11 0-11-8Z" />}
            <motion.path className="character-main" d="M65 146Q41 148 43 172" fill="none" stroke="var(--character-main)"
              strokeWidth="15" strokeLinecap="round" style={{ transformOrigin: "65px 146px" }}
              animate={{ rotate: reduced ? 0 : state === "receive" || state === "celebrate" ? 20 : 0 }}
              transition={{ duration: reduced ? 0 : 0.35 }} />
            <motion.path className="character-main" d="M175 146Q198 150 197 173" fill="none" stroke="var(--character-main)"
              strokeWidth="15" strokeLinecap="round" style={{ transformOrigin: "175px 146px" }}
              animate={{ rotate: reduced ? 0 : blocked ? -70 : state === "hand_off" ? -48 : state === "answer" ? -24 : 0 }}
              transition={{ duration: reduced ? 0 : 0.35 }} />
            <motion.g className="character-body" style={{ transformOrigin: "120px 226px" }}
              animate={reduced ? { scaleY: 1 } : { scaleY: [1, 1.03, 1] }}
              transition={reduced ? { duration: 0.12 } : { duration: 3.8, repeat: Infinity, ease: "easeInOut" }}>
              {kind === "llama" && <path className="character-main" d="M76 86L59 33Q54 17 67 16Q80 15 84 31L95 77ZM145 77L155 31Q159 15 172 16Q185 17 180 33L163 86Z" />}
              {kind === "gemma" && <path className="character-main" d="M110 77V52Q110 42 120 42Q130 42 130 52V77Z" />}
              <path className="character-main" d={bodies[kind]} />
              <path className="character-shade" d={sides[kind]} />
              <g data-expression={unsure ? "unsure" : happy ? "happy" : thinking ? "thinking" : blocked ? "blocked" : "idle"}>
                <motion.g className="character-eyes" style={{ transformOrigin: "120px " + faceY + "px" }}
                  animate={{ scaleY: blink ? 0.08 : blocked ? 0.34 : 1 }}
                  transition={{ duration: reduced ? 0 : 0.065 }}>
                  <rect className="character-eye" x="91" y={faceY - 8} width="12" height="16" rx="6" />
                  <rect className="character-eye" x="137" y={faceY - 8} width="12" height="16" rx="6" />
                </motion.g>
                <path className="character-mouth" d={mouth} fill="none" strokeWidth="4" strokeLinecap="round" />
                {unsure && <path className="character-mouth" d="M89 112L104 108M136 108L151 112" fill="none" strokeWidth="3" strokeLinecap="round" />}
              </g>
              {kind === "guard" && blocked && <path className="character-lock" fillRule="evenodd"
                d="M108 185V178a12 12 0 0 1 24 0v7h3q3 0 3 3v17q0 3-3 3h-30q-3 0-3-3v-17q0-3 3-3Zm6 0h12v-7a6 6 0 0 0-12 0Z" />}
            </motion.g>
            <AnimatePresence>{holding && <motion.g key="held-card" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
              <g transform={state === "hand_off" ? "translate(174 138) rotate(10)" : "translate(165 174) rotate(-8)"}>
                <rect x="0" y="0" width="48" height="35" rx="7" fill="#F3F4F6" />
                <path d="M10 11H37M10 19H31M10 27H24" fill="none" stroke="#475569" strokeWidth="2.5" strokeLinecap="round" />
              </g>
            </motion.g>}</AnimatePresence>
          </motion.g>
        </motion.g>
        <AnimatePresence>
          {thinking && <motion.g className="character-thought" key="thought" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
            <path d="M181 52a5 5 0 1 0 0 .1ZM192 34a7 7 0 1 0 0 .1ZM203 18m-29 0a29 20 0 1 0 58 0a29 20 0 1 0-58 0" fill="#FFFFFF" />
            {[188, 203, 218].map((x, index) => <motion.circle key={x} cx={x} cy="18" r="3.5" fill="#0B1220"
              animate={reduced ? { opacity: 1 } : { opacity: [0.25, 1, 0.25] }}
              transition={reduced ? { duration: 0.12 } : { duration: 1.2, repeat: Infinity, delay: index * 0.16 }} />)}
          </motion.g>}
          {kind === "guard" && blocked && <motion.path key="shield-pulse" className="character-shield-pulse"
            d={bodies.guard} fill="none" stroke="var(--character-inner)" strokeWidth="2"
            style={{ transformOrigin: "120px 142px" }} initial={{ opacity: 0 }}
            animate={reduced ? { opacity: 0.45, scale: 1.12 } : { scale: [1, 1.34], opacity: [0.6, 0] }}
            transition={reduced ? { duration: 0.12 } : { duration: 1.8, repeat: Infinity, ease: "easeOut" }} />}
        </AnimatePresence>
      </svg>
      <div className="character-name">{label}</div>
    </div>
  );
});
