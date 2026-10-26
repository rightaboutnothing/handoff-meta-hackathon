import { resolve } from "node:path";
import {
  HANDOFF_PAIRINGS,
  HANDOFF_RUN_ORDER,
  runHandoff,
  warmUpLocalRoute,
} from "../src/server/model-router.mjs";

const task =
  "Produce a concise five-bullet rollout plan for a hackathon AI router, covering architecture, evaluations, security, rollback, and judging risks.";
const logPath = resolve(".logs", `handoff-pairings-${Date.now()}.jsonl`);
const groups = [
  { route: "llama", pairings: HANDOFF_RUN_ORDER.slice(0, 2) },
  { route: "gemma", pairings: HANDOFF_RUN_ORDER.slice(2) },
];

for (const group of groups) {
  await warmUpLocalRoute(group.route, {
    logPath,
    pairings: group.pairings,
  });

  for (const pairingName of group.pairings) {
    const result = await runHandoff(pairingName, task, { logPath });
    const chain = `${result.firstResponderModelId} -> ${result.finalModelId}`;
    const cost = result.costEstimateUsd.toFixed(6);

    console.log(
      `${result.pairing} (${HANDOFF_PAIRINGS[pairingName].name}) | ${result.decision} @ ${result.confidence.toFixed(2)} | ${chain} | ${result.tokens.total} tokens | ${result.latencyMs} ms | ~$${cost}`,
    );
  }
}
