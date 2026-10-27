import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath } from "node:fs/promises";
import path from "node:path";
import { parse } from "csv-parse/sync";

export const SUPPORTED_EXTENSIONS = new Set([".txt", ".md", ".pdf", ".csv", ".docx"]);
export const CHUNK_SETTINGS = Object.freeze({ approximateTokens: 500, overlapTokens: 80, charsPerToken: 4 });
const MAX_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TEXT_CHARS = 10_000_000;
const SKIP_DIRECTORIES = new Set(["node_modules", "vendor", "dist", "build", "logs", "coverage"]);

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

export function stableChunkId(file, location, pieceIndex = 0) {
  return `${sha256(file.replaceAll("\\", "/")).slice(0, 12)}:${location.replaceAll(":", "-")}:${String(pieceIndex + 1).padStart(4, "0")}`;
}

export async function listDocumentFiles(folder, { maxFiles = 1000, maxTotalBytes = 100 * 1024 * 1024 } = {}) {
  const folderInfo = await lstat(folder);
  if (folderInfo.isSymbolicLink() || !folderInfo.isDirectory()) throw new Error("Ingest requires a local directory, not a symlink");
  const root = await realpath(folder);
  const files = [];
  let totalBytes = 0;
  async function visit(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name.startsWith(".") || entry.isSymbolicLink()) continue;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRECTORIES.has(entry.name.toLowerCase())) await visit(target);
      } else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        const info = await lstat(target);
        if (info.isSymbolicLink()) continue;
        if (info.size > MAX_FILE_BYTES) throw new Error("A supported document exceeds the 20 MiB ingest limit");
        totalBytes += info.size;
        if (files.length >= maxFiles || totalBytes > maxTotalBytes) throw new Error("The ingest folder exceeds the local file-count or total-size limit");
        files.push({ absolutePath: target, file: path.relative(root, target).split(path.sep).join("/"), sizeBytes: info.size });
      }
    }
  }
  await visit(root);
  return { root, files, totalBytes };
}

export function chunkText(text, { approximateTokens = 500, overlapTokens = 80, charsPerToken = 4 } = CHUNK_SETTINGS) {
  const limit = Math.floor(approximateTokens * charsPerToken);
  const overlap = Math.floor(overlapTokens * charsPerToken);
  if (limit < 64 || overlap < 0 || overlap >= limit) throw new Error("Invalid chunk settings");
  const normalized = String(text).replaceAll("\r\n", "\n").replace(/\0/g, "").trim();
  if (!normalized) return [];
  const chunks = [];
  let start = 0;
  while (start < normalized.length) {
    let end = Math.min(normalized.length, start + limit);
    if (end < normalized.length) {
      const boundary = normalized.lastIndexOf(" ", end);
      if (boundary > start + limit * 0.7) end = boundary;
      // Never split a PII placeholder into separate chunks.
      const open = normalized.lastIndexOf("[[", end);
      const close = normalized.lastIndexOf("]]", end);
      if (open > close && open > start) end = open;
    }
    const value = normalized.slice(start, end).trim();
    if (value) chunks.push(value);
    if (end >= normalized.length) break;
    let next = Math.max(start + 1, end - overlap);
    const word = normalized.lastIndexOf(" ", next);
    if (word > start) next = word + 1;
    const open = normalized.lastIndexOf("[[", next);
    const close = normalized.lastIndexOf("]]", next);
    if (open > close && open >= start) next = open;
    start = Math.max(start + 1, next);
  }
  return chunks;
}

export async function extractDocument(absolutePath) {
  const info = await lstat(absolutePath);
  if (!info.isFile() || info.isSymbolicLink() || info.size > MAX_FILE_BYTES) throw new Error("Document is not an allowed local file");
  const extension = path.extname(absolutePath).toLowerCase();
  if (!SUPPORTED_EXTENSIONS.has(extension)) throw new Error("Unsupported document type");
  const buffer = await readFile(absolutePath);
  let units;
  if (extension === ".txt" || extension === ".md") {
    units = [{ location: "page:1", text: buffer.toString("utf8") }];
  } else if (extension === ".csv") {
    const rows = parse(buffer.toString("utf8"), { columns: true, bom: true, skip_empty_lines: true, relax_column_count: false });
    units = rows.map((row, index) => ({
      location: `row:${index + 2}`,
      text: Object.entries(row).map(([key, value]) => `${key}: ${value}`).join("\n"),
    }));
  } else if (extension === ".pdf") {
    const { PDFParse } = await import("pdf-parse");
    const parser = new PDFParse({ data: new Uint8Array(buffer), isEvalSupported: false });
    try {
      const result = await parser.getText();
      units = result.pages.map((page, index) => ({ location: `page:${page.num ?? index + 1}`, text: page.text }));
    } finally { await parser.destroy(); }
  } else {
    const mammoth = await import("mammoth");
    const result = await mammoth.extractRawText({ buffer });
    units = [{ location: "document:1", text: result.value }];
  }
  if (units.reduce((sum, unit) => sum + unit.text.length, 0) > MAX_TEXT_CHARS) throw new Error("Extracted document exceeds the text-size limit");
  return units.filter(unit => unit.text.trim());
}
