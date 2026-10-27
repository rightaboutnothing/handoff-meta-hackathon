import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hash = value => createHash('sha256').update(value).digest('hex');
const number = value => Number.isFinite(Number(value)) ? Number(value) : 0;
const mean = values => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
const ratio = (count, total) => total ? count / total : null;

// This is a transparent fact-coverage check, not a cloud grader or expert assessment.
export function normalizeAnswer(value) {
  return String(value ?? '').toLowerCase().replace(/(\d),(?=\d{3}\b)/g, '$1')
    .replace(/\b\d+(?:\.\d+)?\b/g, token => `number${String(Number(token)).replace('.', 'point')}`)
    .replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
}

function containsFact(answer, fact) {
  const choices = Array.isArray(fact) ? fact : [fact];
  return choices.some(choice => (` ${answer} `).includes(` ${normalizeAnswer(choice)} `));
}

export function scoreRagAnswer(question, result) {
  if (result.status === 'deferred_cloud' || result.route === 'deferred_cloud') {
    return { answerAccuracy: null, citationAccuracy: null, citationRecall: null, scored: false, reason: 'Cloud answer deferred; excluded from the scored denominator.' };
  }
  if (!['ok', 'blocked_local'].includes(result.status)) {
    return { answerAccuracy: null, citationAccuracy: null, citationRecall: null, scored: false, reason: 'Execution error; excluded from the scored denominator and reported separately.' };
  }
  const facts = question.reference?.requiredFacts ?? [];
  const answer = normalizeAnswer(result.answer);
  const matched = facts.filter(fact => containsFact(answer, fact)).length;
  const expected = new Set(question.expectedChunkIds ?? question.reference?.sources?.map(source => source.chunkId) ?? []);
  const cited = [...new Set((result.citations ?? []).map(citation => citation.chunkId))];
  const correct = cited.filter(id => expected.has(id)).length;
  return {
    scored: true,
    answerAccuracy: result.status === 'blocked_local' ? 0 : facts.length ? matched / facts.length : null,
    citationAccuracy: cited.length ? correct / cited.length : 0,
    citationRecall: expected.size ? correct / expected.size : null,
    matchedFacts: matched, totalFacts: facts.length,
    reason: result.status === 'blocked_local' ? 'Safe synthetic question blocked locally.' : `Matched ${matched}/${facts.length} required facts; ${correct}/${cited.length} citations match reference chunks.`,
  };
}

export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = (sorted.length - 1) * fraction;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
}

export function summarizeRagResults(rows, pricing) {
  const scored = rows.filter(row => row.scoring.scored);
  const completed = rows.filter(row => row.result.status === 'ok');
  const actualHandoffs = rows.filter(row => number(row.result.metrics?.tokensSentToCloud) > 0);
  const intendedHandoffs = rows.filter(row => ['cloud', 'deferred_cloud'].includes(row.result.route));
  const receipts = rows.filter(row => row.result.receipt);
  const sumMetric = key => rows.reduce((sum, row) => sum + number(row.result.metrics?.[key]), 0);
  const perThousand = value => rows.length ? value / rows.length * pricing.queriesPerComparison : null;
  const projected = intendedHandoffs.reduce((sum, row) => sum + number(row.result.metrics?.projectedHandoffCostUsd), 0);
  const knownCloudCostUsd = rows.reduce((sum, row) => {
    const cost = row.result.metrics?.actualCostUsd;
    return sum + (typeof cost === 'number' && Number.isFinite(cost) ? cost : 0);
  }, 0);
  const cloudCostUnknownItems = rows.filter(row => row.result.metrics?.cloudCostUnknown === true ||
    (number(row.result.metrics?.tokensSentToCloud) > 0 && row.result.metrics?.actualCostUsd == null)).length;
  const localAllowance = rows.length * pricing.localPerQueryUsd;
  const groups = {};
  for (const category of ['lookup', 'multi_document', 'cloud']) {
    const subset = scored.filter(row => row.category === category);
    groups[category] = { scored: subset.length, answerAccuracy: mean(subset.map(row => row.scoring.answerAccuracy).filter(value => value !== null)) };
  }
  const stages = {};
  for (const row of rows) for (const stage of row.result.metrics?.stages ?? []) {
    const model = typeof stage.modelId === 'object' ? `${stage.modelId.provider}/${stage.modelId.model}` : stage.modelId;
    const key = `${stage.stage}:${model}`;
    (stages[key] ??= []).push(number(stage.latencyMs));
  }
  return {
    items: rows.length, completed: completed.length, scored: scored.length,
    deferred: rows.filter(row => row.result.status === 'deferred_cloud').length,
    errors: rows.filter(row => row.result.status === 'error').length,
    blockedLocal: rows.filter(row => row.result.status === 'blocked_local').length,
    scoringCoverage: ratio(scored.length, rows.length),
    answerAccuracy: mean(scored.map(row => row.scoring.answerAccuracy).filter(value => value !== null)),
    citationAccuracy: mean(scored.map(row => row.scoring.citationAccuracy).filter(value => value !== null)),
    citationRecall: mean(scored.map(row => row.scoring.citationRecall).filter(value => value !== null)),
    localAnswerRate: ratio(rows.filter(row => row.result.route === 'local' && row.result.status === 'ok').length, rows.length),
    handoffRate: ratio(intendedHandoffs.length, rows.length),
    actualCloudCallRate: ratio(actualHandoffs.length, rows.length),
    medianLatencyMs: percentile(rows.map(row => number(row.result.metrics?.latencyMs)), 0.5),
    p95LatencyMs: percentile(rows.map(row => number(row.result.metrics?.latencyMs)), 0.95),
    tokensSentToCloud: sumMetric('tokensSentToCloud'), outboundChunks: sumMetric('outboundChunks'),
    estimatedCloudInputTokens: sumMetric('estimatedCloudInputTokens'),
    piiItemsRedacted: sumMetric('piiItemsRedacted'), guardBlocks: sumMetric('guardBlocks'),
    receiptsIssued: receipts.length,
    receiptsVerified: receipts.filter(row => row.result.metrics?.receiptVerified === true).length,
    knownCloudCostUsd,
    // Compatibility for consumers of the original summary schema: this is a known subtotal.
    actualCostUsd: knownCloudCostUsd,
    cloudCostUnknownItems,
    estimatedCloudCostUsd: sumMetric('estimatedCloudCostUsd'),
    estimatedHandoffPer1000Usd: perThousand(projected + localAllowance),
    estimatedAllCloudPer1000Usd: perThousand(sumMetric('allCloudCostUsdAssumption')),
    estimatedLocalAllowancePer1000Usd: pricing.localPerQueryUsd * pricing.queriesPerComparison,
    categories: groups,
    stages: Object.fromEntries(Object.entries(stages).map(([key, values]) => [key, { count: values.length, medianLatencyMs: percentile(values, 0.5), p95LatencyMs: percentile(values, 0.95) }])),
  };
}

async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }
async function codeFingerprint() {
  const names = (await readdir(path.join(repoRoot, 'src/rag'))).filter(name => name.endsWith('.mjs')).sort();
  const modelCalls = await readFile(path.join(repoRoot, 'src/server/gateway-models.mjs'), 'utf8');
  return hash((await Promise.all(names.map(async name => name + '\n' + await readFile(path.join(repoRoot, 'src/rag', name), 'utf8')))).join('\n') + modelCalls);
}
async function durableAppend(file, row) {
  const handle = await open(file, 'a');
  try { await handle.writeFile(JSON.stringify(row) + '\n'); await handle.sync(); }
  finally { await handle.close(); }
}
async function readCheckpoint(file) {
  let text;
  try { text = await readFile(file, 'utf8'); } catch (error) { if (error.code === 'ENOENT') return []; throw error; }
  // A crash can leave only the final write incomplete. Preserve every complete row.
  if (text && !text.endsWith('\n')) {
    const lastNewline = text.lastIndexOf('\n');
    text = text.slice(0, lastNewline + 1);
    await writeFile(file, text, 'utf8');
  }
  return text.split('\n').filter(Boolean).map(line => JSON.parse(line));
}

export async function evaluateRag(options = {}) {
  const {
    dataDir, offlineMeta = true, mode = 'rag', onProgress, resume = true, limit, warmUp = null,
    datasetDir = path.join(repoRoot, 'demo_data'), logRoot = path.join(repoRoot, '.logs'),
    ask = async (question, askOptions) => (await import('./gateway.mjs')).askRag(question, askOptions),
    sleep = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds)),
    maxRetries = 3,
  } = options;
  if (!['rag', 'control', 'paired'].includes(mode)) throw new Error('Evaluation mode must be rag, control or paired.');
  if (!Number.isInteger(maxRetries) || maxRetries < 0 || maxRetries > 3) throw new Error('Evaluation maxRetries must be an integer from 0 to 3.');
  const [manifest, pricing, method, jsonl] = await Promise.all([
    readJson(path.join(datasetDir, 'manifest.json')), readJson(path.join(repoRoot, 'config/rag-pricing.json')),
    readJson(path.join(repoRoot, 'config/rag.json')), readFile(path.join(datasetDir, 'evaluation.jsonl'), 'utf8'),
  ]);
  if (manifest.synthetic !== true || manifest.evaluationSha256 !== hash(jsonl)) throw new Error('Evaluation requires an unchanged, explicitly synthetic demo manifest.');
  const allQuestions = jsonl.split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  if (allQuestions.some(question => question.synthetic !== true) || new Set(allQuestions.map(question => question.id)).size !== allQuestions.length) throw new Error('Evaluation questions must be synthetic and have unique IDs.');
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1)) throw new Error('Evaluation limit must be a positive integer.');
  const questions = limit ? allQuestions.slice(0, limit) : allQuestions;
  const sourceIdentity = [];
  for (const source of manifest.files) {
    const text = await readFile(path.join(datasetDir, source.file), 'utf8');
    if (hash(text) !== source.sha256) throw new Error(`Synthetic source changed: ${source.file}`);
    sourceIdentity.push(source.sha256);
  }
  const codeHash = await codeFingerprint();
  const indexIdentity = options.indexIdentity ?? (await import('./store.mjs')).getIndexStatus({ dataDir });
  if (!options.ask && mode !== 'control' && !indexIdentity.ready) throw new Error('Ingest the synthetic demo dataset before evaluating RAG.');
  const identity = { dataset: hash(jsonl), sourceIdentity, method, pricing, codeHash, indexIdentity, offlineMeta, maxRetries, limit: limit ?? null, dataDir: path.resolve(dataDir ?? '.handoff') };
  const fingerprint = hash(JSON.stringify(identity)).slice(0, 16);
  const modes = mode === 'paired' ? ['rag', 'control'] : [mode];
  const results = [];
  for (const runMode of modes) {
    const directory = path.join(logRoot, `rag-eval-${runMode}-${fingerprint}`);
    await mkdir(directory, { recursive: true });
    const checkpoint = path.join(directory, 'results.jsonl');
    const existing = resume ? await readCheckpoint(checkpoint) : [];
    if (!resume) {
      try { if ((await stat(checkpoint)).size > 0) throw new Error('Checkpoint already exists. Resume it or choose a separate logRoot.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    const finished = new Map(existing.map(row => [row.id, row]));
    if (existing.some(row => row.fingerprint !== fingerprint || row.mode !== runMode)) throw new Error('Checkpoint method mismatch.');
    await writeFile(path.join(directory, 'method.json'), JSON.stringify({ fingerprint, ...identity, mode: runMode, seed: manifest.seed, questionOrder: questions.map(question => question.id), warmUpExcluded: true, warmUp, checkpoint: 'one durable row per finished item', maxRetries, retryBackoffMs: [1000, 2000, 4000] }, null, 2) + '\n');
    for (const question of questions) {
      if (finished.has(question.id)) { results.push(finished.get(question.id)); continue; }
      let result; let attempts = 0;
      const started = performance.now();
      for (;;) {
        attempts += 1;
        try {
          result = await ask(question.prompt, { dataDir, offlineMeta, retrievalEnabled: runMode === 'rag' });
          if (result.status === 'error') throw new Error('Gateway returned an execution error.');
          break;
        } catch {
          if (attempts > maxRetries) {
            result = { status: 'error', route: 'error', answer: '', citations: [], metrics: { latencyMs: Math.round(performance.now() - started), stages: [], tokensSentToCloud: 0 }, error: 'Execution failed after bounded retries; inspect the local gateway logs.' };
            break;
          }
          const backoffMs = Math.min(1000 * 2 ** (attempts - 1), 30_000);
          await appendFile(path.join(directory, 'progress.jsonl'), JSON.stringify({ timestamp: new Date().toISOString(), id: question.id, event: 'retry', attempt: attempts, backoffMs }) + '\n');
          await sleep(backoffMs);
        }
      }
      const row = { id: question.id, category: question.category, synthetic: true, mode: runMode, fingerprint, timestamp: new Date().toISOString(), attempts, result, scoring: scoreRagAnswer(question, result) };
      await durableAppend(checkpoint, row);
      results.push(row);
      const progress = { timestamp: row.timestamp, mode: runMode, id: row.id, finished: results.filter(item => item.mode === runMode).length, total: questions.length, status: result.status, route: result.route, latencyMs: result.metrics?.latencyMs, answerAccuracy: row.scoring.answerAccuracy };
      await appendFile(path.join(directory, 'progress.jsonl'), JSON.stringify(progress) + '\n');
      await onProgress?.(progress);
    }
  }
  const summary = Object.fromEntries(modes.map(runMode => [runMode, summarizeRagResults(results.filter(row => row.mode === runMode), pricing)]));
  const baseline = method.baseline ?? { medianLatencyMs: 1300, handoffRate: 0.296, name: 'Finkd historical results on different task suites' };
  const comparison = summary.rag && summary.control ? {
    medianLatencyChangeMs: summary.rag.medianLatencyMs - summary.control.medianLatencyMs,
    handoffRateChangePercentagePoints: (summary.rag.handoffRate - summary.control.handoffRate) * 100,
    note: 'Matched synthetic questions and settings; control disables retrieval. Offline latency excludes cloud completion, so this is a local routing comparison.',
  } : null;
  return {
    synthetic: true, generatedAt: new Date().toISOString(), mode, seed: manifest.seed,
    fingerprint, datasetSha256: hash(jsonl), questionCount: questions.length, offlineMeta,
    method: { ...method, indexIdentity, warmUpExcluded: true, warmUp, maxRetries, runOrder: modes },
    historicalBaseline: { ...baseline, comparisonWarning: 'Different datasets and safety boundary; descriptive reference only, not a causal before/after.' },
    summary, comparison, pricingAssumptions: pricing, results,
    limitations: [
      'Answer accuracy is deterministic required-fact coverage, not an expert or model-graded quality score.',
      'Citation accuracy is precision against expected source chunk IDs; source coverage is reported separately as citation recall.',
      'Deferred cloud answers and execution errors are excluded from scored accuracy, with coverage and counts shown.',
      'Offline latency measures local processing and handoff preparation, not unavailable cloud completion.',
      'PII redaction counts are placeholder occurrences processed per query, not unique people or unique records.',
      'Cost figures per 1,000 queries are assumptions, not measured all-cloud bills. Known cloud cost sums only provider-reported charges; missing charges and uncertain failed-request charges are counted separately, never replaced by estimates or treated as a complete bill.',
    ],
  };
}

const percent = value => value === null || value === undefined ? 'deferred' : `${(value * 100).toFixed(1)}%`;
const seconds = value => value === null || value === undefined ? 'n/a' : `${(value / 1000).toFixed(2)}s`;
const money = value => value === null || value === undefined ? 'n/a' : `$${value.toFixed(4)}`;

export function renderRagSummary(report) {
  const rows = Object.entries(report.summary);
  const baseline = report.historicalBaseline;
  const lines = [
    '# Handoff company-data evaluation', '',
    `${report.offlineMeta ? '**INTERIM: offline Meta. No Muse Spark calls were made. Cloud answers remain deferred.**' : 'Live Meta evaluation; actual cloud calls are counted below.'}`, '',
    `Synthetic Acme Filtration data; seed **${report.seed}**; ${report.questionCount} identical questions per mode. Fingerprint: \`${report.fingerprint}\`.`, '',
    `Historical Finkd reference: **${seconds(baseline.medianLatencyMs)} median**, **${percent(baseline.handoffRate)} handoff**. ${baseline.comparisonWarning}`, '',
    '| Mode | Scored / items | Answer fact accuracy | Citation precision | Citation recall | Local answers | Handoffs requested | Actual cloud | Median | p95 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(([mode, item]) => `| ${mode} | ${item.scored}/${item.items} | ${percent(item.answerAccuracy)} | ${percent(item.citationAccuracy)} | ${percent(item.citationRecall)} | ${percent(item.localAnswerRate)} | ${percent(item.handoffRate)} | ${percent(item.actualCloudCallRate)} | ${seconds(item.medianLatencyMs)} | ${seconds(item.p95LatencyMs)} |`), '',
    '| Mode | Deferred | Errors | Cloud tokens sent | PII redactions | Guard blocks | Receipts verified / issued | Known cloud cost | Unknown-cost items | Projected Handoff / 1,000 | Projected all-cloud / 1,000 |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...rows.map(([mode, item]) => `| ${mode} | ${item.deferred} | ${item.errors} | ${item.tokensSentToCloud} | ${item.piiItemsRedacted} | ${item.guardBlocks} | ${item.receiptsVerified}/${item.receiptsIssued} | ${money(item.knownCloudCostUsd)} | ${item.cloudCostUnknownItems} | ${money(item.estimatedHandoffPer1000Usd)} | ${money(item.estimatedAllCloudPer1000Usd)} |`), '',
  ];
  if (report.comparison) lines.push(`Matched RAG minus no-retrieval control: median **${seconds(report.comparison.medianLatencyChangeMs)}**, handoffs **${report.comparison.handoffRateChangePercentagePoints.toFixed(1)} percentage points**. ${report.comparison.note}`, '');
  for (const [mode, item] of rows) {
    lines.push(`## ${mode} category results`, '', '| Category | Scored | Answer fact accuracy |', '| --- | ---: | ---: |', ...Object.entries(item.categories).map(([name, group]) => `| ${name} | ${group.scored} | ${percent(group.answerAccuracy)} |`), '');
    lines.push(`## ${mode} step timings`, '', '| Stage and model | Calls | Median | p95 |', '| --- | ---: | ---: | ---: |', ...Object.entries(item.stages).map(([name, stage]) => `| ${name} | ${stage.count} | ${seconds(stage.medianLatencyMs)} | ${seconds(stage.p95LatencyMs)} |`), '');
  }
  lines.push('## Method and pricing assumptions', '',
    `Warm-up calls are excluded. Run order: ${report.method.runOrder.join(' then ')}. Models: ${report.method.localModel}, ${report.method.guardModel}, ${report.method.cloudModel}. Keep-alive: ${report.method.keepAlive}; local max output: ${report.method.maxOutputTokens}; cloud reasoning: ${report.method.reasoningEffort}.`, '',
    `**Illustrative USD assumptions:** Muse Spark input $${report.pricingAssumptions.museInputPerMillionUsd}/million tokens; output $${report.pricingAssumptions.museOutputPerMillionUsd}/million tokens; ${report.pricingAssumptions.expectedOutputTokens} expected output tokens; local electricity/hardware allowance $${report.pricingAssumptions.localPerQueryUsd}/query. These are not verified list prices.`, '',
    'All-cloud is a counterfactual using the full top-k retrieved redacted context on every question. Handoff uses only its selected chunks when a handoff is requested. Deferred handoffs remain in the projected cost. No all-cloud baseline requests are sent.', '',
    ...report.limitations.map(item => `- ${item}`), '',
    '## Deferred question IDs', '',
    ...rows.map(([mode]) => `${mode}: ${report.results.filter(row => row.mode === mode && row.result.status === 'deferred_cloud').map(row => row.id).join(', ') || 'none'}`), '',
  );
  return lines.join('\n');
}

export async function writeRagReports(report, { outputRoot = repoRoot } = {}) {
  if (report.synthetic !== true) throw new Error('Only aggregate reports from the explicitly synthetic dataset may be published.');
  const resultFile = path.join(outputRoot, 'results/rag-summary.md');
  const dashboardFile = path.join(outputRoot, 'dashboard/public/rag-evaluation.json');
  await Promise.all([mkdir(path.dirname(resultFile), { recursive: true }), mkdir(path.dirname(dashboardFile), { recursive: true })]);
  await writeFile(resultFile, renderRagSummary(report), 'utf8');
  const { results, ...aggregate } = report;
  aggregate.deferredIds = Object.fromEntries(Object.keys(report.summary).map(mode => [mode, results.filter(row => row.mode === mode && row.result.status === 'deferred_cloud').map(row => row.id)]));
  await writeFile(dashboardFile, JSON.stringify(aggregate, null, 2) + '\n', 'utf8');
  return { resultFile, dashboardFile };
}
