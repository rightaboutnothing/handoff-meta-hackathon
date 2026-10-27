import { useSyncExternalStore } from "react";

const query = "(prefers-reduced-motion: reduce)";
const subscribe = (notify: () => void) => {
  const media = window.matchMedia(query);
  media.addEventListener("change", notify);
  return () => media.removeEventListener("change", notify);
};

// Listen for preference changes while the dashboard is already open.
export function useMotionPreference() {
  return useSyncExternalStore(subscribe, () => window.matchMedia(query).matches, () => true);
}
