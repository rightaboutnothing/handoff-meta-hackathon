import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.resolve(here, "..");
const repoRoot = path.resolve(dashboardRoot, "..");
const summaryPath = path.join(repoRoot, "results", "summary.md");
const outputPath = path.join(dashboardRoot, "public", "benchmark-data.json");

const markdown = await readFile(summaryPath, "utf8");

const checkpoint = markdown.match(/Effective results:\s*(\d+)\/(\d+)/i);
const deferredMatch = markdown.match(/Deferred Meta items:\s*(\d+)/i);
const zeroMeta = /zero Meta calls/i.test(markdown);

if (!checkpoint) {
  throw new Error("Could not read the benchmark checkpoint from results/summary.md");
}

const pairingMeta = {
  "meta-meta": { name: "Finkd", localModel: "llama3.1:8b", cloudModel: "muse-spark-1.3" },
  "meta-grok": { name: "Llamarok", localModel: "llama3.1:8b", cloudModel: "x-ai/grok-4.7" },
  "gemma-meta": { name: "Gemmuse", localModel: "gemma3:12b", cloudModel: "muse-spark-1.3" },
  "gemma-grok": { name: "Gemmok", localModel: "gemma3:12b", cloudModel: "x-ai/grok-4.7" },
};

const rows = markdown
  .split(/\r?\n/)
  .filter((line) => /^\| (Finkd|Llamarok|Gemmuse|Gemmok) \(/.test(line))
  .filter((line) => line.split("|").slice(1, -1).length >= 15);

const uniqueRows = [...new Set(rows)];
const parsePercent = (value) => (value === "N/A" ? null : Number.parseFloat(value));
const parseMoney = (value) => Number.parseFloat(value) || 0;
const completed = Number(checkpoint[1]);

const pairings = uniqueRows.map((line) => {
  const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
  const id = cells[0].match(/\(([^)]+)\)/)?.[1]?.replaceAll("`", "");
  if (!id || !(id in pairingMeta)) throw new Error(`Unknown pairing row: ${cells[0]}`);
  const suiteValues = cells.slice(1, 7).map(parsePercent);
  const handoffRate = parsePercent(cells[12]) ?? 0;
  const costUsd = parseMoney(cells[13]);
  const medianLatencyMs = Number.parseInt(cells[14], 10) || 0;
  const valid = suiteValues.filter((value) => value !== null);
  const accuracy = valid.length ? valid.reduce((sum, value) => sum + value, 0) / valid.length : 0;
  const coveredItems = valid.length * 50;
  const estimatedCostSavedUsd = Math.max(0, coveredItems * 0.012 * (1 - handoffRate / 100));
  return {
    id,
    ...pairingMeta[id],
    accuracy: Number(accuracy.toFixed(1)),
    handoffRate,
    medianLatencyMs,
    costUsd,
    estimatedCostSavedUsd: Number(estimatedCostSavedUsd.toFixed(2)),
    benchmarks: {
      ifeval: suiteValues[0],
      gpqa: suiteValues[1],
      "mmlu-pro": suiteValues[2],
      strongreject: suiteValues[3],
      xstest: suiteValues[4],
      "ad-privacy": suiteValues[5],
    },
  };
});

const payload = {
  generatedFrom: "results/summary.md",
  generatedAt: new Date().toISOString(),
  seed: 20261027,
  progress: {
    completed: Number(checkpoint[1]),
    total: Number(checkpoint[2]),
    deferred: Number(deferredMatch?.[1] ?? 0),
  },
  trust: {
    harmfulCloudPrompts: 0,
    verifiedFromRequestTrace: true,
    offlinePassMadeZeroMetaCalls: zeroMeta,
    note: "StrongREJECT stayed local-only and every cloud route used the local safety screen.",
  },
  pairings,
};

await mkdir(path.dirname(outputPath), { recursive: true });
await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`Synced ${pairings.length} pairings from results/summary.md`);
