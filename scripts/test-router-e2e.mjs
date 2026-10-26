import { resolve } from "node:path";
import { runFirstResponderTask } from "../src/server/model-router.mjs";

const task =
  "Create a three-stage launch plan for a hackathon AI app, covering architecture, testing, and judging risks.";
const logPath = resolve(".logs", `router-e2e-${Date.now()}.jsonl`);
const result = await runFirstResponderTask(task, { logPath });

console.log(JSON.stringify({ task, logPath, ...result }));
