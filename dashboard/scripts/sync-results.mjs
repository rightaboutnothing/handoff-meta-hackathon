import { mkdir, readFile, writeFile, copyFile, lstat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadTraceSummary } from "./trace-summary.mjs";
import { readStage4Results } from "../server/stage4-results.mjs";
import { readStage5Results } from "../server/stage5-results.mjs";
import { readStage6Results } from "../server/stage6-results.mjs";
import { readPrivacyResults } from "../server/privacy-results.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.resolve(here, "..");
const repoRoot = path.resolve(dashboardRoot, "..");
const summaryPath = path.join(repoRoot, "results", "summary.md");
const outputPath = path.join(dashboardRoot, "public", "benchmark-data.json");

const markdown = await readFile(summaryPath, "utf8");

const checkpoint = markdown.match(/Effective results:\s*(\d+)\/(\d+)/i);
const deferredMatch = markdown.match(/Deferred Meta items:\s*(\d+)/i);

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
  trust: await (async () => {
    const evidence = await loadTraceSummary(repoRoot, path.join(dashboardRoot, "public", "trace-summary.json"));
    return {
      harmfulCloudPrompts: evidence.harmfulCloudPrompts,
      verifiedFromRequestTrace: evidence.unverifiedCloudRequests === 0,
      offlinePassMadeZeroMetaCalls: evidence.metaRequests === 0,
      note: "The offline pass was verified against request trace metadata. Legacy results from before the safety screen are outside this scope.",
      evidence,
    };
  })(),
  pairings,
};

await mkdir(path.dirname(outputPath), { recursive: true });
let unchanged = false;
try {
  const previous = JSON.parse(await readFile(outputPath, 'utf8'));
  unchanged = JSON.stringify({ ...previous, generatedAt: null }) === JSON.stringify({ ...payload, generatedAt: null });
} catch (error) { if (error.code !== 'ENOENT') throw error; }
if (!unchanged) await writeFile(outputPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(unchanged ? 'Historical pairing snapshot unchanged; kept read-only.' : `Synced ${pairings.length} pairings from results/summary.md`);

// A standalone dashboard build can load the same sanitized Stage 4 aggregate.
// Raw responses, private contexts and gated tasks never enter public assets.
const stage4=await readStage4Results(),stage4File=path.join(dashboardRoot,'public','stage4-results.json');
const stage4Body=JSON.stringify(stage4,null,2)+'\n';
let previousStage4;try{previousStage4=await readFile(stage4File,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(previousStage4!==stage4Body)await writeFile(stage4File,stage4Body,'utf8');
const stage5=await readStage5Results(),stage5File=path.join(dashboardRoot,'public','stage5-results.json');
const stage5Body=JSON.stringify(stage5,null,2)+'\n';
let previousStage5;try{previousStage5=await readFile(stage5File,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(previousStage5!==stage5Body)await writeFile(stage5File,stage5Body,'utf8');
const stage6=await readStage6Results(),stage6File=path.join(dashboardRoot,'public','stage6-results.json');
const stage6Body=JSON.stringify(stage6,null,2)+'\n';
let previousStage6;try{previousStage6=await readFile(stage6File,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(previousStage6!==stage6Body)await writeFile(stage6File,stage6Body,'utf8');
const privacyResults=await readPrivacyResults(),privacyFile=path.join(dashboardRoot,'public','privacy-results.json');
const privacyBody=JSON.stringify(privacyResults,null,2)+'\n';
let previousPrivacy;try{previousPrivacy=await readFile(privacyFile,'utf8');}catch(error){if(error.code!=='ENOENT')throw error;}
if(previousPrivacy!==privacyBody)await writeFile(privacyFile,privacyBody,'utf8');
if(stage4){
  const source=path.join(repoRoot,'results',stage4.runId,'charts'),destination=path.join(dashboardRoot,'public','stage4-charts');
  const chartFiles=['local-acceptance-quality.png','cloud-costs-by-slice.png','company-workload-savings.png','privacy-boundary.png','manifest.json'];
  for(const name of chartFiles){
    const file=path.join(source,name);let info;try{info=await lstat(file);}catch(error){if(error.code==='ENOENT')continue;throw error;}
    if(!info.isFile()||info.isSymbolicLink())throw new Error('Submission charts must be regular files');
    await mkdir(destination,{recursive:true});await copyFile(file,path.join(destination,name));
  }
}
