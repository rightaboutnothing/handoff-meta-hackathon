import { createHash } from 'node:crypto';
import { bootstrapEstimate, mean } from './metrics.mjs';

export const CALIBRATION_CATEGORIES = Object.freeze(['reasoning', 'knowledge', 'instruction-following', 'safety-boundary', 'privacy', 'company-data single-doc', 'company-data multi-doc']);
const featureNames = Object.freeze(['confidence', 'retrievalScore', 'logSourceDocCount', 'hasValidCitations', 'logCitationCount', 'needsCloud', ...CALIBRATION_CATEGORIES.map(category => `category:${category}`)]);
const number = (value, fallback = 0) => typeof value === 'number' && Number.isFinite(value) ? value : fallback;
const clamp = value => Math.max(0, Math.min(1, number(value)));
const sigmoid = value => value >= 0 ? 1 / (1 + Math.exp(-value)) : Math.exp(value) / (1 + Math.exp(value));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const label = row => row.labelAvailable === false || row.scoring?.labelAvailable === false ? null : row.wrong === true || row.wrong === 1 ? 1 : row.wrong === false || row.wrong === 0 ? 0 : null;
const categoryOf = row => row.category ?? row.features?.category ?? 'unclassified';
function rawFeatures(input, category) {
  const features = input.features ?? input;
  const kind = category ?? features.category ?? input.category;
  return [clamp(features.confidence ?? features.selfConfidence), clamp(features.retrievalScore ?? features.retrievalQuality),
    Math.log1p(Math.max(0, Math.min(100, number(features.sourceDocCount ?? features.sourceDocuments)))),
    Number(features.hasValidCitations === true || features.grounded === true),
    Math.log1p(Math.max(0, Math.min(100, number(features.citationCount)))), Number(features.needsCloud === true),
    ...CALIBRATION_CATEGORIES.map(value => Number(kind === value))];
}
const dot = (weights, vector) => weights.reduce((sum, weight, index) => sum + weight * vector[index], 0);
function fitLogistic(rows, { iterations = 500, learningRate = .08, l2 = .02 } = {}) {
  const xs = rows.map(row => rawFeatures(row, categoryOf(row))), ys = rows.map(label), dimensions = featureNames.length;
  const means = Array.from({ length: dimensions }, (_, index) => mean(xs.map(row => row[index])) ?? 0);
  const scales = means.map((average, index) => Math.max(.1, Math.sqrt(mean(xs.map(row => (row[index] - average) ** 2)) ?? 0)));
  const standardized = xs.map(row => row.map((value, index) => (value - means[index]) / scales[index]));
  const positives = ys.reduce((sum, value) => sum + value, 0), prior = (positives + .5) / (rows.length + 1);
  let intercept = Math.log(prior / (1 - prior));
  const weights = Array(dimensions).fill(0);
  for (let iteration = 0; iteration < iterations && rows.length; iteration += 1) {
    const gradient = Array(dimensions).fill(0); let interceptGradient = 0;
    for (let row = 0; row < rows.length; row += 1) {
      const error = sigmoid(intercept + dot(weights, standardized[row])) - ys[row];
      interceptGradient += error;
      for (let column = 0; column < dimensions; column += 1) gradient[column] += error * standardized[row][column];
    }
    intercept -= learningRate * interceptGradient / rows.length;
    for (let column = 0; column < dimensions; column += 1) weights[column] -= learningRate * (gradient[column] / rows.length + l2 * weights[column]);
  }
  return { intercept, weights, means, scales, prior, iterations, learningRate, l2 };
}

function predictFit(fit, features, category) {
  const vector = rawFeatures(features, category).map((value, index) => (value - fit.means[index]) / fit.scales[index]);
  return sigmoid(fit.intercept + dot(fit.weights, vector));
}
function chooseThreshold(predictions, maxAcceptedWrongRate) {
  const thresholds = [...new Set([0, 1, ...predictions.map(row => Math.min(1, row.probability + 1e-9))])].sort((a, b) => a - b);
  let best = { threshold: 0, accepted: 0, wrong: 0, acceptedWrongRate: null };
  for (const threshold of thresholds) {
    const accepted = predictions.filter(row => row.probability < threshold), wrong = accepted.reduce((sum, row) => sum + row.label, 0);
    if (accepted.length && wrong / accepted.length <= maxAcceptedWrongRate && accepted.length > best.accepted) best = { threshold, accepted: accepted.length, wrong, acceptedWrongRate: wrong / accepted.length };
  }
  return best;
}

export function trainCalibrator(inputRows, { modelId, seed = 20261027, folds = 5, maxAcceptedWrongRate = .1, iterations = 500, learningRate = .08, l2 = .02 } = {}) {
  if (!modelId) throw new Error('Train one calibrator for one explicit local model ID');
  if (inputRows.some(row => row.split !== 'dev')) throw new Error('Calibration training and threshold selection may use dev rows only');
  if (inputRows.some(row => row.modelId && row.modelId !== modelId || row.localModelId && row.localModelId !== modelId)) throw new Error('Never mix local models when fitting a calibrator');
  if (!(maxAcceptedWrongRate >= 0 && maxAcceptedWrongRate <= 1) || !Number.isInteger(folds) || folds < 2) throw new Error('Invalid dev-only threshold policy');
  const rows = inputRows.filter(row => label(row) !== null);
  const ids = rows.map(row => row.id);
  if (new Set(ids).size !== ids.length) throw new Error('Calibration dev rows require unique item IDs');
  const groups = [...new Set(rows.map(row => row.groupId ?? row.id))].sort((a, b) => digest([seed, a]).localeCompare(digest([seed, b])));
  const count = Math.min(folds, groups.length), groupFold = new Map(groups.map((group, index) => [group, index % Math.max(1, count)]));
  const outOfFold = [];
  if (count >= 2) for (let fold = 0; fold < count; fold += 1) {
    const train = rows.filter(row => groupFold.get(row.groupId ?? row.id) !== fold), validation = rows.filter(row => groupFold.get(row.groupId ?? row.id) === fold);
    const fit = fitLogistic(train, { iterations, learningRate, l2 });
    for (const row of validation) outOfFold.push({ id: row.id, groupId: row.groupId ?? row.id, label: label(row), probability: predictFit(fit, row, categoryOf(row)), fold });
  }
  const selected = chooseThreshold(outOfFold, maxAcceptedWrongRate);
  const fit = fitLogistic(rows, { iterations, learningRate, l2 });
  return {
    version: 'per-model-logistic-wrongness-v1', modelId, seed,
    status: rows.length && count >= 2 ? 'trained_dev_only' : 'insufficient_dev_groups',
    featureNames: [...featureNames], featurePolicy: 'Only answer-time confidence, retrieved-context statistics, citation-grounding checks and task category. References, expected answers and test labels are excluded.',
    fit, threshold: count >= 2 ? selected.threshold : 0,
    thresholdPolicy: { source: 'group-held-out dev predictions only', maxAcceptedWrongRate, objective: 'maximize dev accepted coverage subject to observed accepted wrong rate', comparison: 'accept local when predicted wrongness < threshold', foldCount: count, selected },
    training: { split: 'dev', rows: rows.length, availableRows: inputRows.length, independentGroups: groups.length, labelledCoverage: inputRows.length ? rows.length / inputRows.length : null,
      wrongLabels: rows.reduce((sum, row) => sum + label(row), 0), devIds: ids, devGroups: groups, devDataHash: digest(rows.map(row => [row.id, row.groupId ?? row.id, label(row), rawFeatures(row, categoryOf(row))])) },
    outOfFold, warning: 'A small Tier 0 calibration is diagnostic. Dev risk constraints are empirical and do not guarantee the same test risk.',
  };
}

export function predictWrongness(classifier, features, options = {}) {
  if (classifier?.version !== 'per-model-logistic-wrongness-v1') throw new Error('Unsupported wrongness classifier');
  const modelId = options.modelId ?? features.modelId ?? features.localModelId;
  if (modelId && modelId !== classifier.modelId) throw new Error('Wrongness classifier belongs to a different local model');
  return predictFit(classifier.fit, features, options.category ?? features.category);
}

export function auroc(probabilities, labels) {
  const positives = labels.filter(value => value === 1).length, negatives = labels.length - positives;
  if (!positives || !negatives) return null;
  const ranked = probabilities.map((probability, index) => ({ probability, label: labels[index] })).sort((a, b) => a.probability - b.probability);
  let sumPositiveRanks = 0;
  for (let index = 0; index < ranked.length;) {
    let end = index + 1; while (end < ranked.length && ranked[end].probability === ranked[index].probability) end += 1;
    const averageRank = (index + 1 + end) / 2;
    for (let cursor = index; cursor < end; cursor += 1) if (ranked[cursor].label === 1) sumPositiveRanks += averageRank;
    index = end;
  }
  return (sumPositiveRanks - positives * (positives + 1) / 2) / (positives * negatives);
}
export function calibrationError(probabilities, labels, bins = 10) {
  if (!probabilities.length) return null;
  let total = 0;
  for (let bin = 0; bin < bins; bin += 1) {
    const indexes = probabilities.flatMap((probability, index) => Math.min(bins - 1, Math.floor(probability * bins)) === bin ? [index] : []);
    if (indexes.length) total += indexes.length / probabilities.length * Math.abs(mean(indexes.map(index => probabilities[index])) - mean(indexes.map(index => labels[index])));
  }
  return total;
}

function evaluateProbabilities(rows, getter, options) {
  const value = statistic => bootstrapEstimate(rows, sample => statistic(sample.map(getter), sample.map(label)), options);
  return { auroc: value(auroc), ece: value((p, y) => calibrationError(p, y, 10)), brier: value((p, y) => mean(p.map((probability, index) => (probability - y[index]) ** 2))) };
}
function acceptedReport(rows, accepts, options) {
  const accepted = rows.filter(accepts);
  return { items: rows.length, accepted: accepted.length,
    coverage: bootstrapEstimate(rows, sample => sample.length ? sample.filter(accepts).length / sample.length : null, options),
    acceptedWrongRate: bootstrapEstimate(rows, sample => mean(sample.filter(accepts).map(label)), options),
    acceptedWrongCount: accepted.reduce((sum, row) => sum + label(row), 0),
    handoffRate: bootstrapEstimate(rows, sample => sample.length ? 1 - sample.filter(accepts).length / sample.length : null, options) };
}
export function evaluateCalibration(inputRows, classifier, { seed = 20261027, replicates = 400 } = {}) {
  if (inputRows.some(row => row.split !== 'test')) throw new Error('Held-out calibration reporting requires test rows only');
  if (inputRows.some(row => row.modelId && row.modelId !== classifier.modelId || row.localModelId && row.localModelId !== classifier.modelId)) throw new Error('Test results must use the calibrator local model');
  const devIds = new Set(classifier.training.devIds), devGroups = new Set(classifier.training.devGroups);
  if (inputRows.some(row => devIds.has(row.id) || devGroups.has(row.groupId ?? row.id))) throw new Error('Dev/test source-group or item leakage detected');
  const rows = inputRows.filter(row => label(row) !== null).map(row => ({ ...row, groupId: row.groupId ?? row.id }));
  const options = { seed, replicates }, predicted = row => predictWrongness(classifier, row, { category: categoryOf(row) });
  const baseline = row => 1 - clamp((row.features ?? row).confidence ?? (row.features ?? row).selfConfidence);
  const accepts = row => predicted(row) < classifier.threshold, baselineAccepts = row => baseline(row) <= .2;
  const multi = rows.filter(row => categoryOf(row) === 'company-data multi-doc');
  return { modelId: classifier.modelId, split: 'test', items: inputRows.length, scored: rows.length, labelCoverage: inputRows.length ? rows.length / inputRows.length : null,
    status: rows.length ? 'evaluated_held_out_test' : 'pending_labels', threshold: classifier.threshold, thresholdSource: classifier.thresholdPolicy.source,
    calibrated: evaluateProbabilities(rows, predicted, options), baseline: evaluateProbabilities(rows, baseline, options),
    routing: { calibrated: acceptedReport(rows, accepts, options), baseline: acceptedReport(rows, baselineAccepts, options) },
    multiDocument: { scored: multi.length, calibrated: acceptedReport(multi, accepts, options), baseline: acceptedReport(multi, baselineAccepts, options),
      predictedWrongness: bootstrapEstimate(multi, sample => mean(sample.map(predicted)), options),
      measuredWrongRate: bootstrapEstimate(multi, sample => mean(sample.map(label)), options),
      interpretation: 'Compare accepted wrong rate and local coverage together. Lower accepted error caused by escalating every multi-document item is abstention, not improved answer generation.' },
    method: { calibrationTarget: 'Probability that the local answer fails its deterministic reference/rubric', eceBins: 10, interval: 'seeded source-group bootstrap, test labels used for reporting only', seed, replicates },
  };
}
