import 'dotenv/config';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const cache = path.join(root, '.cache/comparison');
const pins = {
  mmlu: 'b189ec765aa7ed75c8acfea42df31fdae71f97be',
  ifeval: '966cd89545d6b6acfd7638bc708b98261ca58e84',
  xstest: 'd7bb5bd738c1fcbc36edd83d5e7d1b71a3e2d84d',
  gpqa: '83022cefff930aea54f654c0b282e74b9eeda5c6',
};
async function exists(file) { try { await readFile(file); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } }
async function request(url, { label, revision, headers } = {}) {
  for (let attempt = 0; attempt <= 3; attempt++) {
    const response = await fetch(url, { headers, signal: AbortSignal.timeout(120_000) });
    if (response.ok) {
      if (revision && response.headers.get('x-revision') !== revision) throw new Error(`${label}: served revision differs from the committed pin`);
      return response;
    }
    if (attempt === 3 || ![429, 500, 502, 503, 504].includes(response.status)) throw new Error(`${label}: HTTP ${response.status}`);
    await new Promise(resolve => setTimeout(resolve, 1000 * 2 ** attempt));
  }
}
async function fetchSources() {
  await mkdir(path.join(cache, 'mmlu-pages'), { recursive: true });
  const publicSources = [
    ['ifeval.jsonl', `https://huggingface.co/datasets/google/IFEval/resolve/${pins.ifeval}/ifeval_input_data.jsonl`],
    ['xstest.csv', `https://raw.githubusercontent.com/paul-rottger/xstest/${pins.xstest}/xstest_prompts.csv`],
  ];
  for (const [file, url] of publicSources) if (!await exists(path.join(cache, file))) await writeFile(path.join(cache, file), await (await request(url, { label: file })).text());
  const mmluFile = path.join(cache, 'mmlu-pro.json');
  if (!await exists(mmluFile)) {
    const pageSize = 100, total = 12032, offsets = Array.from({ length: Math.ceil(total / pageSize) }, (_, index) => index * pageSize);
    let cursor = 0, finished = 0;
    await Promise.all(Array.from({ length: 3 }, async () => {
      while (cursor < offsets.length) {
        const offset = offsets[cursor++], file = path.join(cache, 'mmlu-pages', `${offset}.json`);
        if (!await exists(file)) {
          const query = new URLSearchParams({ dataset: 'TIGER-Lab/MMLU-Pro', config: 'default', split: 'test', offset: String(offset), length: String(Math.min(pageSize, total - offset)), revision: pins.mmlu });
          const response = await request(`https://datasets-server.huggingface.co/rows?${query}`, { label: 'MMLU-Pro page', revision: pins.mmlu });
          const data = await response.json();
          if (!Array.isArray(data.rows) || data.num_rows_total !== total || data.rows.length !== Math.min(pageSize, total - offset)) throw new Error('MMLU-Pro page count changed');
          await writeFile(file, JSON.stringify({ revision: pins.mmlu, rows: data.rows.map(value => value.row) }));
        }
        finished++;
        if (finished % 20 === 0) console.error(`Cached ${finished}/${offsets.length} public MMLU-Pro pages.`);
      }
    }));
    const pages = await Promise.all(offsets.map(async offset => JSON.parse(await readFile(path.join(cache, 'mmlu-pages', `${offset}.json`), 'utf8'))));
    if (pages.some(page => page.revision !== pins.mmlu)) throw new Error('Cached MMLU-Pro revision mismatch');
    await writeFile(mmluFile, JSON.stringify({ revision: pins.mmlu, rows: pages.flatMap(page => page.rows) }));
  }
  if (process.env.HF_TOKEN && !await exists(path.join(cache, 'gpqa-diamond.csv'))) {
    const response = await request(`https://huggingface.co/datasets/Idavidrein/gpqa/resolve/${pins.gpqa}/gpqa_diamond.csv`, { label: 'Gated GPQA fetch', headers: { Authorization: `Bearer ${process.env.HF_TOKEN}` } });
    await writeFile(path.join(cache, 'gpqa-diamond.csv'), await response.text(), { mode: 0o600 });
    console.error('Cached accepted gated GPQA content locally. Its text will not be committed.');
  }
}

try {
  if (!process.argv.includes('--offline')) await fetchSources();
  if (!process.argv.includes('--fetch-only')) {
    const { buildComparisonDataset } = await import('../src/comparison/dataset.mjs');
    const result = await buildComparisonDataset();
    console.log(JSON.stringify(result));
  } else console.log('Comparison source cache is ready. No model calls made.');
} catch (error) { console.error(error.message); process.exitCode = 1; }
