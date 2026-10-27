import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CHUNK_SETTINGS, chunkText, extractDocument, listDocumentFiles, stableChunkId, sha256 } from "../src/rag/documents.mjs";
import { embedTexts, normalizeVector, FALLBACK_EMBEDDING_MODEL } from "../src/rag/embeddings.mjs";
import { LocalVectorStore, assertEmbeddingCompatibility } from "../src/rag/store.mjs";
import { ingestFolder, retrieve, getIndexStatus } from "../src/rag/ingest.mjs";
import { createPrivacyVault } from "../src/rag/privacy.mjs";

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "handoff-retrieval-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

function embeddingResponse(inputs) {
  return { ok: true, json: async () => ({ embeddings: inputs.map(text => /warranty/i.test(text) ? [1, 0, 0] : [0, 1, 0]) }) };
}

function minimalPdf(text) {
  const content = `BT /F1 12 Tf 40 740 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
  ];
  let output = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => { offsets.push(Buffer.byteLength(output)); output += `${index + 1} 0 obj\n${object}\nendobj\n`; });
  const xref = Buffer.byteLength(output);
  output += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  output += offsets.slice(1).map(offset => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  return Buffer.from(`${output}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
}

// A small uncompressed ZIP writer keeps the DOCX fixture independent of office software.
function zipFiles(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const data = Buffer.from(text);
    let checksum = 0xffffffff;
    for (const byte of data) {
      checksum ^= byte;
      for (let bit = 0; bit < 8; bit += 1) checksum = (checksum >>> 1) ^ ((checksum & 1) ? 0xedb88320 : 0);
    }
    checksum = (checksum ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(checksum, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(filename.length, 26);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24); directory.writeUInt16LE(filename.length, 28); directory.writeUInt32LE(offset, 42);
    locals.push(header, filename, data); central.push(directory, filename);
    offset += header.length + filename.length + data.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(Object.keys(files).length, 8); end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

test("chunks overlap, retain whole placeholders and have stable source identifiers", () => {
  const placeholder = "[[PII_EMAIL_1234567890abcdef]]";
  const text = `${"word ".repeat(390)}${placeholder} ${"tail ".repeat(350)}`;
  const chunks = chunkText(text);
  assert.ok(chunks.length >= 2);
  assert.ok(chunks.every(chunk => chunk.length <= CHUNK_SETTINGS.approximateTokens * CHUNK_SETTINGS.charsPerToken));
  assert.ok(chunks[0].endsWith("word word word word word") || chunks[0].includes(placeholder));
  for (const chunk of chunks) {
    if (chunk.includes("[[") || chunk.includes("]]")) assert.ok(chunk.includes(placeholder));
  }
  assert.ok(chunks.some(chunk => chunk.includes(placeholder)));
  assert.equal(stableChunkId("policies\\warranty.md", "page:1"), stableChunkId("policies/warranty.md", "page:1"));
  assert.notEqual(stableChunkId("policies/warranty.md", "page:1"), stableChunkId("policies/warranty.md", "page:2"));
  assert.deepEqual(chunkText("  \r\n\0 "), []);
});

test("document discovery excludes hidden files and extracts CSV rows with field labels", async t => {
  const directory = await temporaryDirectory(t);
  await mkdir(path.join(directory, "policies"));
  await mkdir(path.join(directory, "node_modules"));
  await writeFile(path.join(directory, "policies", "warranty.md"), "SYNTHETIC TEST DATA\nWarranty: 24 months.\n");
  await writeFile(path.join(directory, ".private.md"), "not indexed");
  await writeFile(path.join(directory, "node_modules", "secret.txt"), "not indexed");
  await writeFile(path.join(directory, "unsupported.js"), "not indexed");
  const csv = path.join(directory, "tickets.csv");
  await writeFile(csv, 'ticket_id,customer_name,notes\nSYN-1,Jordan Example,"Filter, warranty"\nSYN-2,Alex Example,Shipping\n');
  const discovered = await listDocumentFiles(directory);
  assert.deepEqual(discovered.files.map(file => file.file), ["policies/warranty.md", "tickets.csv"]);
  const units = await extractDocument(csv);
  assert.equal(units.length, 2);
  assert.equal(units[0].location, "row:2");
  assert.match(units[0].text, /customer_name: Jordan Example/);
  assert.match(units[0].text, /notes: Filter, warranty/);
  assert.equal((await extractDocument(path.join(directory, "policies", "warranty.md")))[0].location, "page:1");
});

test("PDF pages and DOCX paragraphs are actually extracted from local binary files", async t => {
  const directory = await temporaryDirectory(t);
  const pdfFile = path.join(directory, "synthetic-policy.pdf");
  const docxFile = path.join(directory, "synthetic-policy.docx");
  await writeFile(pdfFile, minimalPdf("SYNTHETIC TEST DATA: Warranty is 24 months."));
  await writeFile(docxFile, zipFiles({
    "[Content_Types].xml": '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
    "_rels/.rels": '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
    "word/document.xml": '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>SYNTHETIC TEST DATA: Shipping is 3 days.</w:t></w:r></w:p></w:body></w:document>',
  }));
  const pdf = await extractDocument(pdfFile);
  const docx = await extractDocument(docxFile);
  assert.equal(pdf[0].location, "page:1");
  assert.match(pdf[0].text, /Warranty is 24 months/);
  assert.equal(docx[0].location, "document:1");
  assert.match(docx[0].text, /Shipping is 3 days/);
});

test("SQLite vector retrieval persists and rolls back a failed index replacement", async t => {
  const dataDir = await temporaryDirectory(t);
  const embedding = { provider: "ollama", model: "test-local-embedding", dimensions: 3, vectors: [[1, 0, 0], [0, 1, 0]] };
  const chunks = ["Warranty is 24 months.", "Shipping is 3 days."].map((text, index) => ({
    chunkId: `synthetic-${index}`, file: "synthetic.txt", location: `page:${index + 1}`, text, hash: sha256(text), piiCount: 0,
  }));
  let store = new LocalVectorStore({ dataDir });
  store.replaceChunks(chunks, embedding, { files: 1 });
  store.close();
  store = new LocalVectorStore({ dataDir });
  try {
    const results = store.search([0.99, 0.01, 0], embedding, 1);
    assert.equal(results[0].chunkId, "synthetic-0");
    assert.ok(results[0].score > 0.99);
    assert.equal(results[0].hash, sha256(chunks[0].text));
    assert.throws(() => store.search([1, 0, 0], { ...embedding, model: "other-model" }), /differ.*Re-ingest/);
    assert.throws(() => store.replaceChunks([chunks[0], chunks[0]], embedding), /UNIQUE constraint/);
    assert.equal(store.metadata().chunks, 2);
    assert.equal(store.search([0, 1, 0], embedding, 1)[0].chunkId, "synthetic-1");
  } finally { store.close(); }
  assert.throws(() => assertEmbeddingCompatibility(embedding, { ...embedding, dimensions: 2 }), /dimensions differ/);
});

test("a failed Ollama batch re-embeds every item with one local fallback space", async t => {
  const cacheDir = await temporaryDirectory(t);
  let calls = 0;
  const fallbackInputs = [];
  const result = await embedTexts(Array.from({ length: 18 }, (_, index) => `Synthetic item ${index}`), {
    cacheDir,
    fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 2) throw new Error("synthetic offline error");
      return { ok: true, json: async () => ({ embeddings: JSON.parse(options.body).input.map(() => [1, 0, 0]) }) };
    },
    extractorFactory: async () => async texts => {
      fallbackInputs.push(...texts);
      return { tolist: () => texts.map(() => [0, 2]) };
    },
  });
  assert.equal(result.provider, "sentence-transformers");
  assert.equal(result.model, FALLBACK_EMBEDDING_MODEL);
  assert.equal(result.dimensions, 2);
  assert.equal(fallbackInputs.length, 18);
  assert.deepEqual(result.vectors, Array.from({ length: 18 }, () => [0, 1]));
  assert.match(result.fallbackReason, /all chunks/);
  await assert.rejects(embedTexts(["Synthetic query"], {
    provider: "ollama", fetchImpl: async () => { throw new Error("synthetic offline error"); },
  }), /mixed embedding spaces are not allowed/);
  assert.deepEqual(normalizeVector([3, 4]), [0.6, 0.8]);
  assert.throws(() => normalizeVector([0, 0]), /zero length/);
});

test("ingest redacts before embedding, restores locally and reindex is idempotent", async t => {
  const directory = await temporaryDirectory(t);
  const folder = path.join(directory, "company");
  const dataDir = path.join(directory, "private-index");
  await mkdir(folder);
  await writeFile(path.join(folder, "warranty.md"), "SYNTHETIC TEST DATA\nWarranty: 24 months.\ncontact_name: Jordan Example\nemail: jordan@example.invalid\nphone: +61 400 000 123\n");
  // Alphabetical discovery encounters this unlabeled name before warranty.md labels it.
  await writeFile(path.join(folder, "shipping.txt"), "SYNTHETIC TEST DATA\nShipping: 3 days. Jordan Example handles shipping.");
  const embedded = [];
  const embeddingOptions = {
    fetchImpl: async (url, options) => {
      assert.match(url, /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/);
      const request = JSON.parse(options.body);
      assert.equal(request.keep_alive, -1);
      embedded.push(...request.input);
      return embeddingResponse(request.input);
    },
  };
  const first = await ingestFolder(folder, { dataDir, embeddingProvider: "ollama", embeddingOptions });
  assert.equal(first.chunks, 2);
  assert.equal(first.files, 2);
  assert.equal(first.piiItemsRedacted, 4);
  assert.ok(embedded.some(text => text.includes("[[PII_EMAIL_")));
  assert.ok(embedded.every(text => !text.includes("jordan@example.invalid") && !text.includes("Jordan Example") && !text.includes("+61 400 000 123")));
  const second = await ingestFolder(folder, { dataDir, embeddingProvider: "ollama", embeddingOptions });
  assert.equal(second.indexFingerprint, first.indexFingerprint);
  assert.equal(second.chunks, 2);
  const vault = await createPrivacyVault(dataDir);
  const result = await retrieve("What is the warranty? Email jordan@example.invalid", { dataDir, topK: 1, vault, embeddingOptions });
  assert.equal(result.chunks[0].file, "warranty.md");
  assert.ok(result.quality > 0.99);
  assert.match(result.redactedQuestion, /\[\[PII_EMAIL_/);
  assert.match(vault.restore(result.chunks[0].text), /jordan@example.invalid/);
  assert.equal(getIndexStatus({ dataDir }).chunks, 2);
  const database = await readFile(path.join(dataDir, "index.sqlite"));
  assert.equal(database.includes(Buffer.from("jordan@example.invalid")), false);
});
