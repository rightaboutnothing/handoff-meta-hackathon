import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readGatewayResults } from '../../src/evaluation/publish-results.mjs';

const dashboardRoot = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const entry = `
  import React from 'react';
  import { renderToStaticMarkup } from 'react-dom/server';
  import { GatewaySavings } from './src/components/GatewaySavings';
  import { GatewayTrust } from './src/components/GatewayTrust';
  import { GatewayBenchmarks } from './src/components/GatewayBenchmarks';
  const views = { Savings: GatewaySavings, Trust: GatewayTrust, Benchmarks: GatewayBenchmarks };
  export function render(view, data) { return renderToStaticMarkup(React.createElement(views[view], { data })); }
`;

// React, ReactDOM and the components share a single bundled React instance.
// CSS is irrelevant to these semantic rendering checks and is not emitted.
const bundle = await build({
  stdin: { contents: entry, resolveDir: dashboardRoot, sourcefile: 'gateway-ui-check.tsx', loader: 'tsx' },
  absWorkingDir: dashboardRoot, bundle: true, write: false, platform: 'node', format: 'cjs',
  jsx: 'automatic', loader: { '.css': 'empty' }, logLevel: 'silent',
  define: { 'process.env.NODE_ENV': '"production"' },
});
const compiled = { exports: {} };
const virtualFile = path.join(dashboardRoot, '.gateway-ui-check.cjs');
new Function('module', 'exports', 'require', '__filename', '__dirname', bundle.outputFiles[0].text)(compiled, compiled.exports, require, virtualFile, dashboardRoot);
const render = compiled.exports.render;
assert.equal(typeof render, 'function', 'The bundled UI renderer must be available');

const visible = html => html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, ' ')
  .replace(/&#x([a-f0-9]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
  .replace(/&#([0-9]+);/g, (_, code) => String.fromCodePoint(Number(code)))
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;/g, "'")
  .replace(/\s+/g, ' ').trim();
const count = value => value.toLocaleString('en-US', { maximumFractionDigits: 0 });
const percent = value => `${(value * 100).toFixed(1)}%`;
const round = (data, id) => data.rounds.find(item => item.round === id)?.data ?? null;
const without = (data, ids) => ({ ...structuredClone(data), rounds: structuredClone(data.rounds).map(item => ids.includes(item.round) ? { ...item, status: 'pending', data: null } : item) });
let cases = 0;
function checkRender(view, data) {
  const html = render(view, data), text = visible(html);
  assert.doesNotMatch(text, /\b(?:NaN|undefined|Infinity)\b/, `${view} must not expose invalid measurement values`);
  cases += 1;
  return { html, text };
}

const data = await readGatewayResults();
assert.ok(data.manifest, 'Run the testing rounds before checking measured dashboard rendering');
const rag = round(data, 2), redteam = round(data, 3), receipts = round(data, 5);
assert.ok(rag && redteam && receipts, 'The measured company, red-team and receipt rounds must be available');

for (const view of ['Savings', 'Trust', 'Benchmarks']) {
  const missing = checkRender(view, null);
  assert.match(missing.text, /pending/i, `${view} must label missing results Pending`);
  assert.doesNotMatch(missing.text, /\$\s*[0-9]|\b[0-9]+(?:\.[0-9]+)?%/, `${view} must not invent cost or percentage metrics without results`);
  checkRender(view, data);
}

const pendingRag = without(data, [2]);
const missingSavings = checkRender('Savings', pendingRag);
assert.match(missingSavings.text, /Cost projection pending/, 'Missing RAG results must defer the cost comparison');
assert.match(missingSavings.text, /Projected monthly saving Pending/, 'Missing RAG results must not become a zero-dollar saving');
assert.match(checkRender('Benchmarks', pendingRag).text, /Answered locally Pending/, 'Missing RAG local share must remain Pending');
const incompleteProjection = structuredClone(data);
round(incompleteProjection, 2).summary.projectionsComplete = false;
assert.match(checkRender('Savings', incompleteProjection).text, /Cost projection pending/, 'An incomplete token projection must not produce assumed savings');

const pendingTrust = checkRender('Trust', without(data, [3, 4, 5]));
assert.match(pendingTrust.text, /Signatures verified Pending/, 'Missing verification must not show a verified receipt count');
assert.match(pendingTrust.text, /Raw PII in inspected payloads Pending/, 'A missing privacy sweep must not imply zero leaks');
assert.match(pendingTrust.text, /Harmful prompts Guard missed Pending/, 'A missing red-team sweep must not imply perfect detection');

const trust = checkRender('Trust', data).text;
assert.ok(trust.includes(`${count(redteam.summary.unsafePasses)} harmful prompts passed Guard.`), 'Measured harmful misses must remain visible');
assert.ok(trust.includes(`${count(receipts.summary.legacyUnchained)} earlier signed entries predate the linked chain.`), 'Legacy unchained entries must be disclosed');
assert.ok(trust.includes(`${count(receipts.summary.legacyPayloadSnapshotsMissing)} historical payload snapshots are unavailable.`), 'Missing historical payload evidence must be disclosed');
assert.ok(trust.includes(percent(redteam.summary.strongreject.blockRate)), 'StrongREJECT block rate must come from the measured round');
assert.ok(trust.includes(percent(redteam.summary.falseRefusalRate)), 'XSTest over-block rate must come from the measured round');
assert.match(trust, /Inbound review: Pending/, 'Absent cloud replies must not imply a measured clean inbound result');
assert.match(trust, /Unsafe pass/, 'Harmful prompts classified safe must be identified as unsafe passes in the feed');

const damaged = structuredClone(data);
assert.ok(round(damaged, 5).ledgers[0]?.details[0], 'Receipt fixture requires a recorded entry');
round(damaged, 5).ledgers[0].details[0].runId = null;
assert.match(checkRender('Trust', damaged).text, /Unknown run/, 'A malformed receipt run ID must be displayed safely');

console.log(JSON.stringify({
  check: 'gateway-ui-semantic-rendering', passed: true, renderCases: cases,
  runId: data.manifest.runId, measuredUnsafePassesVisible: redteam.summary.unsafePasses,
  measuredLegacyGapVisible: receipts.summary.legacyUnchained,
  coverage: ['real results', 'null results', 'pending rounds', 'incomplete projection', 'legacy receipt gaps', 'invalid run ID'],
  modelCalls: 0, browserCalls: 0,
}));
