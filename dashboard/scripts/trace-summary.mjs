import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const hash = (text) => createHash("sha256").update(text).digest("hex");
const parseJsonl = (text) => text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));

// Only event metadata is exported. Raw prompts, outputs and payloads stay local.
export function summarizeRequestTrace(traceText, resultsText) {
  const executions = parseJsonl(resultsText).filter((row) =>
    row.recordType === "execution_started" &&
    row.methodVersion === "safety-screen-v1" &&
    row.executionMode === "offline-meta"
  );
  const execution = executions.at(-1);
  if (!execution) throw new Error("No offline safety-screen execution is available for trace verification");
  const startedAt = execution.timestamp;
  const cutoff = Date.parse(startedAt);
  if (!Number.isFinite(cutoff)) throw new Error("Trace execution timestamp is invalid");
  const rows = parseJsonl(traceText).filter((row) => Date.parse(row.timestamp) >= cutoff);
  if (!rows.length) throw new Error("The offline request trace is empty");
  const safetyByRun = new Map();
  const harmfulTasks = new Set();
  const cloudTasks = new Set();
  let cloudRequests = 0;
  let safeCloudRequests = 0;
  let unverifiedCloudRequests = 0;
  let metaRequests = 0;
  let strongRejectCloudRequests = 0;
  let blockedRequests = 0;
  let completedItems = 0;
  let requestStarts = 0;
  for (const row of rows) {
    if (row.event === "safety_decision") {
      safetyByRun.set(row.runId, row.classification);
      if (row.classification === "harmful") blockedRequests += 1;
    }
    if (row.event === "task_completed") completedItems += 1;
    if (row.event !== "request_started") continue;
    requestStarts += 1;
    if (row.modelId === "muse-spark-1.3") metaRequests += 1;
    if (row.stage !== "escalation") continue;
    cloudRequests += 1;
    const key = `${row.pairing}|${row.taskId}`;
    cloudTasks.add(key);
    const classification = safetyByRun.get(row.runId);
    if (row.suite === "strongreject") strongRejectCloudRequests += 1;
    if (row.suite === "strongreject" || classification === "harmful") harmfulTasks.add(key);
    if (classification === "safe" && row.suite !== "strongreject") safeCloudRequests += 1;
    if (classification !== "safe" && classification !== "harmful") unverifiedCloudRequests += 1;
  }
  return {
    schemaVersion: 1,
    methodVersion: execution.methodVersion,
    executionMode: execution.executionMode,
    scope: "Offline pass after the local safety screen was introduced",
    startedAt,
    endedAt: rows.at(-1).timestamp,
    traceSha256: hash(traceText),
    resultsSha256: hash(resultsText),
    traceEventsReviewed: rows.length,
    completedItems,
    requestStarts,
    cloudRequests,
    cloudTasks: cloudTasks.size,
    safeCloudRequests,
    unverifiedCloudRequests,
    harmfulCloudPrompts: harmfulTasks.size,
    strongRejectCloudRequests,
    metaRequests,
    blockedRequests,
    legacyResultsExcluded: true,
  };
}

export function validateTraceSummary(summary) {
  const counts = ["traceEventsReviewed", "completedItems", "requestStarts", "cloudRequests", "cloudTasks", "safeCloudRequests", "unverifiedCloudRequests", "harmfulCloudPrompts", "strongRejectCloudRequests", "metaRequests", "blockedRequests"];
  if (summary?.schemaVersion !== 1 || summary?.methodVersion !== "safety-screen-v1" || summary?.executionMode !== "offline-meta" ||
    counts.some((key) => !Number.isSafeInteger(summary[key]) || summary[key] < 0) ||
    !/^[a-f0-9]{64}$/.test(summary.traceSha256 ?? "") || !/^[a-f0-9]{64}$/.test(summary.resultsSha256 ?? "")) {
    throw new Error("Trace evidence snapshot is missing or invalid");
  }
  return summary;
}

export async function loadTraceSummary(repoRoot, snapshotPath) {
  const runDirectory = path.join(repoRoot, ".logs", "benchmark-full-50-seed-20261027");
  let traceText;
  let resultsText;
  try {
    [traceText, resultsText] = await Promise.all([
      readFile(path.join(runDirectory, "trace.jsonl"), "utf8"),
      readFile(path.join(runDirectory, "results.jsonl"), "utf8"),
    ]);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    const snapshot = validateTraceSummary(JSON.parse(await readFile(snapshotPath, "utf8")));
    return { ...snapshot, verificationSource: "committed-trace-summary" };
  }
  const summary = validateTraceSummary(summarizeRequestTrace(traceText, resultsText));
  await writeFile(snapshotPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  return { ...summary, verificationSource: "local-request-trace" };
}
