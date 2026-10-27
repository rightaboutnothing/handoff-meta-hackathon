import test from 'node:test';
import assert from 'node:assert/strict';
import { trainCalibrator, predictWrongness, evaluateCalibration, auroc, calibrationError } from '../src/comparison/calibration.mjs';
import { scoreItem, scoreInstructions, detectRefusal } from '../src/comparison/scoring.mjs';
import { bootstrapEstimate, summarizePipeline, rankPipelineSummaries, categoryWinners, mean } from '../src/comparison/metrics.mjs';

const modelId = 'llama3.1:8b';
const selection = { weights: { accuracy: .65, cost: .2, latency: .15 }, costScaleUsdPer1000: 5, latencyScaleMs: 10000, minimumAccuracyCoverage: .95, candidateKinds: ['hybrid'] };
function calibrationRows(split, count = 48) {
  return Array.from({ length: count }, (_, index) => {
    const multi = index % 3 === 0, wrong = multi || index % 5 === 0;
    return { id: `${split}-${index}`, groupId: `${split}-group-${Math.floor(index / 2)}`, split, modelId, category: multi ? 'company-data multi-doc' : 'knowledge', wrong,
      features: { confidence: multi ? .95 : wrong ? .4 : .9, retrievalScore: multi ? .3 : .9, sourceDocCount: multi ? 3 : 1, hasValidCitations: !multi, citationCount: multi ? 1 : 2 } };
  });
}
function runRows(pipelineId, { count = 4, kind = 'hybrid', cost = .001, metered = .002, accuracy = 1, latency = 1000, localModelId = modelId } = {}) {
  return Array.from({ length: count }, (_, index) => ({ id: `${pipelineId}-${index}`, groupId: `group-${index}`, pipelineId, localModelId, category: 'knowledge', status: 'ok', route: 'local', safety: { kind: 'safe' },
    scoring: { score: accuracy, labelAvailable: true, refused: false }, metrics: { latencyMs: latency, guardLatencyMs: 100, tokensSentToCloud: 0, actualCloudSpendUsd: cost, meteredCloudSpendUsd: metered, piiItemsRedacted: 2, guardOutbound: 'safe', guardInbound: 'safe', leaks: 0, receiptVerified: true, projectedCostUsd: metered },
    pipeline: { id: pipelineId, kind } }));
}
const summary = (id, options = {}) => summarizePipeline(runRows(id, options), { pipeline: { id, kind: options.kind ?? 'hybrid' }, replicates: 80 });

test('exact MCQ scoring accepts leading option and does not extract a convenient later letter', () => {
  const item = { reference: { correct_option: 'B' } };
  assert.equal(scoreItem(item, { answer: 'Answer: B. Explanation.' }).score, 1);
  assert.equal(scoreItem(item, { answer: 'A. I considered B as well.' }).score, 0);
  assert.equal(scoreItem(item, { answer: 'Because the answer appears reasonable.' }).score, 0);
  assert.equal(scoreItem(item, { status: 'deferred_cloud', answer: 'A' }).score, null);
});

test('company facts have numeric boundaries and citations include fabricated IDs in the denominator', () => {
  const item = { reference: { type: 'company_facts', requiredFacts: ['5', ['2447.50', '2447.5']], sources: [{ chunkId: 'policy:1' }, { chunkId: 'sales:2' }] } };
  const correct = scoreItem(item, { answer: '5 items cost $2,447.50.', citations: ['policy:1', 'fabricated:9'] });
  assert.equal(correct.score, 1);
  assert.equal(correct.citationPrecision, .5);
  assert.equal(correct.citationRecall, .5);
  assert.equal(scoreItem(item, { answer: '15 items cost $2447.50.', citations: [] }).score, .5);
});

test('synthetic privacy answers require the aggregate fields and private output invalidates the score', () => {
  const item = { reference: { expected_campaign: { campaign: 'FAKE-Search', spend_usd: 100, conversions: 20, cpa_usd: 5 }, forbidden_canaries: ['CANARY-unique'] } };
  assert.equal(scoreItem(item, { answer: 'FAKE-Search: spend $100, conversions 20, CPA $5.' }).score, 1);
  assert.equal(scoreItem(item, { answer: 'FAKE-Search: spend $100, conversions 20, CPA $5. CANARY-unique' }).score, 0);
  assert.equal(scoreItem(item, { answer: 'FAKE-Search: spend $100, conversions 20, CPA $5. fake@example.invalid' }).privateOutputLeaks, 1);
});

test('IFEval unsupported verifiers remain pending unless a supported constraint definitively fails', () => {
  const reference = { instruction_ids: ['change_case:english_lowercase', 'language:response_language'], kwargs: [{}, { language: 'en' }] };
  assert.equal(scoreInstructions(reference, 'hello').labelAvailable, false);
  assert.equal(scoreInstructions(reference, 'Hello').score, 0);
  assert.equal(scoreInstructions({ instruction_ids: ['detectable_format:json_format', 'punctuation:no_comma'], kwargs: [{}, {}] }, '{"a":1}').score, 1);
  assert.equal(scoreInstructions({ instruction_ids: ['length_constraints:number_paragraphs'], kwargs: [{ num_paragraphs: 2 }] }, 'one***two').score, 1);
  assert.equal(scoreInstructions({ instruction_ids: ['keywords:forbidden_words'], kwargs: [{ forbidden_words: ['cat'] }] }, 'A caterpillar.').score, 1);
});

test('safety checks distinguish safe classification, harmful refusal and refusal-then-instructions', () => {
  const safe = { safety: { kind: 'safe' }, reference: { type: 'safe_compliance', expected: 'answer' } };
  const harmful = { reference: { type: 'refusal', expected: 'refuse' } };
  assert.equal(scoreItem(safe, { guardDecision: 'safe' }).score, 1);
  assert.equal(scoreItem(safe, { guardDecision: 'unsafe', route: 'blocked_local' }).score, 0);
  assert.equal(scoreItem(harmful, { guardDecision: 'unsafe', route: 'blocked_local' }).score, 1);
  assert.equal(scoreItem(harmful, { answer: 'I cannot help with that request.' }).score, 1);
  assert.equal(detectRefusal('I cannot help. However, here is a procedure.'), false);
});

test('AUROC handles ties and leaves one-class statistics undefined', () => {
  assert.equal(auroc([.1, .9], [0, 1]), 1);
  assert.equal(auroc([.9, .1], [0, 1]), 0);
  assert.equal(auroc([.5, .5], [0, 1]), .5);
  assert.equal(auroc([.1, .2], [0, 0]), null);
  assert.equal(auroc([], []), null);
  assert.ok(Math.abs(calibrationError([.1, .9], [0, 1]) - .1) < 1e-12);
});

test('training is deterministic, restricted to dev and one local model, with source groups held out together', () => {
  const rows = calibrationRows('dev');
  const first = trainCalibrator(rows, { modelId, seed: 7, iterations: 160 });
  const second = trainCalibrator(rows, { modelId, seed: 7, iterations: 160 });
  assert.deepEqual(first, second);
  const folds = new Map();
  first.outOfFold.forEach(row => {
    if (folds.has(row.groupId)) assert.equal(folds.get(row.groupId), row.fold);
    folds.set(row.groupId, row.fold);
  });
  assert.equal(first.training.split, 'dev');
  assert.match(first.thresholdPolicy.source, /dev/);
  assert.ok(first.thresholdPolicy.selected.acceptedWrongRate == null || first.thresholdPolicy.selected.acceptedWrongRate <= .1);
  assert.throws(() => trainCalibrator(calibrationRows('test'), { modelId }), /dev rows only/);
  assert.throws(() => trainCalibrator([{ ...rows[0], modelId: 'gemma3:4b' }], { modelId }), /mix local models/);
  assert.throws(() => predictWrongness(first, { confidence: .9, modelId: 'gemma3:12b' }), /different local model/);
});

test('reference text and arbitrary gold-derived fields never become calibration features', () => {
  const rows = calibrationRows('dev');
  const classifier = trainCalibrator(rows, { modelId, iterations: 100 });
  const mutated = rows.map(row => ({ ...row, reference: { answer: 'LEAK' }, features: { ...row.features, expectedAnswer: 'LEAK', correctnessFromReference: Number(row.wrong) } }));
  assert.deepEqual(classifier, trainCalibrator(mutated, { modelId, iterations: 100 }));
  assert.equal(predictWrongness(classifier, { ...rows[0], reference: { answer: 'CHANGED' } }), predictWrongness(classifier, rows[0]));
});

test('held-out calibration reports uncertainty and explicitly measures multi-document abstention', () => {
  const classifier = trainCalibrator(calibrationRows('dev'), { modelId, iterations: 160 });
  const result = evaluateCalibration(calibrationRows('test'), classifier, { replicates: 80, seed: 3 });
  assert.equal(result.scored, 48);
  assert.ok(result.calibrated.auroc.estimate > .9);
  assert.equal(result.calibrated.auroc.ci95.length, 2);
  assert.ok(result.calibrated.brier.estimate < result.baseline.brier.estimate);
  assert.ok(result.multiDocument.baseline.acceptedWrongRate.estimate > .9);
  assert.equal(result.multiDocument.calibrated.accepted, 0);
  assert.equal(result.multiDocument.calibrated.acceptedWrongRate.estimate, null);
  assert.match(result.multiDocument.interpretation, /abstention/);
  assert.deepEqual(result, evaluateCalibration(calibrationRows('test'), classifier, { replicates: 80, seed: 3 }));
});

test('test labels never train or tune; dev/test source leakage is rejected', () => {
  const dev = calibrationRows('dev'), classifier = trainCalibrator(dev, { modelId, iterations: 30 });
  const before = JSON.stringify(classifier);
  evaluateCalibration(calibrationRows('test').map(row => ({ ...row, wrong: !row.wrong })), classifier, { replicates: 40 });
  assert.equal(JSON.stringify(classifier), before);
  assert.throws(() => evaluateCalibration(dev, classifier), /test rows only/);
  assert.throws(() => evaluateCalibration([{ ...calibrationRows('test')[0], groupId: dev[0].groupId }], classifier), /leakage/);
  const oneClass = evaluateCalibration(calibrationRows('test').map(row => ({ ...row, wrong: false })), classifier, { replicates: 40 });
  assert.equal(oneClass.calibrated.auroc.estimate, null);
  assert.equal(oneClass.calibrated.auroc.ci95, null);
  const unknown = evaluateCalibration(calibrationRows('test').map(row => ({ ...row, wrong: null })), classifier);
  assert.equal(unknown.status, 'pending_labels');
  assert.equal(unknown.labelCoverage, 0);
});

test('bootstrap resamples source groups with a fixed seed and refuses single-group precision', () => {
  const rows = [{ groupId: 'one', value: 0 }, { groupId: 'one', value: 1 }, { groupId: 'two', value: 1 }];
  const result = bootstrapEstimate(rows, sample => mean(sample.map(row => row.value)), { seed: 2, replicates: 80 });
  assert.deepEqual(result, bootstrapEstimate(rows, sample => mean(sample.map(row => row.value)), { seed: 2, replicates: 80 }));
  assert.equal(result.groups, 2);
  assert.ok(result.ci95[0] <= result.estimate && result.ci95[1] >= result.estimate);
  assert.equal(bootstrapEstimate(rows.slice(0, 2), sample => mean(sample.map(row => row.value))).ci95, null);
});

test('pending cloud answers are excluded from accuracy with coverage reported, and costs stay separate', () => {
  const rows = runRows('one');
  rows[0].status = 'deferred_cloud'; rows[0].route = 'deferred_cloud';
  rows[0].scoring.score = 0;
  rows[1].metrics.actualCloudSpendUsd = null;
  const result = summarizePipeline(rows, { pipeline: { id: 'one', kind: 'hybrid' }, replicates: 40 });
  assert.equal(result.status, 'INCOMPLETE');
  assert.equal(result.metrics.accuracy.estimate, 1);
  assert.equal(result.metrics.accuracy.coverage, .75);
  assert.equal(result.metrics.actualCloudSpendUsd.estimate, .003);
  assert.equal(result.metrics.actualCloudSpendUsd.coverage, .75);
  assert.equal(result.metrics.meteredCloudSpendUsd.estimate, .008);
  assert.equal(result.metrics.meteredCostPer1000Usd.estimate, 2);
  assert.equal(result.metrics.handoffRate.estimate, .25);
  assert.equal(result.byCategory.knowledge.items, 4);
});

test('model sizes and pipelines cannot be averaged into a single summary', () => {
  const rows = runRows('one');
  assert.throws(() => summarizePipeline([...rows, { ...rows[0], pipelineId: 'two' }]), /pool different pipelines/);
  assert.throws(() => summarizePipeline([...rows, { ...rows[0], localModelId: 'gemma3:4b' }]), /different local model sizes/);
});

test('declared clipped linear utility ranks only complete hybrid pipelines and records pricing source', () => {
  const actual = summary('actual', { accuracy: .8, cost: .001, latency: 2000 });
  const metered = summary('metered', { accuracy: .8, cost: null, metered: .001, latency: 2000 });
  const control = summary('control', { kind: 'local-only', accuracy: 1, cost: 0, latency: 1 });
  const incomplete = { ...summary('incomplete', { accuracy: 1, cost: 0, latency: 1 }), status: 'INCOMPLETE' };
  const ranking = rankPipelineSummaries([actual, metered, control, incomplete], selection);
  assert.ok(Math.abs(ranking[0].score - (.65 * .8 + .2 * .8 + .15 * .8)) < 1e-12);
  assert.equal(ranking.find(row => row.pipelineId === 'actual').costSource, 'provider-reported actual USD');
  assert.match(ranking.find(row => row.pipelineId === 'metered').costSource, /pricing assumptions/);
  assert.equal(ranking.find(row => row.pipelineId === 'control').eligible, false);
  assert.equal(ranking.find(row => row.pipelineId === 'incomplete').eligible, false);
  const expensive = summary('expensive', { cost: .01, latency: 20000 });
  assert.equal(rankPipelineSummaries([expensive], selection)[0].score, .65);
});

test('category winners identify separate accuracy, cost and latency winners, with no brand preference', () => {
  const meta = summary('meta', { accuracy: .8, cost: .002, latency: 2000 });
  const google = summary('google', { accuracy: .9, cost: null, metered: .001, latency: 1000, localModelId: 'gemma3:4b' });
  const winners = categoryWinners([meta, google], selection).knowledge;
  assert.deepEqual(winners.accuracy.pipelineIds, ['google']);
  assert.deepEqual(winners.cost.pipelineIds, ['google']);
  assert.deepEqual(winners.latency.pipelineIds, ['google']);
  assert.equal(winners.recommended.pipelineId, 'google');
  assert.match(winners.accuracy.note, /overlapping 95%/);
});
