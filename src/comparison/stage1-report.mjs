import { bootstrapEstimate, mean, percentile } from './metrics.mjs';

const finite = value => typeof value === 'number' && Number.isFinite(value);
const fullCredit = value => value >= 1 - 1e-9;
const scoreOf = (row, key = 'scoring') => !row.error && row[key]?.labelAvailable !== false && finite(row[key]?.score) ? row[key].score : null;
const isSafe = row => row.safe === true || row.cloudEligible === true || (row.safety?.cloudEligible === true && row.safety?.kind === 'safe');
const safetyKnown = row => typeof row.safe === 'boolean' || typeof row.cloudEligible === 'boolean' || typeof row.safety?.cloudEligible === 'boolean';
const stagesOf = row => (row.stages ?? []).filter(stage => !stage.excludedFromTimings && stage.stage !== 'warm-up');
const tokenOf = (stage, key) => finite(stage.tokens?.[key]) ? stage.tokens[key] : null;
const hasAudit = row => row.citationAudit != null || row.answer?.citationAudit != null;
const auditOf = row => row.answer?.citationAudit ?? row.citationAudit ?? {};
const escaped = value => String(value ?? '').replaceAll('|', '\\|').replace(/[\r\n]+/g, ' ');

function phaseSummary(rows, { requested, cohort, phase }) {
  const scored = rows.filter(row => scoreOf(row) !== null), second = rows.filter(row => scoreOf(row, 'secondScore') !== null);
  const company = rows.filter(row => row.company === true), audited = company.filter(hasAudit);
  const parseMeasured = rows.filter(row => !row.error && typeof row.answer?.parseValid === 'boolean');
  const selfCheckMeasured = rows.filter(row => !row.error && typeof row.answer?.selfCheckParseValid === 'boolean');
  const answerParseApplicable = !(phase === 'before' && cohort === 'plain50');
  const latency = rows.flatMap(row => {
    const stages = stagesOf(row); return stages.length && stages.every(stage => finite(stage.latencyMs)) ? [stages.reduce((sum, stage) => sum + stage.latencyMs, 0)] : [];
  });
  const measuredTokens = rows.flatMap(row => {
    const stages = stagesOf(row);
    return stages.length && stages.every(stage => tokenOf(stage, 'input') !== null && tokenOf(stage, 'output') !== null)
      ? [{ input: stages.reduce((sum, stage) => sum + stage.tokens.input, 0), output: stages.reduce((sum, stage) => sum + stage.tokens.output, 0) }] : [];
  });
  const stageNames = [...new Set(rows.flatMap(row => stagesOf(row).map(stage => stage.stage)))].sort();
  const decisions = rows.filter(row => typeof row.decision?.route === 'string'), safe = rows.filter(isSafe);
  const invalidCitationItems = audited.filter(row => auditOf(row).hadInvalidIds === true).length;
  const repaired = row => Array.isArray(auditOf(row).repaired) ? auditOf(row).repaired.length : 0;
  const rejected = row => Array.isArray(auditOf(row).rejectedIds) ? auditOf(row).rejectedIds.length : 0;
  return {
    requested, items: rows.length, missing: requested - rows.length, errors: rows.filter(row => Boolean(row.error)).length,
    labelled: scored.length, unscored: rows.length - scored.length,
    fullCredit: scored.filter(row => fullCredit(scoreOf(row))).length,
    fullCreditRate: scored.length ? scored.filter(row => fullCredit(scoreOf(row))).length / scored.length : null,
    meanScore: mean(scored.map(row => scoreOf(row))),
    secondLabelled: second.length, secondFullCredit: second.filter(row => fullCredit(scoreOf(row, 'secondScore'))).length,
    secondMeanScore: mean(second.map(row => scoreOf(row, 'secondScore'))),
    citationEligible: company.length, citationAudited: audited.length, citationUnmeasured: company.length - audited.length,
    invalidCitationItems, rawInvalidCitationRate: audited.length ? invalidCitationItems / audited.length : null,
    missingCitationItems: audited.filter(row => auditOf(row).missingRequired === true).length,
    ungroundedCitationItems: audited.filter(row => auditOf(row).grounded === false).length,
    repairedItems: audited.filter(row => repaired(row) > 0).length, repairedIds: audited.reduce((sum, row) => sum + repaired(row), 0),
    rejectedItems: audited.filter(row => rejected(row) > 0).length, rejectedIds: audited.reduce((sum, row) => sum + rejected(row), 0),
    residualInvalidItems: audited.filter(row => finite(auditOf(row).remainingInvalidCount) && auditOf(row).remainingInvalidCount > 0).length,
    residualInvalid: audited.reduce((sum, row) => sum + (finite(auditOf(row).remainingInvalidCount) ? auditOf(row).remainingInvalidCount : 0), 0),
    answerParseFailures: answerParseApplicable ? parseMeasured.filter(row => row.answer.parseValid !== true).length : null,
    answerParseMeasured: answerParseApplicable ? parseMeasured.length : null,
    selfCheckParseFailures: phase === 'after' ? selfCheckMeasured.filter(row => row.answer.selfCheckParseValid !== true).length : null,
    selfCheckParseMeasured: phase === 'after' ? selfCheckMeasured.length : null,
    safeItems: safe.length, safetyUnmeasured: rows.filter(row => !safetyKnown(row)).length,
    routeDecisionsRecorded: decisions.length,
    localAcceptedSafe: decisions.filter(row => isSafe(row) && row.decision.route === 'local').length,
    baselineSources: Object.fromEntries([...new Set(rows.map(row => row.baselineSource).filter(Boolean))].sort().map(source => [source, rows.filter(row => row.baselineSource === source).length])),
    latencyMeasured: latency.length, medianLatencyMs: percentile(latency, .5), p95LatencyMs: percentile(latency, .95),
    tokenMeasured: measuredTokens.length, inputTokens: measuredTokens.reduce((sum, value) => sum + value.input, 0), outputTokens: measuredTokens.reduce((sum, value) => sum + value.output, 0),
    meanInputTokens: mean(measuredTokens.map(value => value.input)), meanOutputTokens: mean(measuredTokens.map(value => value.output)),
    stages: Object.fromEntries(stageNames.map(stageName => {
      const stages = rows.flatMap(row => stagesOf(row).filter(stage => stage.stage === stageName));
      return [stageName, { calls: stages.length, medianLatencyMs: percentile(stages.map(stage => stage.latencyMs).filter(finite), .5),
        meanLatencyMs: mean(stages.map(stage => stage.latencyMs).filter(finite)), inputTokens: stages.reduce((sum, stage) => sum + (tokenOf(stage, 'input') ?? 0), 0),
        outputTokens: stages.reduce((sum, stage) => sum + (tokenOf(stage, 'output') ?? 0), 0) }];
    })),
  };
}

function pairedSummary(before, after, options) {
  const byBefore = new Map(before.map(row => [row.id, row]));
  const pairs = after.flatMap(row => {
    const old = byBefore.get(row.id); if (!old) return [];
    return [{ id: row.id, groupId: row.groupId ?? old.groupId ?? row.id, before: old, after: row }];
  });
  const first = pairs.filter(row => scoreOf(row.before) !== null && scoreOf(row.after) !== null);
  const second = pairs.filter(row => scoreOf(row.before, 'secondScore') !== null && scoreOf(row.after, 'secondScore') !== null);
  const change = (selected, key, getter) => bootstrapEstimate(selected, sample => mean(sample.map(row => getter(scoreOf(row.after, key)) - getter(scoreOf(row.before, key)))), options);
  return { items: pairs.length, labelled: first.length, secondLabelled: second.length,
    beforeMeanScore: mean(first.map(row => scoreOf(row.before))), afterMeanScore: mean(first.map(row => scoreOf(row.after))),
    meanScoreChange: change(first, 'scoring', value => value), fullCreditChange: change(first, 'scoring', value => Number(fullCredit(value))),
    secondMeanScoreChange: change(second, 'secondScore', value => value), secondFullCreditChange: change(second, 'secondScore', value => Number(fullCredit(value))),
    intervalPolicy: 'Paired source-group bootstrap on common supported before/after labels; missing or failed items are visible separately and are not scored as failures.' };
}

/** Aggregate one model at a time; answer text, references and question text never enter the report. */
export function summarizeStage1(cohorts, records, { modelIds, manifest = {}, thresholds = {}, seed = manifest.seed ?? 20261027, replicates = 2000 } = {}) {
  if (!Array.isArray(modelIds) || !modelIds.length || new Set(modelIds).size !== modelIds.length) throw new Error('Distinct explicit local model IDs are required');
  if (!Array.isArray(cohorts) || new Set(cohorts.map(cohort => cohort.id)).size !== cohorts.length) throw new Error('Distinct explicit cohorts are required');
  const rows = [];
  for (const cohort of cohorts) {
    if (!Array.isArray(cohort.itemIds) || new Set(cohort.itemIds).size !== cohort.itemIds.length) throw new Error('Cohorts require unique fixed item IDs');
    const wanted = new Set(cohort.itemIds);
    for (const modelId of modelIds) {
      const selected = records.filter(row => row.cohort === cohort.id && row.modelId === modelId && wanted.has(row.id));
      const latest = new Map();
      for (const row of selected) { if (!['before', 'after'].includes(row.phase)) throw new Error('Stage 1 records require before/after phases'); latest.set(`${row.phase}|${row.id}`, row); }
      const before = [...latest.values()].filter(row => row.phase === 'before'), after = [...latest.values()].filter(row => row.phase === 'after');
      rows.push({ cohort: cohort.id, modelId, requested: cohort.itemIds.length, duplicateRecords: selected.length - latest.size,
        before: phaseSummary(before, { requested: cohort.itemIds.length, cohort: cohort.id, phase: 'before' }),
        after: phaseSummary(after, { requested: cohort.itemIds.length, cohort: cohort.id, phase: 'after' }),
        paired: pairedSummary(before, after, { seed, replicates }) });
    }
  }
  return { schemaVersion: 1, rows, cohorts: cohorts.map(cohort => ({ id: cohort.id, requested: cohort.itemIds.length })),
    modelIds: [...modelIds], thresholds: structuredClone(thresholds), thresholdsRetuned: false, seed,
    intervalMethod: { method: 'paired source-group bootstrap percentile 95%', seed, replicates },
    method: 'Full-credit answer rubric, raw citation invalidity before repair/rejection, grounded citation coverage, and answer/self-check parsing reported separately. Model sizes and cohorts are never pooled.' };
}

const percent = value => finite(value) ? `${(value * 100).toFixed(1)}%` : 'pending';
const value = amount => amount == null ? 'n/a' : String(amount);
const milliseconds = amount => finite(amount) ? `${amount.toFixed(1)} ms` : 'pending';
const full = stats => `${stats.fullCredit}/${stats.labelled}`;
const secondFull = stats => `${stats.secondFullCredit}/${stats.secondLabelled}`;
const citation = stats => `${stats.invalidCitationItems}/${stats.citationEligible}${stats.citationUnmeasured ? ` (${stats.citationUnmeasured} unmeasured)` : ''}`;
const changeCI = metric => metric?.estimate == null ? 'pending' : `${(metric.estimate * 100).toFixed(1)} pp${metric.ci95 ? ` [${metric.ci95.map(number => (number * 100).toFixed(1)).join(', ')}]` : ' [CI unavailable]'}`;

export function renderStage1Summary(report) {
  if (report.tier !== 0 || report.cloudCalls !== 0 || report.spendUsd !== 0 || report.network?.externalRequests !== 0) throw new Error('Stage 1 publication requires recorded zero cloud calls, spend and external requests');
  const rows = report.summary?.rows ?? [];
  const table = ['| Cohort | Model | Full credit before → after | Raw invalid citations before → after | Missing valid citations before → after | Answer parse failures before → after | Self-check parse failures after |',
    '|---|---|---:|---:|---:|---:|---:|', ...rows.map(row => `| ${escaped(row.cohort)} | ${escaped(row.modelId)} | ${full(row.before)} → ${full(row.after)} | ${citation(row.before)} → ${citation(row.after)} | ${row.before.missingCitationItems}/${row.before.citationEligible} → ${row.after.missingCitationItems}/${row.after.citationEligible} | ${value(row.before.answerParseFailures)} → ${value(row.after.answerParseFailures)} | ${value(row.after.selfCheckParseFailures)}/${value(row.after.selfCheckParseMeasured)} |`)];
  const secondary = ['| Cohort | Model | Second-grader full credit before → after | First-grader full-credit change, 95% CI | Second-grader full-credit change, 95% CI | First-grader mean-score change, 95% CI | Paired supported items, first / second |', '|---|---|---:|---:|---:|---:|---:|---:|',
    ...rows.map(row => `| ${escaped(row.cohort)} | ${escaped(row.modelId)} | ${secondFull(row.before)} → ${secondFull(row.after)} | ${changeCI(row.paired.fullCreditChange)} | ${changeCI(row.paired.secondFullCreditChange)} | ${changeCI(row.paired.meanScoreChange)} | ${row.paired.labelled}/${row.paired.items}; ${row.paired.secondLabelled}/${row.paired.items} |`)];
  const boundary = ['| Cohort | Model | Raw invalid rate before → after | Repaired items after | Rejected items after | Unresolved citation errors after | Safe local acceptance before → after |', '|---|---|---:|---:|---:|---:|---:|',
    ...rows.map(row => `| ${escaped(row.cohort)} | ${escaped(row.modelId)} | ${percent(row.before.rawInvalidCitationRate)} → ${percent(row.after.rawInvalidCitationRate)} | ${row.after.repairedItems} | ${row.after.rejectedItems} | ${row.after.residualInvalid} | ${row.before.routeDecisionsRecorded ? `${row.before.localAcceptedSafe}/${row.before.safeItems}` : 'pending'} → ${row.after.routeDecisionsRecorded ? `${row.after.localAcceptedSafe}/${row.after.safeItems}` : 'pending'} |`)];
  const timing = ['| Cohort | Model | Median local latency before → after | Mean output tokens before → after | Missing rows before / after | Errors before / after |', '|---|---|---:|---:|---:|---:|',
    ...rows.map(row => `| ${escaped(row.cohort)} | ${escaped(row.modelId)} | ${milliseconds(row.before.medianLatencyMs)} → ${milliseconds(row.after.medianLatencyMs)} | ${row.before.meanOutputTokens?.toFixed(1) ?? 'pending'} → ${row.after.meanOutputTokens?.toFixed(1) ?? 'pending'} | ${row.before.missing} / ${row.after.missing} | ${row.before.errors} / ${row.after.errors} |`)];
  const replayed = rows.filter(row => row.before.baselineSources.replayed_previous_method).map(row => `${escaped(row.cohort)} / ${escaped(row.modelId)} (${row.before.baselineSources.replayed_previous_method} rows)`);
  const thresholdValues = Object.entries(report.thresholds ?? report.summary?.thresholds ?? {}).map(([modelId, entry]) => `${escaped(modelId)}: ${value(typeof entry === 'number' ? entry : entry?.threshold)}`).join('; ');
  return `# Stage 1: local answer generation and citations\n\nRun ${escaped(report.runId)} · ${escaped(report.timestamp)}. **Tier 0 only: 0 cloud calls, $0 spend, 0 external requests.**\n\n## Before and after\n\n${table.join('\n')}\n\nFull credit uses each phase's supported rubric labels; unscored items remain pending. Citation rates cover company-data questions only and measure **raw invalid IDs before repair/rejection**. Missing or rejected citations remain visible; zero residual invalid IDs does not mean every generated citation was correct. Plain-before answer parsing is n/a because no JSON envelope was required. Self-check parsing is a new separate pass with no old counterpart.\n\n${replayed.length ? `Prior-method baselines replayed now, rather than saved from the previous run: **${replayed.join('; ')}**.\n\n` : ''}## Paired scoring and confidence intervals\n\n${secondary.join('\n')}\n\nPaired changes use common supported IDs and a seeded source-group bootstrap. The second grader is an independent deterministic robustness check, not an expert semantic gold standard. Neither unsupported rules nor missing results are silently scored as failures.\n\n## Citation boundary and frozen routing\n\n${boundary.join('\n')}\n\nCalibration thresholds are unchanged: ${thresholdValues || 'see frozen threshold artifact'}. Existing zero thresholds can still cause complete abstention, even if answer quality improves. No classifier was retrained or threshold selected from these test results. Adversarial items remain local regardless of self-check or citation results.\n\n## Additional local work\n\n${timing.join('\n')}\n\nAfter latency and output tokens include both answer generation and the separate local self-check; warm-up is excluded. No extra pass is presented as free. Stage-level timing/token details and measurement coverage are in report.json.\n\n${report.savedContextFrozen ? 'The saved retrieval contexts and source chunks were frozen. Retrieval completeness was not changed or claimed fixed.' : 'Saved-context identity is not confirmed; inspect the run manifest before interpreting comparisons.'}\n\n**STOP: Stage 2 has not started.**\n`;
}
