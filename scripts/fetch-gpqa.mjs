import "dotenv/config";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const REVISION = "83022cefff930aea54f654c0b282e74b9eeda5c6";
const token = process.env.HF_TOKEN;

if (!token) {
  throw new Error(
    "HF_TOKEN is required after accepting the Idavidrein/gpqa gated dataset terms.",
  );
}

const manifestPath = new URL("../tasks/gpqa.jsonl", import.meta.url);
const cachePath = new URL("../.cache/gpqa.jsonl", import.meta.url);
const manifest = (await readFile(manifestPath, "utf8"))
  .trim()
  .split(/\r?\n/)
  .map((line) => JSON.parse(line));

const metadataResponse = await fetch(
  "https://huggingface.co/api/datasets/Idavidrein/gpqa",
  { headers: { Authorization: `Bearer ${token}` } },
);
if (!metadataResponse.ok) {
  throw new Error(`GPQA metadata request failed: HTTP ${metadataResponse.status}`);
}
const metadata = await metadataResponse.json();
if (metadata.sha !== REVISION) {
  throw new Error(
    `GPQA HEAD changed from pinned revision ${REVISION} to ${metadata.sha}; update the pin intentionally before fetching.`,
  );
}

function deterministicChoices(row, rowIndex) {
  const values = [
    row["Correct Answer"],
    row["Incorrect Answer 1"],
    row["Incorrect Answer 2"],
    row["Incorrect Answer 3"],
  ];
  const rotation = rowIndex % values.length;
  const options = [...values.slice(rotation), ...values.slice(0, rotation)];
  return {
    options,
    answerIndex: options.indexOf(row["Correct Answer"]),
  };
}

const hydrated = [];
for (const item of manifest) {
  const rowIndex = item.reference_answer_or_rubric.row_index;
  const query = new URLSearchParams({
    dataset: "Idavidrein/gpqa",
    config: "gpqa_diamond",
    split: "train",
    offset: String(rowIndex),
    length: "1",
  });
  const response = await fetch(
    `https://datasets-server.huggingface.co/rows?${query}`,
    { headers: { Authorization: `Bearer ${token}` } },
  );
  if (!response.ok) {
    throw new Error(`GPQA row ${rowIndex} request failed: HTTP ${response.status}`);
  }
  const data = await response.json();
  const row = data.rows?.[0]?.row;
  if (!row) throw new Error(`GPQA row ${rowIndex} was not returned.`);
  const { options, answerIndex } = deterministicChoices(row, rowIndex);
  hydrated.push({
    ...item,
    prompt: [
      row.Question,
      ...options.map(
        (option, index) => `${String.fromCharCode(65 + index)}. ${option}`,
      ),
      "Answer with the best option letter and a brief explanation.",
    ].join("\n"),
    reference_answer_or_rubric: {
      type: "multiple_choice",
      correct_option: String.fromCharCode(65 + answerIndex),
      correct_answer: row["Correct Answer"],
      row_index: rowIndex,
    },
  });
}

await mkdir(new URL("../.cache/", import.meta.url), { recursive: true });
await writeFile(
  cachePath,
  `${hydrated.map((item) => JSON.stringify(item)).join("\n")}\n`,
  "utf8",
);
console.log(`Fetched ${hydrated.length} gated GPQA rows into ignored local cache.`);
