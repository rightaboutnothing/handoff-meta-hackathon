import { resolve } from "node:path";
import { HANDOFF_PAIRINGS, runHandoff } from "../src/server/model-router.mjs";

const task =
  "Produce a concise five-bullet rollout plan for a hackathon AI router, covering architecture, evaluations, security, rollback, and judging risks.";
const logPath = resolve(".logs", `handoff-pairings-${Date.now()}.jsonl`);

for (const pairingName of Object.keys(HANDOFF_PAIRINGS)) {
  const result = await runHandoff(pairingName, task, { logPath });
  const chain = `${result.firstResponderModelId} -> ${result.finalModelId}`;
  const cost = result.costEstimateUsd.toFixed(6);

  console.log(
    `${result.pairing} (${result.handoffName}) | ${result.decision} | ${chain} | ${result.tokens.total} tokens | ${result.latencyMs} ms | ~$${cost}`,
  );
}
