import "dotenv/config";
import { execFile } from "node:child_process";
import {
  access,
  appendFile,
  mkdir,
  open,
  readFile,
  unlink,
  writeFile,
} from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  BENCHMARK_SETTINGS,
  HANDOFF_PAIRINGS,
  HANDOFF_RUN_ORDER,
  runHandoff,
  warmUpLocalRoute,
} from "../src/server/model-router.mjs";
import { checkCanaryLeaks } from "../src/scoring/canary-check.mjs";
import { GRADER_MODEL_ID, gradeAnswer } from "../src/scoring/grader.mjs";
import { gradeLocallyForSafety } from "../src/scoring/local-safety-grader.mjs";
import {
  SUITE_ORDER,
  looksLikeRefusal,
  renderSummaryTable,
  summarizeResults,
} from "../src/scoring/metrics.mjs";
import {
  SAFETY_METHOD_VERSION,
  buildEffectiveResults,
  isOfflineMetaEligible,
  pendingRerunReasons,
  resultKey,
} from "../src/scoring/resume-plan.mjs";

const execFileAsync = promisify(execFile);
const SEED = 20261027;
const ITEMS_PER_SUITE = 50;
const MAX_RETRIES = 3;
const RETRY_DELAYS_MS = Object.freeze([2_000, 4_000, 8_000]);
const offlineMeta = process.argv.includes("--offline-meta");
const runDirectory = new URL(
  `../.logs/benchmark-full-${ITEMS_PER_SUITE}-seed-${SEED}/`,
  import.meta.url,
);
const resultsPath = new URL("results.jsonl", runDirectory);
const tracePath = new URL("trace.jsonl", runDirectory);
const localSummaryPath = new URL("summary.json", runDirectory);
const statePath = new URL("state.json", runDirectory);
const lockPath = new URL("runner.lock", runDirectory);
const progressPath = new URL("progress.log", runDirectory);
const committedSummaryPath = new URL("../results/summary.md", import.meta.url);
const repositoryDirectory = fileURLToPath(new URL("../", import.meta.url));
const resultsFile = fileURLToPath(resultsPath);
const traceFile = fileURLToPath(tracePath);
let lockHandle;

const runSettings = Object.freeze({
  seed: SEED,
  mode: `full-${ITEMS_PER_SUITE}`,
  methodVersion: SAFETY_METHOD_VERSION,
  itemsPerSuite: ITEMS_PER_SUITE,
  graderModelId: GRADER_MODEL_ID,
  pairingRunOrder: HANDOFF_RUN_ORDER,
  maxRetries: MAX_RETRIES,
  retryBackoffMs: RETRY_DELAYS_MS,
  checkpoint: "one task_result JSONL record after every finished pairing/task item",
  resumeKey: "pairing + taskId",
  strongRejectCloudPolicy: "never_cloud_local_screen_and_local_grade",
  xsTestSafetyPolicy: "force_safety_screen",
  ...BENCHMARK_SETTINGS,
});

const localGroups = Object.freeze([
  { route: "llama", pairings: ["meta-meta", "meta-grok"] },
  { route: "gemma", pairings: ["gemma-meta", "gemma-grok"] },
]);

async function fileExists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function readJsonl(path, { tolerateMalformed = false } = {}) {
  if (!(await fileExists(path))) return [];
  const content = await readFile(path, "utf8");
  if (!content.trim()) return [];
  const records = [];
  for (const line of content
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)) {
    try {
      records.push(JSON.parse(line));
    } catch (error) {
      if (!tolerateMalformed) throw error;
    }
  }
  return records;
}

async function appendJsonl(path, entry) {
  // A leading newline keeps the next checkpoint parseable even if a prior
  // process was interrupted during its final append.
  await appendFile(path, `\n${JSON.stringify(entry)}\n`, "utf8");
}

function errorMessage(error) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/sk-[A-Za-z0-9_-]+/g, "[REDACTED]")
    .replace(/Bearer\s+\S+/gi, "Bearer [REDACTED]");
}

function jobKey(pairing, taskId) {
  return `${pairing}|${taskId}`;
}

function isProcessRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function acquireRunLock() {
  await mkdir(runDirectory, { recursive: true });
  try {
    lockHandle = await open(lockPath, "wx");
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    let existingPid = 0;
    try {
      existingPid = Number(JSON.parse(await readFile(lockPath, "utf8")).pid);
    } catch {
      existingPid = 0;
    }
    if (isProcessRunning(existingPid)) {
      throw new Error(`Benchmark is already running as process ${existingPid}.`);
    }
    await unlink(lockPath);
    lockHandle = await open(lockPath, "wx");
  }
  await lockHandle.writeFile(
    `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
    "utf8",
  );
}

async function releaseRunLock() {
  try {
    await lockHandle?.close();
  } finally {
    if (await fileExists(lockPath)) await unlink(lockPath);
  }
}

async function progress(message, { error = false } = {}) {
  const line = `[${new Date().toISOString()}] ${message}`;
  await appendFile(progressPath, `${line}\n`, "utf8");
  if (error) console.error(line);
  else console.log(line);
}

async function loadTasks() {
  const suites = {};
  for (const suite of SUITE_ORDER) {
    const path =
      suite === "gpqa"
        ? new URL("../.cache/gpqa.jsonl", import.meta.url)
        : new URL(`../tasks/${suite}.jsonl`, import.meta.url);
    if (!(await fileExists(path))) {
      throw new Error(`${suite} task data is missing at ${fileURLToPath(path)}.`);
    }
    const rows = await readJsonl(path);
    if (rows.length < ITEMS_PER_SUITE) {
      throw new Error(
        `${suite} has ${rows.length} rows; ${ITEMS_PER_SUITE} are required.`,
      );
    }
    suites[suite] = rows.slice(0, ITEMS_PER_SUITE);
  }
  return SUITE_ORDER.flatMap((suite) => suites[suite]);
}

async function retryOperation({ operation, pairing, taskId }, callback) {
  for (let attempt = 1; attempt <= MAX_RETRIES + 1; attempt += 1) {
    try {
      return await callback();
    } catch (error) {
      const willRetry = attempt <= MAX_RETRIES;
      const retryDelayMs = willRetry ? RETRY_DELAYS_MS[attempt - 1] : 0;
      await appendJsonl(resultsPath, {
        recordType: "operation_error",
        timestamp: new Date().toISOString(),
        operation,
        pairing: pairing ?? null,
        taskId: taskId ?? null,
        attempt,
        maxRetries: MAX_RETRIES,
        willRetry,
        retryDelayMs,
        error: errorMessage(error),
      });
      await progress(
        `${operation} failed for ${pairing ?? "benchmark"}/${taskId ?? "warmup"} on attempt ${attempt}: ${errorMessage(error)}${willRetry ? `; retrying in ${retryDelayMs} ms` : "; retries exhausted"}`,
        { error: true },
      );
      if (!willRetry) throw error;
      await delay(retryDelayMs);
    }
  }
  throw new Error(`${operation} retry loop ended unexpectedly.`);
}

async function writeState(completedKeys, totalJobs, status = "running") {
  await writeFile(
    statePath,
    `${JSON.stringify(
      {
        updatedAt: new Date().toISOString(),
        pid: process.pid,
        status,
        executionMode: offlineMeta ? "offline-meta" : "online",
        completedItems: completedKeys.size,
        totalItems: totalJobs,
        settings: runSettings,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

function renderCommittedSummary(summaries, allResults, totalJobs) {
  const errors = allResults.filter((result) => result.status === "error").length;
  return [
    "# Handoff full benchmark",
    "",
    `Completed: ${new Date().toISOString()}`,
    "",
    `Seed: \`${SEED}\`. Items: ${ITEMS_PER_SUITE} per suite × ${SUITE_ORDER.length} suites × ${HANDOFF_RUN_ORDER.length} pairings = ${totalJobs}.`,
    "",
    `Finished results: ${allResults.length}/${totalJobs}; terminal item errors after retries: ${errors}.`,
    "",
    "GPQA question text remained in Git-ignored local cache and is not included here.",
    "",
    renderSummaryTable(summaries),
    "",
    "Total cost includes Handoff calls and blind grader calls. Warm-up latency is excluded. Canary payload/output values are measured occurrences and are not altered.",
    "",
  ].join("\n");
}

function renderInterimSummary(summaries, effectiveResults, totalJobs, deferred) {
  const errors = effectiveResults.filter(
    (result) => result.status === "error",
  ).length;
  const deferredGroups = new Map();
  for (const item of deferred) {
    const key = `${item.pairing}|${item.suite}`;
    deferredGroups.set(key, (deferredGroups.get(key) ?? 0) + 1);
  }
  const deferredTable = [
    "| Pairing | Suite | Deferred |",
    "| --- | --- | ---: |",
    ...[...deferredGroups.entries()].map(([key, count]) => {
      const [pairing, suite] = key.split("|");
      return `| ${HANDOFF_PAIRINGS[pairing].name} (\`${pairing}\`) | ${suite} | ${count} |`;
    }),
  ];
  const exactDeferred = deferred.map(
    (item) => `- \`${item.pairing}|${item.taskId}\` (${item.suite})`,
  );

  return [
    "# Handoff benchmark — INTERIM offline-Meta results",
    "",
    "> **INTERIM:** Meta access is not restored. This report covers the completed offline-Meta pass and is not the final six-suite benchmark.",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    `Seed: \`${SEED}\`. Effective results: ${effectiveResults.length}/${totalJobs}. Deferred Meta items: ${deferred.length}. Terminal item errors after retries: ${errors}.`,
    "",
    "This execution made zero Meta calls by construction: non-StrongREJECT Finkd/Gemmuse work was ineligible, and StrongREJECT was screened, answered, and graded locally.",
    "",
    "GPQA question text remained in Git-ignored local cache and is not included here.",
    "",
    "## Interim metrics",
    "",
    renderSummaryTable(summaries),
    "",
    "## Deferred until Meta access is confirmed restored",
    "",
    ...deferredTable,
    "",
    `<details><summary>Exact deferred pairing/task IDs (${deferred.length})</summary>`,
    "",
    ...exactDeferred,
    "",
    "</details>",
    "",
    "Total cost includes Handoff and applicable grader calls. Warm-up latency is excluded. Canary payload/output values are preserved as measured.",
    "",
  ].join("\n");
}

async function commitAndPushSummary(commitMessage) {
  await execFileAsync("git", ["add", "--", "results/summary.md"], {
    cwd: repositoryDirectory,
  });
  let hasChanges = false;
  try {
    await execFileAsync(
      "git",
      ["diff", "--cached", "--quiet", "--", "results/summary.md"],
      { cwd: repositoryDirectory },
    );
  } catch (error) {
    if (error?.code === 1) hasChanges = true;
    else throw error;
  }
  if (hasChanges) {
    await execFileAsync(
      "git",
      ["commit", "-m", commitMessage],
      { cwd: repositoryDirectory },
    );
  }
  await retryOperation(
    { operation: "git_push", pairing: null, taskId: null },
    () =>
      execFileAsync("git", ["push", "origin", "main"], {
        cwd: repositoryDirectory,
      }),
  );
}

async function runBenchmark() {
  const tasks = await loadTasks();
  const totalJobs = tasks.length * HANDOFF_RUN_ORDER.length;
  const existingRecords = await readJsonl(resultsPath, {
    tolerateMalformed: true,
  });
  const startRecord = existingRecords.find(
    (record) => record.recordType === "benchmark_start",
  );
  if (
    startRecord &&
    (startRecord.settings?.seed !== SEED ||
      startRecord.settings?.itemsPerSuite !== ITEMS_PER_SUITE)
  ) {
    throw new Error("Existing resumable run uses a different seed or sample size.");
  }
  if (!startRecord) {
    await appendJsonl(resultsPath, {
      recordType: "benchmark_start",
      timestamp: new Date().toISOString(),
      settings: runSettings,
      totalJobs,
    });
  }
  if (
    !existingRecords.some(
      (record) =>
        record.recordType === "method_change" &&
        record.methodVersion === SAFETY_METHOD_VERSION,
    )
  ) {
    await appendJsonl(resultsPath, {
      recordType: "method_change",
      timestamp: new Date().toISOString(),
      methodVersion: SAFETY_METHOD_VERSION,
      settings: runSettings,
      reason:
        "Add local pre-escalation safety screen; StrongREJECT local-only; XSTest safety over-block measurement.",
    });
  }
  await appendJsonl(resultsPath, {
    recordType: "execution_started",
    timestamp: new Date().toISOString(),
    methodVersion: SAFETY_METHOD_VERSION,
    executionMode: offlineMeta ? "offline-meta" : "online",
  });

  const rawResults = existingRecords.filter(
    (record) => record.recordType === "task_result",
  );
  const initialSelection = buildEffectiveResults(rawResults);
  const effectiveByKey = new Map(
    initialSelection.effectiveResults.map((result) => [resultKey(result), result]),
  );
  const completedKeys = new Set(
    initialSelection.effectiveResults.map((result) => resultKey(result)),
  );
  await writeState(completedKeys, totalJobs);
  await progress(
    `Starting ${offlineMeta ? "offline-meta" : "online"} safety-screen benchmark: ${completedKeys.size}/${totalJobs} effective items checkpointed; ${initialSelection.pendingReruns.length} prior results pending rerun.`,
  );

  async function saveResult(result) {
    await appendJsonl(resultsPath, result);
    rawResults.push(result);
    const key = resultKey(result);
    const pendingReasons = pendingRerunReasons(result);
    if (pendingReasons.length > 0) {
      effectiveByKey.delete(key);
      completedKeys.delete(key);
      await appendJsonl(resultsPath, {
        recordType: "result_status_update",
        timestamp: new Date().toISOString(),
        pairing: result.pairing,
        taskId: result.taskId,
        suite: result.suite,
        status: "pending_rerun",
        reasons: pendingReasons,
      });
    } else {
      effectiveByKey.set(key, result);
      completedKeys.add(key);
    }
    await writeState(completedKeys, totalJobs);
    await progress(
      `[${completedKeys.size}/${totalJobs}] ${result.pairing}/${result.taskId} ${pendingReasons.length > 0 ? "pending_rerun" : result.status}`,
      { error: result.status === "error" },
    );
  }

  function isEligibleInThisExecution(pairing, task) {
    if (!offlineMeta) return true;
    return isOfflineMetaEligible({
      suite: task.suite,
      escalationRoute: HANDOFF_PAIRINGS[pairing].escalationRoute,
    });
  }

  for (const group of localGroups) {
    const groupHasPendingWork = group.pairings.some((pairing) =>
      tasks.some(
        (task) =>
          isEligibleInThisExecution(pairing, task) &&
          !completedKeys.has(jobKey(pairing, task.id)),
      ),
    );
    if (!groupHasPendingWork) continue;

    await progress(
      `Warming ${group.route} for ${group.pairings.join(", ")} (excluded from benchmark timings).`,
    );
    try {
      await retryOperation(
        { operation: `warmup_${group.route}`, pairing: null, taskId: null },
        () =>
          warmUpLocalRoute(group.route, {
            logPath: traceFile,
            pairings: group.pairings,
          }),
      );
    } catch {
      await progress(
        `${group.route} warm-up exhausted retries; continuing so item-level retries can record outcomes.`,
        { error: true },
      );
    }

    for (const pairing of group.pairings) {
      const remaining = tasks.filter(
        (task) =>
          isEligibleInThisExecution(pairing, task) &&
          !completedKeys.has(jobKey(pairing, task.id)),
      );
      if (remaining.length === 0) continue;
      await progress(
        `Running ${HANDOFF_PAIRINGS[pairing].name}: ${remaining.length} remaining tasks in fixed suite order.`,
      );

      for (const task of remaining) {
        let handoff;
        try {
          handoff = await retryOperation(
            { operation: "handoff", pairing, taskId: task.id },
            () =>
              runHandoff(pairing, task.prompt, {
                logPath: traceFile,
                captureEscalationPayload: true,
                logContext: { taskId: task.id, suite: task.suite },
                forceSafetyScreen:
                  task.suite === "strongreject" || task.suite === "xstest",
                localOnly: task.suite === "strongreject",
                disabledEscalationRoutes: offlineMeta ? ["meta"] : [],
              }),
          );
        } catch (error) {
          await saveResult({
            recordType: "task_result",
            status: "error",
            failedStage: "handoff",
            timestamp: new Date().toISOString(),
            benchmarkMode: runSettings.mode,
            settings: runSettings,
            pairing,
            handoffName: HANDOFF_PAIRINGS[pairing].name,
            taskId: task.id,
            suite: task.suite,
            error: errorMessage(error),
          });
          continue;
        }

        const canaryLeaks = checkCanaryLeaks({
          sourceText: task.prompt,
          escalationPayload: handoff.escalationPayload,
          finalOutput: handoff.outputText,
          expectedCanaries:
            task.reference_answer_or_rubric?.forbidden_canaries ?? [],
        });

        let grader;
        if (
          task.suite === "strongreject" ||
          handoff.routeChosen === "blocked_local"
        ) {
          grader = gradeLocallyForSafety({
            suite: task.suite,
            answer: handoff.outputText,
            safetyClassification: handoff.safetyClassification,
            routeChosen: handoff.routeChosen,
          });
        } else {
          try {
            grader = await retryOperation(
              { operation: "grader", pairing, taskId: task.id },
              () =>
                gradeAnswer({
                  suite: task.suite,
                  prompt: task.prompt,
                  referenceAnswerOrRubric: task.reference_answer_or_rubric,
                  answer: handoff.outputText,
                }),
            );
          } catch (error) {
            await saveResult({
              recordType: "task_result",
              status: "error",
              failedStage: "grader",
              timestamp: new Date().toISOString(),
              benchmarkMode: runSettings.mode,
              settings: runSettings,
              runId: handoff.runId,
              pairing,
              handoffName: handoff.handoffName,
              taskId: task.id,
              suite: task.suite,
              routeChosen: handoff.routeChosen,
              safetyClassification: handoff.safetyClassification,
              safetyConfidence: handoff.safetyConfidence,
              firstResponderModelId: handoff.firstResponderModelId,
              finalModelId: handoff.finalModelId,
              canaryLeaks,
              steps: handoff.steps,
              handoffTokens: handoff.tokens,
              handoffLatencyMs: handoff.latencyMs,
              handoffCostEstimateUsd: handoff.costEstimateUsd,
              error: errorMessage(error),
            });
            continue;
          }
        }

        await saveResult({
          recordType: "task_result",
          status: "ok",
          timestamp: new Date().toISOString(),
          benchmarkMode: runSettings.mode,
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
          safetyClassification: handoff.safetyClassification,
          safetyConfidence: handoff.safetyConfidence,
          safetyReason: handoff.safetyReason,
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
        });
      }
    }
  }

  const effectiveResults = [...effectiveByKey.values()];
  const deferredItems = [];
  for (const pairing of HANDOFF_RUN_ORDER) {
    for (const task of tasks) {
      if (!completedKeys.has(jobKey(pairing, task.id))) {
        deferredItems.push({ pairing, suite: task.suite, taskId: task.id });
      }
    }
  }
  const summaries = summarizeResults(effectiveResults);
  const summary = {
    generatedAt: new Date().toISOString(),
    settings: runSettings,
    resultsPath: resultsFile,
    tracePath: traceFile,
    completedItems: effectiveResults.length,
    executionMode: offlineMeta ? "offline-meta" : "online",
    totalJobs,
    deferredItems: deferredItems.length,
    summaries,
  };
  await writeFile(localSummaryPath, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  await progress(
    `Execution pass complete: ${effectiveResults.length}/${totalJobs} effective item results.`,
  );
  await progress(`\n${renderSummaryTable(summaries)}`);

  if (effectiveResults.length < totalJobs) {
    if (offlineMeta) {
      await mkdir(new URL("../results/", import.meta.url), { recursive: true });
      await writeFile(
        committedSummaryPath,
        renderInterimSummary(
          summaries,
          effectiveResults,
          totalJobs,
          deferredItems,
        ),
        "utf8",
      );
      await progress(
        `Wrote interim results/summary.md with ${deferredItems.length} exact deferred item IDs; committing and pushing main.`,
      );
      await commitAndPushSummary("Add interim offline-Meta benchmark results");
      await progress("Committed and pushed interim offline-Meta summary to main.");
    }
    await writeState(
      completedKeys,
      totalJobs,
      offlineMeta ? "offline-meta-complete" : "incomplete",
    );
    await progress(
      `${totalJobs - effectiveResults.length} items remain pending; final summary commit is deferred.`,
    );
    return;
  }

  await mkdir(new URL("../results/", import.meta.url), { recursive: true });
  await writeFile(
    committedSummaryPath,
    renderCommittedSummary(summaries, effectiveResults, totalJobs),
    "utf8",
  );
  await progress("Wrote results/summary.md; committing and pushing main.");
  await commitAndPushSummary("Add full six-suite benchmark results");
  await progress("Committed and pushed results/summary.md to main.");
  await writeState(completedKeys, totalJobs, "complete");
}

await acquireRunLock();
try {
  await runBenchmark();
} catch (error) {
  await progress(`Fatal benchmark error: ${errorMessage(error)}`, { error: true });
  process.exitCode = 1;
} finally {
  await releaseRunLock();
}
