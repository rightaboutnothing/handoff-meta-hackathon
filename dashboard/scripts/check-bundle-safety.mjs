import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {stage6ProtectedText} from '../../src/evaluation/stage6-protected-text.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const dashboardRoot = path.resolve(here, "..");
const repoRoot = path.resolve(dashboardRoot, "..");
const distRoot = path.join(dashboardRoot, "dist");

async function walk(directory) {
  const entries = await readdir(directory);
  const files = [];
  for (const entry of entries) {
    const target = path.join(directory, entry);
    const info = await stat(target);
    if (info.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

function parseJsonl(text) {
  return text.split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

const bundleFiles = await walk(distRoot);
const searchable = [];
for (const file of bundleFiles) {
  if (/\.(js|css|html|json|map)$/i.test(file)) {
    searchable.push({ file, text: await readFile(file, "utf8") });
  }
}

const violations = [];
for (const { file, text } of searchable) {
  if (/sk-[A-Za-z0-9_-]{16,}/.test(text)) violations.push(`${path.relative(distRoot, file)} contains a key-like value`);
  if (/CANARY-[A-Za-z0-9_-]+/.test(text)) violations.push(`${path.relative(distRoot, file)} contains a private-data canary`);
}

const envPath = path.join(repoRoot, ".env");
try {
  const envText = await readFile(envPath, "utf8");
  const secretValues = envText.split(/\r?\n/).flatMap((line) => {
    const match = line.match(/^[A-Z][A-Z0-9_]*=(.+)$/);
    const value = match?.[1]?.trim().replace(/^['"]|['"]$/g, "");
    return value && value.length >= 12 ? [value] : [];
  });
  for (const { file, text } of searchable) {
    if (secretValues.some((value) => text.includes(value))) {
      violations.push(`${path.relative(distRoot, file)} contains an environment secret`);
    }
  }
} catch {}

const protectedFiles = [
  path.join(repoRoot, "tasks", "strongreject.jsonl"),
  path.join(repoRoot, ".cache", "gpqa.jsonl"),
  path.join(repoRoot, ".cache", "comparison", "gpqa-diamond.jsonl"),
];

for (const source of protectedFiles) {
  try {
    const rows = parseJsonl(await readFile(source, "utf8"));
    const prompts = rows.map((row) => row.prompt).filter((value) => typeof value === "string" && value.length >= 40);
    for (const { file, text } of searchable) {
      if (prompts.some((prompt) => text.includes(prompt))) {
        violations.push(`${path.relative(distRoot, file)} contains protected benchmark text from ${path.basename(source)}`);
      }
    }
  } catch {}
}

const stage6Values=await stage6ProtectedText(repoRoot);
for(const {file,text}of searchable){
  if(stage6Values.some(value=>text.includes(value)))violations.push(`${path.relative(distRoot,file)} contains protected Stage 6 test text`);
}

if (violations.length) {
  console.error("Dashboard bundle safety check failed:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exit(1);
}

console.log(`Dashboard bundle safety check passed across ${searchable.length} files.`);
