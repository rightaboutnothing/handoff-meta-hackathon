import { AnimatePresence, motion, useReducedMotion, type Variants } from "framer-motion";
import { forwardRef, useId, useImperativeHandle, useState } from "react";
import type { CharacterAnimator, CharacterKind, CharacterState } from "../types";

interface CharacterProps {
  kind: CharacterKind;
  label: string;
  compact?: boolean;
}

const palettes: Record<CharacterKind, { from: string; to: string; accent: string }> = {
  llama: { from: "#FFF0C9", to: "#E9C47D", accent: "#805D35" },
  gemma: { from: "#E8D6FF", to: "#A888F4", accent: "#5938A8" },
  guard: { from: "#BCEAD8", to: "#58C79B", accent: "#116C4C" },
  spark: { from: "#EAF3FF", to: "#AFCFFF", accent: "#0866FF" },
};

function stateVariants(reduced: boolean): Variants {
  if (reduced) {
    return Object.fromEntries(["idle", "receive", "think", "confident", "unsure", "hand_off", "answer", "block", "celebrate"].map((name) => [name, { opacity: 1, transition: { duration: 0.2 } }]));
  }
  return {
    idle: { y: [0, -2, 0], rotate: 0, transition: { duration: 3.2, repeat: Infinity, ease: "easeInOut" } },
    receive: { y: -6, rotate: -2, scale: 1.02, transition: { type: "spring", stiffness: 210, damping: 16 } },
    think: { y: -4, scale: [1, 1.025, 1], rotate: 0, transition: { duration: 1.5, repeat: Infinity, ease: "easeInOut" } },
    confident: { y: -4, rotate: [0, 3, 0], transition: { duration: 0.55 } },
    unsure: { y: -2, x: -3, rotate: -7, transition: { type: "spring", stiffness: 150, damping: 14 } },
    hand_off: { x: 12, y: -3, rotate: 3, transition: { type: "spring", stiffness: 120, damping: 14 } },
    answer: { y: -6, scale: 1.03, transition: { type: "spring", stiffness: 180, damping: 13 } },
    block: { x: 0, scale: 1.06, transition: { type: "spring", stiffness: 220, damping: 14 } },
    celebrate: { y: [0, -12, 0], rotate: [0, -3, 3, 0], transition: { duration: 0.72, repeat: 1 } },
  };
}

export const SvgCharacter = forwardRef<CharacterAnimator, CharacterProps>(function SvgCharacter({ kind, label, compact = false }, ref) {
  const [state, setState] = useState<CharacterState>("idle");
  const reduced = useReducedMotion() ?? false;
  const gradientId = `character-${useId().replace(/:/g, "")}`;
  const palette = palettes[kind];
  const thinking = state === "think";
  const cardVisible = ["receive", "hand_off", "answer", "block"].includes(state);

  useImperativeHandle(ref, () => ({ setState }), []);

  return (
    <div className={`character-wrap ${compact ? "is-compact" : ""}`} data-state={state}>
      <svg viewBox="0 0 190 220" role="img" aria-label={`${label}, ${state.replace("_", " ")}`}>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor={palette.from} />
            <stop offset="1" stopColor={palette.to} />
          </linearGradient>
          <filter id={`${gradientId}-glow`} x="-40%" y="-40%" width="180%" height="180%">
            <feGaussianBlur stdDeviation="7" result="blur" />
            <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
          </filter>
        </defs>

        <motion.ellipse cx="95" cy="199" rx="47" ry="9" fill="rgba(16,33,58,.12)" animate={{ scaleX: state === "celebrate" ? 0.75 : 1 }} />

        <motion.g variants={stateVariants(reduced)} animate={state} initial="idle" style={{ transformOrigin: "95px 175px" }}>
          {kind === "llama" && (
            <>
              <path d="M58 72L47 31Q45 20 54 18Q65 17 69 30L75 58" fill={`url(#${gradientId})`} stroke={palette.accent} strokeWidth="5" strokeLinecap="round" />
              <path d="M119 58L126 28Q130 15 141 19Q149 23 144 35L135 72" fill={`url(#${gradientId})`} stroke={palette.accent} strokeWidth="5" strokeLinecap="round" />
              <rect x="54" y="50" width="82" height="116" rx="38" fill={`url(#${gradientId})`} stroke={palette.accent} strokeWidth="5" />
              <path d="M59 132Q41 134 44 151Q48 161 60 155" fill="none" stroke={palette.accent} strokeWidth="7" strokeLinecap="round" />
              <path d="M129 132Q150 130 148 147" fill="none" stroke={palette.accent} strokeWidth="7" strokeLinecap="round" />
              <path d="M72 164L68 188M118 164L122 188" stroke={palette.accent} strokeWidth="8" strokeLinecap="round" />
            </>
          )}

          {kind === "gemma" && (
            <>
              <path d="M95 27L105 43L124 37L121 56L141 62L127 77" fill={`url(#${gradientId})`} stroke={palette.accent} strokeWidth="5" strokeLinejoin="round" />
              <rect x="49" y="49" width="92" height="119" rx="43" fill={`url(#${gradientId})`} stroke={palette.accent} strokeWidth="5" />
              <circle cx="58" cy="72" r="8" fill="#FFD27A" /><circle cx="131" cy="100" r="6" fill="#FFD27A" />
              <path d="M53 133Q33 138 41 154M137 133Q157 138 149 154" fill="none" stroke={palette.accent} strokeWidth="7" strokeLinecap="round" />
              <path d="M73 166L69 189M117 166L121 189" stroke={palette.accent} strokeWidth="8" strokeLinecap="round" />
            </>
          )}

          {kind === "guard" && (
            <>
              <path d="M95 31C119 45 140 48 146 48V111C146 145 125 165 95 178C65 165 44 145 44 111V48C57 47 76 43 95 31Z" fill={`url(#${gradientId})`} stroke={palette.accent} strokeWidth="5" strokeLinejoin="round" />
              <path d="M58 114Q32 105 31 84" fill="none" stroke={palette.accent} strokeWidth="8" strokeLinecap="round" />
              <motion.g animate={state === "block" ? { rotate: -8, y: -8 } : { rotate: 0, y: 0 }} style={{ transformOrigin: "146px 118px" }}>
                <path d="M136 123Q157 111 160 89" fill="none" stroke={palette.accent} strokeWidth="8" strokeLinecap="round" />
                <circle cx="160" cy="82" r="9" fill={palette.to} stroke={palette.accent} strokeWidth="4" />
              </motion.g>
              <path d="M77 174L74 193M113 174L116 193" stroke={palette.accent} strokeWidth="8" strokeLinecap="round" />
            </>
          )}

          {kind === "spark" && (
            <g filter={`url(#${gradientId}-glow)`}>
              <circle cx="66" cy="106" r="35" fill={`url(#${gradientId})`} stroke={palette.accent} strokeWidth="4" />
              <circle cx="101" cy="82" r="45" fill={`url(#${gradientId})`} stroke={palette.accent} strokeWidth="4" />
              <circle cx="133" cy="111" r="33" fill={`url(#${gradientId})`} stroke={palette.accent} strokeWidth="4" />
              <rect x="52" y="100" width="96" height="50" rx="25" fill={`url(#${gradientId})`} />
              <path d="M61 148Q43 157 48 174M137 148Q154 159 147 176" fill="none" stroke={palette.accent} strokeWidth="7" strokeLinecap="round" />
            </g>
          )}

          <g>
            <ellipse cx="79" cy={kind === "spark" ? 105 : 94} rx="8" ry="10" fill="#FFFFFF" />
            <ellipse cx="111" cy={kind === "spark" ? 105 : 94} rx="8" ry="10" fill="#FFFFFF" />
            <motion.circle cx={thinking ? 80 : 79} cy={thinking ? (kind === "spark" ? 102 : 91) : (kind === "spark" ? 106 : 95)} r="4" fill="#10213A" />
            <motion.circle cx={thinking ? 112 : 111} cy={thinking ? (kind === "spark" ? 102 : 91) : (kind === "spark" ? 106 : 95)} r="4" fill="#10213A" />
            <motion.path d={state === "unsure" ? "M87 121Q95 116 103 121" : "M86 118Q95 126 104 118"} fill="none" stroke="#10213A" strokeWidth="4" strokeLinecap="round" />
          </g>

          <AnimatePresence>
            {cardVisible && (
              <motion.g initial={{ opacity: 0, y: 10, scale: 0.8 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: 0.8 }}>
                <rect x="117" y="121" width="55" height="39" rx="8" fill="#FFFFFF" stroke={state === "block" ? "#C43D55" : "#0866FF"} strokeWidth="3" />
                <path d="M127 133H160M127 142H151" stroke="#A8B5C8" strokeWidth="3" strokeLinecap="round" />
                {state === "block" && <path d="M137 151V143Q137 135 145 135Q153 135 153 143V151M134 151H156V164H134Z" fill="#C43D55" />}
              </motion.g>
            )}
          </AnimatePresence>
        </motion.g>

        <AnimatePresence>
          {thinking && (
            <motion.g initial={{ opacity: 0, scale: 0.7 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0 }}>
              <circle cx="137" cy="40" r="7" fill="#FFFFFF" stroke="#AFCFFF" strokeWidth="3" />
              <rect x="141" y="8" width="42" height="27" rx="14" fill="#FFFFFF" stroke="#AFCFFF" strokeWidth="3" />
              {[151, 162, 173].map((cx, index) => <motion.circle key={cx} cx={cx} cy="21" r="3" fill="#0866FF" animate={{ opacity: [0.25, 1, 0.25] }} transition={{ duration: 1, repeat: Infinity, delay: index * 0.18 }} />)}
            </motion.g>
          )}
          {state === "unsure" && (
            <motion.text x="148" y="48" fontSize="34" fontWeight="800" fill="#0866FF" initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}>?</motion.text>
          )}
          {["confident", "celebrate"].includes(state) && (
            <motion.g initial={{ opacity: 0, scale: 0 }} animate={{ opacity: [0, 1, 1], scale: [0.5, 1.2, 1] }}>
              <path d="M153 52L157 62L167 66L157 70L153 80L149 70L139 66L149 62Z" fill="#FFB84A" />
            </motion.g>
          )}
        </AnimatePresence>
      </svg>
      <div className="character-name">{label}</div>
    </div>
  );
});
