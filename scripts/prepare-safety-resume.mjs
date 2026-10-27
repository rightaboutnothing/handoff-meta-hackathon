import { appendFile, readFile, writeFile } from "node:fs/promises";
import {
  HANDOFF_PAIRINGS,
  HANDOFF_RUN_ORDER,
} from "../src/server/model-router.mjs";
import { SUITE_ORDER } from "../src/scoring/metrics.mjs";
import {
  SAFETY_METHOD_VERSION,
  buildEffectiveResults,
  isOfflineMetaEligible,
  resultKey,
} from "../src/scoring/resume-plan.mjs";

const runDirectory = new URL(
  "../.logs/benchmark-full-50-seed-20261027/",
  import.meta.url,
);
const resultsPath = new URL("results.jsonl", runDirectory);
const tracePath = new URL("trace.jsonl", runDirectory);
const statePath = new URL("state.json", runDirectory);
const planPath = new URL("resume-plan.json", runDirectory);

async function readJsonl(path) {
  const records = [];
  for (const line of (await readFile(path, "utf8")).split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      records.push(JSON.parse(line));
    } catch {
      // A killed process may leave one partial trailing line; raw data is retained.
    }
  }
  return records;
}

async function appendJsonl(entry) {
  await appendFile(resultsPath, `\n${JSON.stringify(entry)}\n`, "utf8");
}

async function loadTaskIds() {
  const tasks = [];
  for (const suite of SUITE_ORDER) {
    const path =
      suite === "gpqa"
        ? new URL("../.cache/gpqa.jsonl", import.meta.url)
        : new URL(`../tasks/${suite}.jsonl`, import.meta.url);
    const rows = (await readFile(path, "utf8"))
      .trim()
      .split(/\r?\n/)
      .map((line) => JSON.parse(line));
    tasks.push(...rows.slice(0, 50).map((row) => ({ id: row.id, suite })));
  }
  return tasks;
}

const records = await readJsonl(resultsPath);
const trace = await readJsonl(tracePath);
const rawResults = records.filter(
  (record) => record.recordType === "task_result",
);
const selection = buildEffectiveResults(rawResults);
const effectiveKeys = new Set(selection.effectiveResults.map(resultKey));
const tasks = await loadTaskIds();

if (
  !records.some(
    (record) =>
      record.recordType === "method_change" &&
      record.methodVersion === SAFETY_METHOD_VERSION,
  )
) {
  await appendJsonl({
    recordType: "method_change",
    timestamp: new Date().toISOString(),
    methodVersion: SAFETY_METHOD_VERSION,
    reason:
      "Local pre-escalation safety screen; StrongREJECT local-only; XSTest safety over-block rescore.",
  });
}

const alreadyMarked = new Set(
  records
    .filter(
      (record) =>
        record.recordType === "result_status_update" &&
        record.methodVersion === SAFETY_METHOD_VERSION,
    )
    .map((record) => `${record.pairing}|${record.taskId}`),
);
for (const pending of selection.pendingReruns) {
  if (alreadyMarked.has(pending.key)) continue;
  await appendJsonl({
    recordType: "result_status_update",
    timestamp: new Date().toISOString(),
    methodVersion: SAFETY_METHOD_VERSION,
    pairing: pending.result.pairing,
    taskId: pending.result.taskId,
    suite: pending.result.suite,
    previousStatus: pending.result.status,
    status: "pending_rerun",
    reasons: pending.reasons,
  });
}

const offlinePendingByPairing = Object.fromEntries(
  HANDOFF_RUN_ORDER.map((pairing) => [pairing, 0]),
);
const deferredByPairing = Object.fromEntries(
  HANDOFF_RUN_ORDER.map((pairing) => [pairing, 0]),
);
for (const pairing of HANDOFF_RUN_ORDER) {
  for (const task of tasks) {
    if (effectiveKeys.has(`${pairing}|${task.id}`)) continue;
    const offlineEligible = isOfflineMetaEligible({
      suite: task.suite,
      escalationRoute: HANDOFF_PAIRINGS[pairing].escalationRoute,
    });
    if (offlineEligible) offlinePendingByPairing[pairing] += 1;
    else deferredByPairing[pairing] += 1;
  }
}

const cloudStrongRejectKeys = new Set(
  trace
    .filter(
      (entry) =>
        entry.event === "request_started" &&
        entry.stage === "escalation" &&
        entry.suite === "strongreject" &&
        ["muse-spark-1.3", "x-ai/grok-4.7"].includes(entry.modelId),
    )
    .map((entry) => `${entry.pairing}|${entry.taskId}`),
);
const plan = {
  generatedAt: new Date().toISOString(),
  status: "paused",
  methodVersion: SAFETY_METHOD_VERSION,
  rawSavedResults: rawResults.length,
  effectiveResults: selection.effectiveResults.length,
  pendingRerunResults: selection.pendingReruns.length,
  terminalMeta403Pending: selection.pendingReruns.filter((pending) =>
    pending.reasons.includes("meta_403"),
  ).length,
  legacyStrongRejectPending: selection.pendingReruns.filter((pending) =>
    pending.reasons.includes("strongreject_local_only_rescore"),
  ).length,
  legacyXSTestPending: selection.pendingReruns.filter((pending) =>
    pending.reasons.includes("xstest_safety_screen_rescore"),
  ).length,
  uniqueStrongRejectTasksPreviouslySentCloud: cloudStrongRejectKeys.size,
  offlineMetaEligible: Object.values(offlinePendingByPairing).reduce(
    (sum, count) => sum + count,
    0,
  ),
  offlinePendingByPairing,
  deferredUntilMetaRestored: Object.values(deferredByPairing).reduce(
    (sum, count) => sum + count,
    0,
  ),
  deferredByPairing,
};

await writeFile(planPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
await writeFile(
  statePath,
  `${JSON.stringify(
    {
      updatedAt: new Date().toISOString(),
      pid: null,
      status: "paused",
      methodVersion: SAFETY_METHOD_VERSION,
      completedItems: selection.effectiveResults.length,
      totalItems: 1200,
      resumePlan: {
        offlineMetaEligible: plan.offlineMetaEligible,
        deferredUntilMetaRestored: plan.deferredUntilMetaRestored,
      },
    },
    null,
    2,
  )}\n`,
  "utf8",
);

console.log(JSON.stringify(plan, null, 2));
