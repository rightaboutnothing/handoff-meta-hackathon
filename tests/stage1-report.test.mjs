import test from 'node:test';
import assert from 'node:assert/strict';
import { summarizeStage1, renderStage1Summary } from '../src/comparison/stage1-report.mjs';

const modelIds = ['llama3.1:8b', 'gemma3:4b', 'gemma3:12b'];
const audit = overrides => ({ hadInvalidIds: false, remainingInvalidCount: 0, repaired: [], rejectedIds: [], grounded: true, missingRequired: false, ...overrides });
const record = (id, phase, overrides = {}) => ({ id, phase, cohort: 'saved60', modelId: modelIds[0], groupId: id,
  scoring: { score: phase === 'before' ? 0 : 1, labelAvailable: true }, secondScore: { score: phase === 'before' ? 0 : 1, labelAvailable: true },
  answer: { parseValid: true, selfCheckParseValid: true, citationAudit: audit() }, company: true, safe: true, error: null,
  decision: { route: 'local' }, baselineSource: phase === 'before' ? 'saved_previous_run' : undefined,
  stages: [{ stage: 'answer', latencyMs: 10, tokens: { input: 10, output: 5 } }, ...(phase === 'after' ? [{ stage: 'self_check', latencyMs: 4, tokens: { input: 20, output: 3 } }] : [])], ...overrides });
const summarize = (records, overrides = {}) => summarizeStage1([{ id: 'saved60', itemIds: ['a', 'b'] }], records, { modelIds, thresholds: { [modelIds[0]]: .36, [modelIds[1]]: 0 }, seed: 7, replicates: 40, ...overrides });

test('stage 1 keeps cohorts and every model separate, with missing results visible', () => {
  const summary = summarize([record('a', 'before'), record('a', 'after'), record('b', 'before'), record('b', 'after')]);
  assert.equal(summary.rows.length, 3); const row = summary.rows[0];
  assert.equal(row.before.fullCredit, 0); assert.equal(row.after.fullCredit, 2); assert.equal(row.after.labelled, 2);
  assert.equal(row.paired.labelled, 2); assert.equal(row.paired.fullCreditChange.estimate, 1); assert.deepEqual(row.paired.fullCreditChange.ci95, [1, 1]);
  assert.equal(summary.rows[1].after.missing, 2); assert.equal(summary.rows[1].after.meanScore, null);
  assert.equal(summary.thresholds[modelIds[1]], 0); assert.equal(summary.thresholdsRetuned, false);
});
test('raw invalidity survives repair, rejection and loss of grounding', () => {
  const summary = summarize([record('a', 'after', { answer: { parseValid: true, selfCheckParseValid: true, citationAudit: audit({ hadInvalidIds: true, repaired: [{ from: 'bad', to: 'a' }] }) } }),
    record('b', 'after', { answer: { parseValid: true, selfCheckParseValid: false, citationAudit: audit({ hadInvalidIds: true, rejectedIds: ['unknown'], grounded: false, missingRequired: true }) } })]);
  const after = summary.rows[0].after;
  assert.equal(after.invalidCitationItems, 2); assert.equal(after.rawInvalidCitationRate, 1); assert.equal(after.repairedItems, 1); assert.equal(after.rejectedItems, 1);
  assert.equal(after.missingCitationItems, 1); assert.equal(after.residualInvalid, 0); assert.equal(after.selfCheckParseFailures, 1);
});
test('failures and unsupported labels are unscored, paired changes use the common intersection', () => {
  const summary = summarize([record('a', 'before'), record('a', 'after'), record('b', 'before', { scoring: { labelAvailable: false, score: null } }),
    record('b', 'after', { error: 'LOCAL_FAILED', scoring: { labelAvailable: true, score: 1 } })]);
  const row = summary.rows[0]; assert.equal(row.before.labelled, 1); assert.equal(row.after.labelled, 1); assert.equal(row.after.errors, 1); assert.equal(row.paired.labelled, 1);
  assert.equal(row.paired.fullCreditChange.estimate, 1); assert.equal(row.paired.fullCreditChange.ci95, null);
});
test('plain before parsing is inapplicable, and replayed baselines are labelled distinctly', () => {
  const cohorts = [{ id: 'plain50', itemIds: ['a'] }], rows = [record('a', 'before', { cohort: 'plain50', baselineSource: 'replayed_previous_method' }), record('a', 'after', { cohort: 'plain50' })];
  const summary = summarizeStage1(cohorts, rows, { modelIds: [modelIds[1]], seed: 7, replicates: 40 });
  // Explicit model filtering leaves unrelated rows pending rather than pooling them.
  assert.equal(summary.rows[0].before.items, 0);
  rows.forEach(row => { row.modelId = modelIds[1]; });
  const populated = summarizeStage1(cohorts, rows, { modelIds: [modelIds[1]], seed: 7, replicates: 40 });
  assert.equal(populated.rows[0].before.answerParseFailures, null); assert.equal(populated.rows[0].before.selfCheckParseFailures, null);
  const text = renderStage1Summary({ runId: 'unit', timestamp: 'now', tier: 0, cloudCalls: 0, spendUsd: 0, network: { externalRequests: 0 }, savedContextFrozen: true, summary: populated });
  assert.match(text, /Prior-method baselines replayed now/); assert.match(text, /gemma3:4b/); assert.match(text, /Stage 2 has not started/);
});
test('latency and tokens sum both local passes and exclude warm-up', () => {
  const row = record('a', 'after'); row.stages.unshift({ stage: 'warm-up', latencyMs: 999, tokens: { input: 999, output: 999 } });
  const after = summarize([row]).rows[0].after;
  assert.equal(after.medianLatencyMs, 14); assert.equal(after.inputTokens, 30); assert.equal(after.outputTokens, 8);
  assert.equal(after.stages.self_check.calls, 1); assert.equal(after.localAcceptedSafe, 1);
});
test('duplicate checkpoints do not inflate counts; incomplete citation measurement is explicit', () => {
  const old = record('a', 'after'), latest = record('a', 'after', { answer: { parseValid: true }, scoring: { score: .5, labelAvailable: true } });
  const row = summarize([old, latest]).rows[0]; assert.equal(row.duplicateRecords, 1); assert.equal(row.after.items, 1); assert.equal(row.after.meanScore, .5);
  assert.equal(row.after.citationEligible, 1); assert.equal(row.after.citationUnmeasured, 1); assert.equal(row.after.rawInvalidCitationRate, null);
});
test('publication refuses cloud work or a nonzero spend and validates fixed cohorts', () => {
  const summary = summarize([]), report = { runId: 'unit', timestamp: 'now', tier: 0, cloudCalls: 0, spendUsd: 0, network: { externalRequests: 0 }, summary };
  for (const override of [{ tier: 1 }, { cloudCalls: 1 }, { spendUsd: .01 }, { network: { externalRequests: 1 } }, { network: undefined }]) assert.throws(() => renderStage1Summary({ ...report, ...override }), /zero cloud/);
  assert.throws(() => summarizeStage1([{ id: 'saved60', itemIds: ['a', 'a'] }], [], { modelIds }), /unique fixed/);
  assert.throws(() => summarize([], { modelIds: [modelIds[0], modelIds[0]] }), /Distinct explicit/);
});
