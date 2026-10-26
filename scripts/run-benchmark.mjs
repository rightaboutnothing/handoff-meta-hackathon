import "dotenv/config";
import { access, appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import {
  BENCHMARK_SETTINGS,
  HANDOFF_PAIRINGS,
  HANDOFF_RUN_ORDER,
  runHandoff,
  warmUpLocalRoute,
} from "../src/server/model-router.mjs";
import { checkCanaryLeaks } from "../src/scoring/canary-check.mjs";
import { GRADER_MODEL_ID, gradeAnswer } from "../src/scoring/grader.mjs";
import {
  SUITE_ORDER,
  looksLikeRefusal,
  renderSummaryTable,
  summarizeResults,
} from "../src/scoring/metrics.mjs";

const SEED = 20261027;
const args = new Set(process.argv.slice(2));
const full = args.has("--full");
const limitArgumentIndex = process.argv.indexOf("--limit");
const limit = full
  ? 20
  : limitArgumentIndex >= 0
    ? Number(process.argv[limitArgumentIndex + 1])
    : 3;

if (!Number.isInteger(limit) || limit < 1 || limit > 20) {
  throw new Error("--limit must be an integer from 1 to 20.");
}

const mode = full ? "full" : `dry-${limit}`;
const timestamp = Date.now();
const resultsPath = new URL(
  `../.logs/benchmark-${mode}-${timestamp}-results.jsonl`,
  import.meta.url,
);
const tracePath = new URL(
  `../.logs/benchmark-${mode}-${timestamp}-trace.jsonl`,
  import.meta.url,
);
const summaryPath = new URL(
  `../.logs/benchmark-${mode}-${timestamp}-summary.json`,
  import.meta.url,
);
const resultsFile = fileURLToPath(resultsPath);
const traceFile = fileURLToPath(tracePath);

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(path) {
  return (await readFile(path, "utf8"))
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

async function loadSuites() {
  const suites = {};
  const skipped = [];
  for (const suite of SUITE_ORDER) {
    let path = new URL(`../tasks/${suite}.jsonl`, import.meta.url);
    if (suite === "gpqa") {
      const cachePath = new URL("../.cache/gpqa.jsonl", import.meta.url);
      if (await fileExists(cachePath)) {
        path = cachePath;
      } else {
        skipped.push("gpqa (gated cache absent; run npm run tasks:fetch-gpqa after accepting its terms)");
        suites[suite] = [];
        continue;
      }
    }
    suites[suite] = (await readJsonl(path)).slice(0, limit);
  }
  return { suites, skipped };
}

async function appendJsonl(path, entry) {
  await appendFile(path, `${JSON.stringify(entry)}\n`, "utf8");
}

const runSettings = Object.freeze({
  seed: SEED,
  mode,
  itemsPerSuite: limit,
  graderModelId: GRADER_MODEL_ID,
  pairingRunOrder: HANDOFF_RUN_ORDER,
  ...BENCHMARK_SETTINGS,
});

await mkdir(new URL("../.logs/", import.meta.url), { recursive: true });
const { suites, skipped } = await loadSuites();
const tasks = SUITE_ORDER.flatMap((suite) => suites[suite]);

await appendJsonl(resultsPath, {
  recordType: "benchmark_start",
  timestamp: new Date().toISOString(),
  settings: runSettings,
  skipped,
});

const allResults = [];
const localGroups = [
  { route: "llama", pairings: ["meta-meta", "meta-grok"] },
  { route: "gemma", pairings: ["gemma-meta", "gemma-grok"] },
];

for (const group of localGroups) {
  console.log(`Warming ${group.route} for ${group.pairings.join(", ")} (excluded).`);
  await warmUpLocalRoute(group.route, {
    logPath: traceFile,
    pairings: group.pairings,
  });

  for (const pairing of group.pairings) {
    console.log(
      `Running ${HANDOFF_PAIRINGS[pairing].name}: ${tasks.length} tasks in fixed suite order.`,
    );
    for (const task of tasks) {
      try {
        const handoff = await runHandoff(pairing, task.prompt, {
          logPath: traceFile,
          captureEscalationPayload: true,
          logContext: { taskId: task.id, suite: task.suite },
        });
        const canaryLeaks = checkCanaryLeaks({
          sourceText: task.prompt,
          escalationPayload: handoff.escalationPayload,
          finalOutput: handoff.outputText,
          expectedCanaries:
            task.reference_answer_or_rubric?.forbidden_canaries ?? [],
        });
        const grader = await gradeAnswer({
          suite: task.suite,
          prompt: task.prompt,
          referenceAnswerOrRubric: task.reference_answer_or_rubric,
          answer: handoff.outputText,
        });
        const result = {
          recordType: "task_result",
          status: "ok",
          timestamp: new Date().toISOString(),
          benchmarkMode: mode,
          settings: runSettings,
          runId: handoff.runId,
          pairing,
          handoffName: handoff.handoffName,
          taskId: task.id,
          suite: task.suite,
          source: task.source,
          licence: task.licence,
          routeChosen: handoff.routeChosen,
          routeDecision: handoff.decision,
          routingConfidence: handoff.confidence,
          routingReason: handoff.decisionReason,
          firstResponderModelId: handoff.firstResponderModelId,
          finalModelId: handoff.finalModelId,
          outputText: handoff.outputText,
          refused: looksLikeRefusal(handoff.outputText),
          canaryLeaks,
          steps: handoff.steps,
          handoffTokens: handoff.tokens,
          handoffLatencyMs: handoff.latencyMs,
          handoffCostEstimateUsd: handoff.costEstimateUsd,
          grader,
          totalCostEstimateUsd: Number(
            (handoff.costEstimateUsd + grader.costEstimateUsd).toFixed(8),
          ),
        };
        allResults.push(result);
        await appendJsonl(resultsPath, result);
      } catch (error) {
        const result = {
          recordType: "task_result",
          status: "error",
          timestamp: new Date().toISOString(),
          benchmarkMode: mode,
          settings: runSettings,
          pairing,
          handoffName: HANDOFF_PAIRINGS[pairing].name,
          taskId: task.id,
          suite: task.suite,
          error: error instanceof Error ? error.message : String(error),
        };
        allResults.push(result);
        await appendJsonl(resultsPath, result);
        console.error(`${pairing}/${task.id}: ${result.error}`);
      }
    }
  }
}

const summaries = summarizeResults(allResults, skipped);
const summary = {
  generatedAt: new Date().toISOString(),
  settings: runSettings,
  skipped,
  resultsPath: resultsFile,
  tracePath: traceFile,
  summaries,
};
await writeFile(summaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");

console.log("\nBenchmark summary");
console.log(renderSummaryTable(summaries));
if (skipped.length > 0) {
  console.log(`\nSkipped: ${skipped.join("; ")}`);
}
console.log(`Results: ${resultsFile}`);
console.log(`Trace: ${traceFile}`);
