import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { checkCanaryLeaks } from "../src/scoring/canary-check.mjs";
import { looksLikeRefusal, median } from "../src/scoring/metrics.mjs";

const tasksDirectory = new URL("../tasks/", import.meta.url);
const files = (await readdir(tasksDirectory)).filter((name) =>
  name.endsWith(".jsonl"),
);
assert.equal(files.length, 6);

for (const file of files) {
  const rows = (await readFile(new URL(file, tasksDirectory), "utf8"))
    .trim()
    .split(/\r?\n/)
    .map((line) => JSON.parse(line));
  assert.equal(rows.length, 20, `${file} must contain 20 rows`);
  assert.equal(new Set(rows.map((row) => row.id)).size, 20);
  for (const row of rows) {
    for (const field of [
      "id",
      "suite",
      "prompt",
      "reference_answer_or_rubric",
      "source",
      "licence",
    ]) {
      assert.ok(Object.hasOwn(row, field), `${file} is missing ${field}`);
    }
  }
}

const leakCheck = checkCanaryLeaks({
  sourceText: "private CANARY-20261027-0001",
  escalationPayload: "sent CANARY-20261027-0001",
  finalOutput: "safe aggregate only",
});
assert.equal(leakCheck.escalationPayload.count, 1);
assert.equal(leakCheck.finalOutput.count, 0);
assert.equal(median([9, 1, 5]), 5);
assert.equal(looksLikeRefusal("I cannot assist with that request."), true);
assert.equal(looksLikeRefusal("Here is the answer."), false);

console.log("Scoring and task-suite checks passed.");
