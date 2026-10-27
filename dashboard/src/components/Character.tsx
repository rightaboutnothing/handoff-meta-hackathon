import { AnimatePresence, motion, type Variants } from "framer-motion";
import { forwardRef, useEffect, useId, useImperativeHandle, useState } from "react";
import type { CharacterAnimator, CharacterKind, CharacterState } from "../types";
import { useMotionPreference } from "../hooks/useMotionPreference";

interface CharacterProps { kind: CharacterKind; label: string; compact?: boolean }

const palettes: Record<CharacterKind, { light: string; main: string; shade: string; edge: string }> = {
  llama: { light: "#FFF1BD", main: "#F7BA52", shade: "#C67B24", edge: "#FFDB85" },
  gemma: { light: "#BEFFF3", main: "#33C6B8", shade: "#087F87", edge: "#7AEBDB" },
  guard: { light: "#B5FBD8", main: "#31C689", shade: "#078058", edge: "#70E2AE" },
  spark: { light: "#D7EFFF", main: "#5DADFF", shade: "#0866FF", edge: "#9FD5FF" },
};
const bodies: Record<CharacterKind, string> = {
  llama: "M63 105C63 71 87 57 120 57C153 57 177 71 177 105L180 170C182 206 160 228 120 228C80 228 58 206 60 170Z",
  gemma: "M63 98C63 69 82 57 104 58L120 39L136 58C158 57 177 69 177 98L185 165C189 203 164 228 120 228C76 228 51 203 55 165Z",
  guard: "M120 52C144 67 165 72 184 75L179 153C177 188 151 214 120 232C89 214 63 188 61 153L56 75C75 72 96 67 120 52Z",
  spark: "M120 47C145 47 155 65 159 81C188 79 201 98 197 119C217 138 207 166 183 174C178 204 155 214 136 205C117 224 91 214 84 195C55 203 35 182 43 158C19 139 28 112 53 104C50 80 70 66 92 73C97 56 106 47 120 47Z",
};

function poses(reduced: boolean, floating: boolean): Variants {
  if (reduced) return Object.fromEntries(["idle", "receive", "think", "confident", "unsure", "hand_off", "answer", "block", "celebrate"].map(name => [name, { x: 0, y: 0, rotate: 0, scaleX: 1, scaleY: 1, opacity: 1, transition: { duration: 0.12 } }]));
  const spring = { type: "spring" as const, stiffness: 180, damping: 17, mass: 0.9 };
  return {
    idle: { x: 0, y: [0, floating ? -8 : -3, 0], rotate: 0, scaleX: [1, 1.012, 1], scaleY: [1, 1.015, 1], transition: { duration: floating ? 4 : 3.8, repeat: Infinity, ease: "easeInOut" } },
    receive: { x: 0, y: [0, 5, -3], rotate: -3, scaleX: [1, 1.045, 1], scaleY: [1, 0.96, 1.02], transition: { duration: 0.55, ease: "easeOut" } },
    think: { x: 0, y: [0, -3, 0], rotate: -2, scaleX: 1, scaleY: 1, transition: { duration: 2.6, repeat: Infinity, ease: "easeInOut" } },
    confident: { x: 0, y: [0, 5, -2, 0], rotate: [0, 3, 0], scaleX: 1, scaleY: 1, transition: { duration: 0.65, ease: "easeInOut" } },
    unsure: { x: -3, y: 0, rotate: -8, scaleX: 1, scaleY: 1, transition: spring },
    hand_off: { x: 18, y: [0, 5, -8, -2], rotate: 7, scaleX: [1, 1.08, 0.96, 1], scaleY: [1, 0.94, 1.05, 1], transition: { duration: 0.75, ease: "easeInOut" } },
    answer: { x: 0, y: -4, rotate: 0, scaleX: 1.015, scaleY: 1.015, transition: spring },
    block: { x: 0, y: -2, rotate: 0, scaleX: 1.05, scaleY: 1.03, transition: spring },
    celebrate: { x: 0, y: [0, -13, 1, -5, 0], rotate: [0, -4, 4, 0], scaleX: [1, 0.97, 1.04, 1], scaleY: [1, 1.04, 0.97, 1], transition: { duration: 0.95, ease: "easeInOut" } },
  };
}

export const SvgCharacter = forwardRef<CharacterAnimator, CharacterProps>(function SvgCharacter({ kind, label, compact = false }, ref) {
  const [state, setState] = useState<CharacterState>("idle");
  const [blink, setBlink] = useState(false);
  const reduced = useMotionPreference();
  const id = `mascot-${useId().replace(/[^A-Za-z0-9]/g, "")}`;
  const color = palettes[kind];
  const thinking = state === "think";
  const happy = ["confident", "answer", "celebrate"].includes(state);
  const worried = state === "unsure";
  const holding = ["receive", "hand_off", "answer", "block"].includes(state);
  const faceY = kind === "spark" ? 125 : kind === "guard" ? 124 : 129;
  const fill = (name: string) => `url(#${id}-${name})`;
  useImperativeHandle(ref, () => ({ setState }), []);
  useEffect(() => {
    if (reduced) { setBlink(false); return; }
    let timer: ReturnType<typeof setTimeout>;
    let reopen: ReturnType<typeof setTimeout>;
    const schedule = () => {
      timer = setTimeout(() => {
        setBlink(true);
        reopen = setTimeout(() => { setBlink(false); schedule(); }, 130);
      }, 2700 + Math.random() * 3300);
    };
    schedule();
    return () => { clearTimeout(timer); clearTimeout(reopen); };
  }, [reduced]);

  return (
    <div className={`character-wrap ${compact ? "is-compact" : ""}`} data-state={state} data-kind={kind}>
      <svg key={reduced ? "reduced" : "motion"} viewBox="0 0 240 280" role="img" aria-label={`${label}, ${state.replace("_", " ")}`}>
        <defs>
          <radialGradient id={`${id}-body`} cx="30%" cy="23%" r="91%"><stop stopColor={color.light} /><stop offset="0.46" stopColor={color.main} /><stop offset="1" stopColor={color.shade} /></radialGradient>
          <linearGradient id={`${id}-rim`} x1="0" y1="0" x2="0.85" y2="1"><stop stopColor="#FFFFFF" stopOpacity="0.85" /><stop offset="0.45" stopColor={color.edge} stopOpacity="0.6" /><stop offset="1" stopColor={color.shade} stopOpacity="0.3" /></linearGradient>
          <radialGradient id={`${id}-shine`} cx="25%" cy="10%" r="80%"><stop stopColor="#FFFFFF" stopOpacity="0.6" /><stop offset="0.72" stopColor="#FFFFFF" stopOpacity="0" /></radialGradient>
          <linearGradient id={`${id}-limb`} x1="0" y1="0" x2="1" y2="1"><stop stopColor={color.edge} /><stop offset="0.6" stopColor={color.main} /><stop offset="1" stopColor={color.shade} /></linearGradient>
          <radialGradient id={`${id}-iris`} cx="35%" cy="25%" r="85%"><stop stopColor="#324463" /><stop offset="0.56" stopColor="#112038" /><stop offset="1" stopColor="#06101E" /></radialGradient>
          <linearGradient id={`${id}-white`} x1="0" y1="0" x2="0.7" y2="1"><stop stopColor="#FFFFFF" /><stop offset="1" stopColor="#DCE8EE" /></linearGradient>
          <linearGradient id={`${id}-cloud`} x1="0" y1="0" x2="0" y2="1"><stop stopColor="#EAF6FF" /><stop offset="1" stopColor="#86BFF2" /></linearGradient>
          <filter id={`${id}-inner`} x="-20%" y="-20%" width="140%" height="140%" colorInterpolationFilters="sRGB"><feOffset dx="0" dy="3" /><feGaussianBlur stdDeviation="4" /><feComposite operator="out" in2="SourceGraphic" /><feColorMatrix values="0 0 0 0 0.02 0 0 0 0 0.10 0 0 0 0 0.20 0 0 0 .22 0" /><feComposite operator="in" in2="SourceGraphic" /><feComposite operator="over" in2="SourceGraphic" /></filter>
          <radialGradient id={`${id}-halo`}><stop stopColor={color.main} stopOpacity="0.3" /><stop offset="1" stopColor={color.main} stopOpacity="0" /></radialGradient>
        </defs>
        <motion.ellipse cx="120" cy="260" rx={kind === "guard" ? 55 : 69} ry="12" fill="#020C1E" opacity="0.3" style={{ transformOrigin: "120px 260px" }} animate={reduced ? { opacity: 0.25 } : { scaleX: [1, kind === "spark" ? 0.82 : 0.95, 1], opacity: [0.3, 0.19, 0.3] }} transition={reduced ? { duration: 0.12 } : { duration: kind === "spark" ? 4 : 3.8, repeat: Infinity, ease: "easeInOut" }} />
        {kind === "spark" && <circle cx="120" cy="128" r="116" fill={fill("halo")} />}
        <motion.g variants={poses(reduced, kind === "spark")} animate={state} initial={false} style={{ transformOrigin: "120px 215px" }}>
          {kind !== "spark" && <g fill={fill("limb")}><rect x="81" y="212" width="25" height="35" rx="12" transform="rotate(7 94 226)" /><rect x="134" y="212" width="25" height="35" rx="12" transform="rotate(-7 146 226)" /><ellipse cx="92" cy="242" rx="18" ry="8" fill={color.shade} /><ellipse cx="147" cy="242" rx="18" ry="8" fill={color.shade} /></g>}
          {kind === "llama" && <g><path d="M72 92L57 37C54 23 61 15 71 17C83 18 88 28 89 41L92 75Z" fill={fill("body")} stroke={fill("rim")} strokeWidth="2" /><path d="M148 75L151 40C152 26 159 17 169 17C180 17 185 25 181 39L168 92Z" fill={fill("body")} stroke={fill("rim")} strokeWidth="2" /><path d="M72 36L81 73M166 36L159 73" stroke="#D98B4B" strokeWidth="9" strokeLinecap="round" opacity="0.55" /></g>}
          <motion.g animate={reduced ? {} : { rotate: state === "receive" ? -24 : state === "celebrate" ? -19 : 0 }} style={{ transformOrigin: "67px 157px" }} transition={{ type: "spring", stiffness: 180, damping: 17 }}><path d="M66 150C48 149 37 164 43 179C46 185 53 187 57 183" fill="none" stroke={color.shade} strokeWidth="17" strokeLinecap="round" /><path d="M66 148C48 147 38 160 43 175" fill="none" stroke={fill("limb")} strokeWidth="14" strokeLinecap="round" /></motion.g>
          <motion.g animate={reduced ? {} : { rotate: state === "block" ? -40 : state === "hand_off" ? -55 : state === "answer" ? -25 : 0 }} style={{ transformOrigin: "173px 151px" }} transition={{ type: "spring", stiffness: 180, damping: 17 }}><path d="M173 151C189 152 199 165 194 180" fill="none" stroke={color.shade} strokeWidth="17" strokeLinecap="round" /><path d="M173 148C189 149 198 162 193 176" fill="none" stroke={fill("limb")} strokeWidth="14" strokeLinecap="round" />{state === "block" && <g transform="translate(192 175)"><rect x="-10" y="-19" width="20" height="25" rx="9" fill={color.light} /><path d="M-5 -13V-18M1 -13V-20M7 -11V-16" stroke={color.main} strokeWidth="3" strokeLinecap="round" /></g>}</motion.g>
          <path d={bodies[kind]} fill={fill("body")} stroke={fill("rim")} strokeWidth="2.5" filter={fill("inner")} />
          <path d={bodies[kind]} fill={fill("shine")} />
          {kind === "llama" && <g><path d="M84 67Q91 56 101 64Q111 53 123 62Q135 52 146 65" fill="none" stroke="#FFF4D0" strokeWidth="12" strokeLinecap="round" opacity="0.8" /><ellipse cx="120" cy="165" rx="33" ry="26" fill="#FFF1D3" opacity="0.88" /><path d="M116 158Q120 154 124 158L120 162Z" fill="#A96633" /></g>}
          {kind === "gemma" && <g><path d="M100 65L120 45L134 64L120 76Z" fill="#D6FFF5" opacity="0.6" /><path d="M72 178Q120 210 168 178" fill="none" stroke="#ACFFF0" strokeWidth="2" opacity="0.35" /><circle cx="75" cy="94" r="4" fill="#E6FFF8" opacity="0.7" /></g>}
          {kind === "guard" && <g><path d="M120 66C138 77 157 82 173 84L168 150C166 177 145 198 120 213C95 198 74 177 72 150L67 84C84 82 102 77 120 66Z" fill="none" stroke="#CBFFE4" strokeOpacity="0.55" strokeWidth="2" /><path d="M110 193L118 200L132 184" fill="none" stroke="#D8FFEB" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" /></g>}
          {kind === "spark" && <g><path d="M57 226C54 215 62 207 72 209C77 193 97 193 104 204C115 197 127 202 130 213C141 210 154 218 152 229Z" fill={fill("cloud")} opacity="0.9" /><path d="M168 62L172 74L184 78L172 82L168 94L164 82L152 78L164 74Z" fill="#D8F4FF" opacity="0.85" /></g>}
          <g data-expression={worried ? "unsure" : happy ? "happy" : thinking ? "thinking" : state === "block" ? "blocked" : "idle"}>
            <motion.g animate={{ scaleY: blink ? 0.08 : 1 }} transition={{ duration: reduced ? 0 : 0.065 }} style={{ transformOrigin: `120px ${faceY}px` }}>
              {[95, 145].map(x => <g key={x}><ellipse cx={x} cy={faceY + 1} rx="16" ry="22" fill={color.shade} opacity="0.2" /><ellipse cx={x} cy={faceY - 1} rx="15" ry="21" fill={fill("white")} /><motion.g animate={reduced ? {} : { x: thinking ? 2 : state === "hand_off" ? 3 : worried ? -2 : 0, y: thinking ? -6 : 0 }} transition={{ duration: 0.3 }}><ellipse cx={x + 1} cy={faceY + 1} rx="9.5" ry="13.5" fill={fill("iris")} /><ellipse cx={x - 2} cy={faceY - 5} rx="3.5" ry="4.5" fill="#FFFFFF" opacity="0.98" /><circle cx={x + 5} cy={faceY + 6} r="2" fill="#FFFFFF" opacity="0.7" /></motion.g></g>)}
            </motion.g>
            <g fill="none" stroke="#163349" strokeWidth="3.5" strokeLinecap="round">{worried ? <path d={`M110 ${faceY + 37}Q120 ${faceY + 30} 130 ${faceY + 37}`} /> : happy ? <path d={`M107 ${faceY + 33}Q120 ${faceY + 49} 133 ${faceY + 33}`} /> : thinking ? <ellipse cx="122" cy={faceY + 35} rx="5" ry="3" /> : <path d={`M110 ${faceY + 34}Q120 ${faceY + 43} 130 ${faceY + 34}`} />}</g>
            {worried && <g stroke="#163349" strokeWidth="3" strokeLinecap="round"><path d={`M83 ${faceY - 28}L101 ${faceY - 32}`} /><path d={`M136 ${faceY - 32}L153 ${faceY - 26}`} /></g>}
            {happy && <g fill="#FFFFFF" opacity="0.23"><ellipse cx="78" cy={faceY + 23} rx="10" ry="5" /><ellipse cx="162" cy={faceY + 23} rx="10" ry="5" /></g>}
          </g>
          <AnimatePresence>{holding && <motion.g key="held-card" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}><g transform={state === "hand_off" ? "translate(171 139) rotate(12)" : "translate(155 174) rotate(-8)"}><rect width="57" height="43" rx="10" fill="#06172D" opacity="0.2" transform="translate(0 4)" /><rect width="57" height="43" rx="10" fill="#F5FBFF" stroke={state === "block" ? "#F46B85" : "#9DCFFF"} strokeWidth="1.5" />{state === "block" ? <g transform="translate(20 9)"><path d="M3 10V6A6 6 0 0 1 15 6V10" fill="none" stroke="#C73554" strokeWidth="2.5" /><rect y="9" width="18" height="15" rx="4" fill="#C73554" /><circle cx="9" cy="16" r="2" fill="#FFFFFF" /></g> : <g stroke="#6BA5DD" strokeWidth="3" strokeLinecap="round"><path d="M12 14H43M12 23H36M12 31H27" /></g>}</g></motion.g>}</AnimatePresence>
        </motion.g>
        <AnimatePresence>
          {thinking && <motion.g key="thought" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: 0.2 }}><motion.ellipse cx="120" cy="119" rx="88" ry="68" fill="none" stroke={color.edge} strokeWidth="1" strokeDasharray="3 12" animate={reduced ? { opacity: 0.3 } : { rotate: [0, 15, 0], opacity: [0.2, 0.6, 0.2] }} transition={reduced ? { duration: 0.12 } : { duration: 3, repeat: Infinity, ease: "easeInOut" }} style={{ transformOrigin: "120px 119px" }} /><circle cx="173" cy="58" r="5" fill="#EFF8FF" /><circle cx="184" cy="43" r="7" fill="#EFF8FF" /><rect x="168" y="2" width="68" height="36" rx="18" fill="#EFF8FF" stroke="#AED8FF" strokeWidth="1.5" />{[186, 202, 218].map((x, index) => <motion.circle key={x} cx={x} cy="20" r="4" fill="#0866FF" animate={reduced ? { opacity: 1 } : { opacity: [0.3, 1, 0.3], y: [0, -3, 0] }} transition={reduced ? { duration: 0.12 } : { duration: 1.2, repeat: Infinity, delay: index * 0.16, ease: "easeInOut" }} />)}</motion.g>}
          {worried && <motion.g key="question" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><circle cx="189" cy="60" r="18" fill="#EAF4FF" /><text x="189" y="67" textAnchor="middle" fill="#0866FF" fontSize="24" fontWeight="700">?</text></motion.g>}
          {happy && <motion.g key="sparkles" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}><path d="M193 52L197 63L208 67L197 71L193 82L189 71L178 67L189 63Z" fill={color.light} /><circle cx="49" cy="87" r="4" fill={color.light} /></motion.g>}
          {kind === "guard" && state === "block" && <motion.path key="shield-pulse" d={bodies.guard} fill="none" stroke="#74F5BB" strokeWidth="2" style={{ transformOrigin: "120px 142px" }} initial={{ opacity: 0 }} animate={reduced ? { opacity: 0.55 } : { scale: [1, 1.36], opacity: [0.65, 0] }} transition={reduced ? { duration: 0.12 } : { duration: 1.8, repeat: Infinity, ease: "easeOut" }} />}
        </AnimatePresence>
      </svg>
      <div className="character-name">{label}</div>
    </div>
  );
});
