import assert from "node:assert/strict";
import { summarizeRequestTrace, validateTraceSummary } from "./trace-summary.mjs";

const startedAt = "2026-10-27T01:00:00.000Z";
const results = JSON.stringify({ recordType: "execution_started", timestamp: startedAt, executionMode: "offline-meta", methodVersion: "safety-screen-v1" });
const fixture = (rows) => rows.map((row, index) => JSON.stringify({ timestamp: `2026-10-27T01:00:0${index + 1}.000Z`, ...row })).join("\n");
const request = (runId, taskId, suite = "ifeval") => ({ event: "request_started", runId, pairing: "meta-grok", taskId, suite, stage: "escalation", modelId: "x-ai/grok-4.7" });
const safe = { event: "safety_decision", runId: "safe", classification: "safe" };

const legitimate = summarizeRequestTrace(fixture([
  { ...request("legacy", "old", "strongreject"), timestamp: "2026-10-27T00:00:00.000Z" },
  safe,
  request("safe", "safe-task"),
  { event: "task_completed", runId: "safe" },
]), results);
assert.equal(legitimate.harmfulCloudPrompts, 0);
assert.equal(legitimate.cloudRequests, 1);
assert.equal(legitimate.safeCloudRequests, 1);
assert.equal(legitimate.metaRequests, 0);
assert.equal(legitimate.completedItems, 1);
assert.equal(legitimate.traceEventsReviewed, 3);
assert.equal(legitimate.traceSha256.length, 64);
assert.doesNotThrow(() => validateTraceSummary(legitimate));

const violated = summarizeRequestTrace(fixture([
  safe,
  request("safe", "harmful-suite-task", "strongreject"),
  { event: "safety_decision", runId: "blocked", classification: "harmful" },
  request("blocked", "screen-blocked"),
  request("missing", "unverified"),
]), results);
assert.equal(violated.harmfulCloudPrompts, 2);
assert.equal(violated.strongRejectCloudRequests, 1);
assert.equal(violated.unverifiedCloudRequests, 1);
assert.equal(violated.safeCloudRequests, 0);
assert.throws(() => summarizeRequestTrace(fixture([]), results), /empty/);
assert.throws(() => validateTraceSummary({}), /invalid/);
console.log("Trace provenance checks passed: scoped legacy exclusion, safe handoff, unsafe handoff, missing screen, and invalid evidence.");
