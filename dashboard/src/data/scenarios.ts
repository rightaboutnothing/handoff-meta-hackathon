import type { DemoScenario, HandoffEvent } from "../types";

const event = (
  type: HandoffEvent["type"],
  step: HandoffEvent["step"],
  at: number,
  caption: string,
  actor: HandoffEvent["actor"],
  data: HandoffEvent["data"] = {},
): HandoffEvent => ({ id: `${type}-${at}`, type, step, at, caption, actor, data });

export const demoScenarios: DemoScenario[] = [
  {
    id: "easy",
    label: "Easy local answer",
    menuLabel: "Easy question: answered locally",
    prompt: "What is 15% of 80?",
    description: "A simple calculation stays on the device from start to finish.",
    duration: 6_200,
    events: [
      event("received", 1, 0, "The request lands safely on your device", "local"),
      event("screened", 2, 850, "Guard is checking this is safe to share", "guard", { status: "checking" }),
      event("screened", 2, 1_550, "Safe to process, and nothing has left your device", "guard", { status: "safe", confidence: 0.99 }),
      event("thinking", 3, 2_050, "Llama is working through the answer locally", "local", { latencyMs: 1_120 }),
      event("confidence", 4, 3_500, "Confidence is high enough to stay local", "local", { confidence: 0.94, reason: "Straightforward arithmetic" }),
      event("decision", 5, 4_250, "Handoff is not needed for this request", "local", { route: "local", reason: "Local confidence cleared the threshold" }),
      event("answered", 6, 5_050, "The local answer is ready", "local", { answer: "15% of 80 is 12.", route: "local", latencyMs: 1_306, costUsd: 0, savedUsd: 0.012 }),
    ],
  },
  {
    id: "hard",
    label: "Thoughtful cloud handoff",
    menuLabel: "Hard question: handed to cloud",
    prompt: "Compare two plausible explanations for why a rare scientific result might fail to replicate.",
    description: "The request is safe, but local confidence is low, so Guard approves a handoff.",
    duration: 9_400,
    events: [
      event("received", 1, 0, "The request lands safely on your device", "local"),
      event("screened", 2, 800, "Guard is checking this is safe to share", "guard", { status: "checking" }),
      event("screened", 2, 1_500, "Guard confirms the request is safe", "guard", { status: "safe", confidence: 0.97 }),
      event("thinking", 3, 2_000, "Llama tries the hard question first", "local", { latencyMs: 1_550 }),
      event("confidence", 4, 3_600, "Local confidence is below the answer threshold", "local", { confidence: 0.46, reason: "The comparison needs deeper scientific reasoning" }),
      event("decision", 5, 4_350, "A safe cloud handoff will improve the answer", "local", { route: "cloud", reason: "Safe request with low local confidence" }),
      event("handed_off", 5, 5_200, "Guard approves one careful handoff", "guard", { route: "cloud" }),
      event("thinking", 5, 6_250, "Spark is adding deeper reasoning in the cloud", "cloud", { latencyMs: 2_840 }),
      event("answered", 6, 8_200, "The stronger cloud answer is ready", "cloud", { answer: "The result may reflect an underpowered original study or an uncontrolled contextual variable. Replication design should test both possibilities.", route: "cloud", latencyMs: 4_390, costUsd: 0.018, savedUsd: 0 }),
    ],
  },
  {
    id: "blocked",
    label: "Protected locally",
    menuLabel: "Unsafe category: blocked locally",
    prompt: "[blocked example: harmful request]",
    description: "The local safety screen blocks the category before any cloud route can begin.",
    duration: 5_400,
    events: [
      event("received", 1, 0, "A redacted request lands on your device", "local"),
      event("screened", 2, 900, "Guard is checking this is safe to share", "guard", { status: "checking" }),
      event("blocked", 2, 2_100, "Kept local, never sent", "guard", { status: "blocked", route: "blocked_local", reason: "The local safety screen identified a harmful category" }),
    ],
  },
];

export const stepLabels = [
  { number: 1, label: "Received" },
  { number: 2, label: "Safety screen" },
  { number: 3, label: "Local thinking" },
  { number: 4, label: "Confidence" },
  { number: 5, label: "Decision" },
  { number: 6, label: "Answer" },
] as const;
