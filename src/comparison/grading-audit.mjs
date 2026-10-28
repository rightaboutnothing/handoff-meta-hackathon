import { readFile } from 'node:fs/promises';
import { sha256 } from '../rag/receipts.mjs';
import { bootstrapEstimate, mean } from './metrics.mjs';
import { gradeBlindAnswer } from '../scoring/second-grader.mjs';

export const AUDIT_SEED = 20261028;
export const AUDIT_MODELS = ['llama3.1:8b', 'gemma3:12b'];
const path = new URL('../../tasks/comparison/grading-audit-manifest.json', import.meta.url);
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function selectAuditIds(manifest, { seed = AUDIT_SEED, count = 200 } = {}) {
  if (!Number.isInteger(count) || count < 1 || count > manifest.testIDs.length) throw new Error('Invalid held-out grading audit sample size');
  return [...manifest.testIDs].sort((left, right) => sha256(`${seed}|independent-grading-audit|${left}`).localeCompare(sha256(`${seed}|independent-grading-audit|${right}`))).slice(0, count);
}
export async function loadAuditManifest() { return JSON.parse(await readFile(path, 'utf8')); }
export function makeAuditManifest(manifest, items, { seed = AUDIT_SEED, count = 200, sourceManifestHash = sha256(manifest) } = {}) {
  const itemIds = selectAuditIds(manifest, { seed, count }), byId = new Map(items.map(item => [item.id, item]));
  if (itemIds.some(id => !byId.has(id))) throw new Error('Audit sampling requires every registered item ID');
  return { schemaVersion: 1, version: 'independent-grading-audit-v1', seed, sampling: 'Uniform pseudorandom sample without replacement: SHA256 seeded purpose+ID ranking over all held-out final-test IDs',
    sourceManifestHash, datasetSha256: manifest.itemsSha256, population: 'held-out final test', populationItems: manifest.testIDs.length, items: itemIds.length, itemIds,
    categoryCounts: Object.fromEntries([...new Set(itemIds.map(id => byId.get(id).category))].sort().map(category => [category, itemIds.filter(id => byId.get(id).category === category).length])),
    originalReportedTestIds: manifest.tier0.testIDs, originalReportedTestItems: manifest.tier0.testIDs.length,
    promptAblationIds: [...itemIds].sort((left, right) => sha256(`${seed}|prompt-format-ablation|${left}`).localeCompare(sha256(`${seed}|prompt-format-ablation|${right}`))).slice(0, Math.min(50, itemIds.length)),
    promptAblationPolicy: 'Predeclared random 50-question subset of the random 200. Both models retain identical question, retrieved evidence, temperature, seed and 384-token cap. Only the outer JSON/confidence/routing answer instructions are replaced by a shared direct-answer instruction. All generation and grading stay local.',
    policy: 'The fresh 200-item random audit is separate from the original 60-item reported slice. Both are reported; neither changes routing thresholds or model settings. Gated records are IDs only.' };
}
function label(record) {
  const grade = record.scoring ?? record.firstGrade;
  return grade?.labelAvailable !== false && finite(grade?.score) ? grade.score : null;
}
function compareMethods(item, record) {
  const blindCandidate = { answerText: record.answerForGrading ?? record.answer?.answer ?? record.answerText ?? '', rawText: record.rawForGrading ?? record.raw?.text,
    parseValid: record.answer?.parseValid, unavailable: Boolean(record.error || record.status === 'error') };
  const second = gradeBlindAnswer(item, blindCandidate), firstScore = label(record);
  const secondScore = second.labelAvailable && finite(second.score) ? second.score : null;
  let reason = null;
  if (firstScore == null || secondScore == null) reason = firstScore !== secondScore ? 'coverage_difference' : null;
  else if (Math.abs(firstScore - secondScore) > 1e-9) {
    if ((item.reference?.correct_option ?? item.reference?.correctOption) && record.scoring?.optionParsed === false && second.optionParsed && !second.ambiguous) reason = 'format_option_recovery';
    else if (second.ambiguous) reason = 'contradictory_choice_rejected';
    else if (second.formatRecovery) reason = 'format_envelope_recovery';
    else if (item.reference?.requiredFacts) reason = 'fact_normalization_or_negation';
    else if (item.reference?.instruction_ids) reason = 'independent_constraint_check';
    else reason = 'independent_rubric_check';
  }
  return { id: item.id, groupId: item.groupId, category: item.category, firstScore, secondScore, second, disagreementReason: reason,
    originalParseValid: record.answer?.parseValid ?? null, originalOptionParsed: record.scoring?.optionParsed ?? null };
}
function metric(rows, statistic, options) { return bootstrapEstimate(rows, statistic, options); }
function modelSummary(rows, options) {
  const first = rows.filter(row => finite(row.firstScore)), second = rows.filter(row => finite(row.secondScore)), paired = rows.filter(row => finite(row.firstScore) && finite(row.secondScore));
  const exact = row => Math.abs(row.firstScore - row.secondScore) < 1e-9, fullCorrect = value => value >= 1 - 1e-9;
  const kappa = sample => {
    if (!sample.length) return null;
    const observed = mean(sample.map(row => Number(fullCorrect(row.firstScore) === fullCorrect(row.secondScore))));
    const p1 = mean(sample.map(row => Number(fullCorrect(row.firstScore)))), p2 = mean(sample.map(row => Number(fullCorrect(row.secondScore))));
    const chance = p1 * p2 + (1 - p1) * (1 - p2);
    return Math.abs(1 - chance) < 1e-12 ? null : (observed - chance) / (1 - chance);
  };
  return { items: rows.length, firstLabelled: first.length, secondLabelled: second.length, pairedLabelled: paired.length,
    firstScore: metric(first, sample => mean(sample.map(row => row.firstScore)), options), secondScore: metric(second, sample => mean(sample.map(row => row.secondScore)), options),
    pairedFirstScore: metric(paired, sample => mean(sample.map(row => row.firstScore)), options), pairedSecondScore: metric(paired, sample => mean(sample.map(row => row.secondScore)), options),
    exactScoreAgreement: metric(paired, sample => mean(sample.map(row => Number(exact(row)))), options),
    fullCreditAgreement: metric(paired, sample => mean(sample.map(row => Number(fullCorrect(row.firstScore) === fullCorrect(row.secondScore)))), options),
    fullCreditKappa: metric(paired, kappa, options), meanAbsoluteScoreChange: metric(paired, sample => mean(sample.map(row => Math.abs(row.firstScore - row.secondScore))), options),
    formatDisagreements: paired.filter(row => row.disagreementReason?.startsWith('format_')).length,
    disagreements: rows.filter(row => row.disagreementReason).map(row => ({ id: row.id, category: row.category, firstScore: row.firstScore, secondScore: row.secondScore, reason: row.disagreementReason })),
    methodCounts: Object.fromEntries([...new Set(rows.map(row => row.second.extraction ?? row.second.method))].sort().map(method => [method, rows.filter(row => (row.second.extraction ?? row.second.method) === method).length])) };
}
function cohortSummary(ids, all, models, { seed, replicates }) {
  const idSet = new Set(ids), options = { seed, replicates }, summaries = {};
  for (const model of models) {
    const rows = all[model].filter(row => idSet.has(row.id)); summaries[model] = modelSummary(rows, options);
    summaries[model].byCategory = Object.fromEntries([...new Set(rows.map(row => row.category))].sort().map(category => [category, modelSummary(rows.filter(row => row.category === category), options)]));
  }
  const first = new Map(all[models[0]].map(row => [row.id, row])), second = new Map(all[models[1]].map(row => [row.id, row]));
  const paired = ids.map(id => ({ id, groupId: first.get(id)?.groupId, first: first.get(id), second: second.get(id) }))
    .filter(row => [row.first?.firstScore, row.first?.secondScore, row.second?.firstScore, row.second?.secondScore].every(finite));
  const oldGap = row => row.second.firstScore - row.first.firstScore, newGap = row => row.second.secondScore - row.first.secondScore;
  return { items: ids.length, models: summaries, pairedModels: paired.length,
    gapDefinition: `${models[1]} minus ${models[0]}; positive favors the former`,
    baselineGap: metric(paired, sample => mean(sample.map(oldGap)), options), secondMethodGap: metric(paired, sample => mean(sample.map(newGap)), options),
    gapChange: metric(paired, sample => mean(sample.map(row => newGap(row) - oldGap(row))), options),
    interpretation: 'Compare score gaps on identical questions and common supported labels. A changed extraction format may explain part of a gap; this automated second method does not replace expert semantic review.' };
}
export function auditLocalAnswers({ items, recordsByModel, manifest, models = AUDIT_MODELS, seed = manifest.seed, replicates = 2000 } = {}) {
  if (models.length !== 2 || new Set(models).size !== 2) throw new Error('A paired grading audit requires two distinct local models');
  const requiredIds = [...new Set([...manifest.itemIds, ...manifest.originalReportedTestIds])], byId = new Map(items.map(item => [item.id, item])), all = {};
  for (const model of models) {
    const byRecord = new Map((recordsByModel[model] ?? []).map(record => [record.id, record]));
    if (requiredIds.some(id => !byId.has(id) || !byRecord.has(id))) throw new Error('The paired audit is missing required local answers; do not silently shrink the sample');
    all[model] = requiredIds.map(id => compareMethods(byId.get(id), byRecord.get(id)));
  }
  const random200 = cohortSummary(manifest.itemIds, all, models, { seed, replicates }), original60 = cohortSummary(manifest.originalReportedTestIds, all, models, { seed: seed + 1, replicates });
  return { schemaVersion: 1, method: 'independent-format-tolerant-rubric-v1', seed, modelIds: models, manifestHash: sha256(manifest), cloudCalls: 0, actualSpendUsd: 0,
    random200, originalReportedSlice: original60,
    protections: { graderBlindToModelAndPairing: true, routingThresholdsRetuned: false, identicalQuestionCohorts: true, rawAnswersPublished: false, gatedQuestionTextPublished: false },
    limitations: ['The second method is an independently implemented deterministic robustness grader, not a human or model semantic gold standard.',
      'IFEval uses independently implemented supported verifiable rules; unsupported rules remain pending. This is not the complete official evaluator.',
      'The fresh uniform 200-item held-out sample has a different category mix from the earlier balanced 60-item slice; gaps are reported separately.',
      'Source-group bootstrap 95% intervals retain related synthetic families together. Small category samples and ambiguous responses limit precision.'],
    intervalMethod: { method: 'paired seeded source-group bootstrap percentile 95%', seed, replicates },
    scoringVersion: { first: 'original exact-leading-option / required-fact scorer', second: 'independent format recovery + explicit/text choice + canonical numeric/fact verifier' } };
}

export function summarizePromptAblation({ items, originalRecordsByModel, plainRecordsByModel, manifest, models = AUDIT_MODELS, seed = manifest.seed + 2, replicates = 2000 } = {}) {
  if (models.length !== 2 || new Set(models).size !== 2) throw new Error('Prompt ablation requires two distinct local models');
  const ids = manifest.promptAblationIds ?? [], byId = new Map(items.map(item => [item.id, item])), options = { seed, replicates }, perModel = {}, pairedMaps = {};
  if (!ids.length) throw new Error('The predeclared prompt-format ablation IDs are missing');
  for (const model of models) {
    const original = new Map((originalRecordsByModel[model] ?? []).map(row => [row.id, row])), plain = new Map((plainRecordsByModel[model] ?? []).map(row => [row.id, row]));
    if (ids.some(id => !byId.has(id) || !original.has(id) || !plain.has(id))) throw new Error('Prompt ablation is missing required paired local responses');
    const rows = ids.map(id => {
      const item = byId.get(id), json = compareMethods(item, original.get(id)), direct = compareMethods(item, plain.get(id));
      return { id, groupId: item.groupId, category: item.category, original: json.secondScore, plain: direct.secondScore, originalEnvelopeValid: original.get(id).answer?.parseValid === true };
    });
    const paired = rows.filter(row => finite(row.original) && finite(row.plain));
    const summarize = selected => ({ items: selected.length,
      originalScore: metric(selected, sample => mean(sample.map(row => row.original)), options), plainScore: metric(selected, sample => mean(sample.map(row => row.plain)), options),
      withinModelChange: metric(selected, sample => mean(sample.map(row => row.plain - row.original)), options) });
    perModel[model] = { ...summarize(paired), requestedItems: ids.length, originalEnvelopeValidRate: metric(rows, sample => mean(sample.map(row => Number(row.originalEnvelopeValid))), options),
      byCategory: Object.fromEntries([...new Set(rows.map(row => row.category))].sort().map(category => [category, summarize(paired.filter(row => row.category === category))])) };
    pairedMaps[model] = new Map(rows.map(row => [row.id, row]));
  }
  const all = ids.map(id => ({ id, groupId: byId.get(id).groupId, first: pairedMaps[models[0]].get(id), second: pairedMaps[models[1]].get(id) }));
  const common = all.filter(row => [row.first.original, row.first.plain, row.second.original, row.second.plain].every(finite));
  const originalGap = row => row.second.original - row.first.original, plainGap = row => row.second.plain - row.first.plain;
  const bothValid = common.filter(row => row.first.originalEnvelopeValid && row.second.originalEnvelopeValid);
  return { method: 'predeclared-paired-local-prompt-format-ablation-v1', seed, requestedItems: ids.length, items: common.length, models: perModel,
    originalPromptGap: metric(common, sample => mean(sample.map(originalGap)), options), plainPromptGap: metric(common, sample => mean(sample.map(plainGap)), options),
    gapChange: metric(common, sample => mean(sample.map(row => plainGap(row) - originalGap(row))), options),
    gapDefinition: `${models[1]} minus ${models[0]}; within-model change is plain minus JSON-wrapper score`,
    originalBothEnvelopesValid: { items: bothValid.length, originalPromptGap: metric(bothValid, sample => mean(sample.map(originalGap)), options), plainPromptGap: metric(bothValid, sample => mean(sample.map(plainGap)), options) },
    cloudCalls: 0, actualSpendUsd: 0, policy: manifest.promptAblationPolicy,
    limitations: ['Both prompt variants are scored with the same blind second method. This tests sensitivity to the outer answer format, not whether either automatic grader is a semantic gold standard.',
      'Prompt effects and finite-sample uncertainty must be distinguished from a universal model ranking. No routing threshold is retuned from this audit.'],
    intervalMethod: { method: 'paired source-group bootstrap percentile 95%', seed, replicates } };
}
