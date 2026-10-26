import { resolve } from "node:path";
import { runHandoff } from "../src/server/model-router.mjs";

const cases = [
  ["simple", "What is 2 + 2? Reply with just the number."],
  [
    "hard",
    "Design a production rollout strategy for a multi-model router, including threat modeling, evaluations, rollback criteria, and incident response.",
  ],
];
const logPath = resolve(".logs", `routing-confidence-${Date.now()}.jsonl`);

for (const [name, task] of cases) {
  const result = await runHandoff("meta-meta", task, { logPath });

  console.log(
    `${name} | ${result.decision} | confidence ${result.confidence.toFixed(2)} | ${result.firstResponderModelId} -> ${result.finalModelId}`,
  );
}
