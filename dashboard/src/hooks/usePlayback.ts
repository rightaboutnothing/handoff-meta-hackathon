import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { DemoScenario } from "../types";

export function usePlayback(scenario: DemoScenario, speed: number, initialElapsed = 0, autoplay = true) {
  const [elapsed, setElapsed] = useState(initialElapsed);
  const [playing, setPlaying] = useState(autoplay);
  const frameRef = useRef<number | null>(null);
  const lastRef = useRef<number | null>(null);

  const restart = useCallback(() => {
    setElapsed(initialElapsed);
    setPlaying(autoplay);
    lastRef.current = null;
  }, [autoplay, initialElapsed]);

  useEffect(() => {
    setElapsed(initialElapsed);
    setPlaying(autoplay);
    lastRef.current = null;
  }, [autoplay, initialElapsed, scenario.id]);

  useEffect(() => {
    if (!playing) {
      lastRef.current = null;
      return;
    }
    const tick = (now: number) => {
      if (lastRef.current === null) lastRef.current = now;
      const delta = (now - lastRef.current) * speed;
      lastRef.current = now;
      setElapsed((current) => {
        const next = Math.min(scenario.duration, current + delta);
        if (next >= scenario.duration) setPlaying(false);
        return next;
      });
      frameRef.current = requestAnimationFrame(tick);
    };
    frameRef.current = requestAnimationFrame(tick);
    return () => {
      if (frameRef.current !== null) cancelAnimationFrame(frameRef.current);
    };
  }, [playing, scenario.duration, speed]);

  const activeEvent = useMemo(() => {
    return [...scenario.events].reverse().find((item) => item.at <= elapsed) ?? scenario.events[0];
  }, [elapsed, scenario.events]);

  return {
    elapsed,
    progress: Math.min(1, elapsed / scenario.duration),
    activeEvent,
    playing,
    complete: elapsed >= scenario.duration,
    setPlaying,
    restart,
  };
}
