// Every aggregation is within one pipeline. Different model sizes are never pooled.
export const mean = values => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
export function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), index = (sorted.length - 1) * fraction;
  return sorted[Math.floor(index)] + (sorted[Math.ceil(index)] - sorted[Math.floor(index)]) * (index % 1);
}
export function seededRandom(seed = 20261027) {
  let state = seed >>> 0;
  return () => { state += 0x6d2b79f5; let value = state; value = Math.imul(value ^ value >>> 15, value | 1); value ^= value + Math.imul(value ^ value >>> 7, value | 61); return ((value ^ value >>> 14) >>> 0) / 4294967296; };
}
const finite = value => typeof value === 'number' && Number.isFinite(value);
export function wilsonInterval(successes, count) {
  if (!count) return null;
  const z = 1.959963984540054, proportion = successes / count, denominator = 1 + z * z / count;
  const center = (proportion + z * z / (2 * count)) / denominator;
  const radius = z * Math.sqrt(proportion * (1 - proportion) / count + z * z / (4 * count * count)) / denominator;
  return [Math.max(0, center - radius), Math.min(1, center + radius)];
}

// Cluster resampling keeps related company/template/source items together.
// With one source group there is no defensible group-bootstrap interval.
export function bootstrapEstimate(rows, statistic, { seed = 20261027, replicates = 400, groupKey = row => row.groupId ?? row.id } = {}) {
  const estimate = statistic(rows);
  const groups = new Map();
  rows.forEach((row, index) => { const key = groupKey(row) ?? `row-${index}`; if (!groups.has(key)) groups.set(key, []); groups.get(key).push(row); });
  const clusters = [...groups.values()];
  if (!finite(estimate) || clusters.length < 2) return { estimate: finite(estimate) ? estimate : null, ci95: null, n: rows.length, groups: clusters.length, validReplicates: 0, method: 'group bootstrap unavailable: fewer than two independent groups or undefined statistic' };
  const random = seededRandom(seed), draws = [];
  for (let iteration = 0; iteration < replicates; iteration += 1) {
    const sample = [];
    for (let group = 0; group < clusters.length; group += 1) sample.push(...clusters[Math.floor(random() * clusters.length)]);
    const value = statistic(sample); if (finite(value)) draws.push(value);
  }
  return { estimate, ci95: draws.length >= Math.max(20, replicates / 4) ? [percentile(draws, .025), percentile(draws, .975)] : null, n: rows.length, groups: clusters.length, validReplicates: draws.length, method: 'seeded source-group bootstrap percentile 95% interval', seed, replicates };
}

const dataOf = row => row.result ?? row;
const metricsOf = row => dataOf(row).metrics ?? row.metrics ?? {};
const scoringOf = row => row.scoring ?? dataOf(row).scoring ?? {};
const statusOf = row => dataOf(row).status ?? row.status;
const routeOf = row => dataOf(row).route ?? row.route;
const groupRows = rows => rows.map((row, index) => ({ ...row, groupId: row.groupId ?? row.item?.groupId ?? row.id ?? `row-${index}` }));

function summarizeRows(inputRows, options) {
  const rows = groupRows(inputRows), total = rows.length;
  const measurement = (getter, statistic = mean, denominator = total) => {
    const measured = rows.map(row => ({ ...row, value: getter(row) })).filter(row => finite(row.value));
    return { ...bootstrapEstimate(measured, sample => statistic(sample.map(row => row.value)), options), total: denominator, coverage: denominator ? measured.length / denominator : null };
  };
  const ratio = getter => measurement(row => { const value = getter(row); return value == null ? null : Number(value); });
  const knownStatus = row => !['error', 'unavailable', 'pending'].includes(statusOf(row));
  const score = row => {
    if (['deferred_cloud', 'pending_cloud', 'deferred', 'error', 'unavailable', 'pending'].includes(statusOf(row)) || ['deferred_cloud', 'pending_cloud'].includes(routeOf(row))) return null;
    const scoring = scoringOf(row);
    return scoring.labelAvailable === false || scoring.scored === false ? null : scoring.score ?? scoring.accuracy ?? scoring.answerAccuracy ?? null;
  };
  const countMetric = key => measurement(row => metricsOf(row)[key] ?? row[key] ?? null, values => values.reduce((a, b) => a + b, 0));
  const per1000 = getter => measurement(getter, values => mean(values) * 1000);
  const guardValue = row => {
    const metrics = metricsOf(row); if (finite(metrics.guardLatencyMs)) return metrics.guardLatencyMs;
    const stages = metrics.stages ?? dataOf(row).steps;
    return Array.isArray(stages) ? stages.filter(stage => /guard/i.test(stage.stage)).reduce((sum, stage) => sum + (finite(stage.latencyMs) ? stage.latencyMs : 0), 0) : null;
  };
  const actualCost = row => {
    const metrics = metricsOf(row);
    if (metrics.cloudCostUnknown === true || metrics.cloudDeliveryUnknown === true) return null;
    return metrics.actualCloudSpendUsd ?? metrics.actualCostUsd ?? row.actualCloudSpendUsd ?? row.knownCloudCostUsd ?? null;
  };
  const meteredCost = row => metricsOf(row).meteredCloudSpendUsd ?? row.meteredCloudSpendUsd ?? null;
  const stats = {
    accuracy: measurement(score), factCoverage: measurement(row => score(row) == null ? null : scoringOf(row).factCoverage ?? scoringOf(row).answerAccuracy ?? null),
    citationPrecision: measurement(row => score(row) == null ? null : scoringOf(row).citationPrecision ?? scoringOf(row).citationAccuracy ?? null),
    localAnswerRate: ratio(row => knownStatus(row) ? routeOf(row) === 'local' && ['ok', 'completed', 'local_answer'].includes(statusOf(row)) : null),
    handoffRate: ratio(row => knownStatus(row) ? ['cloud', 'deferred_cloud', 'pending_cloud'].includes(routeOf(row)) || dataOf(row).handoff === true : null),
    medianLatencyMs: measurement(row => metricsOf(row).latencyMs ?? row.latencyMs ?? null, values => percentile(values, .5)),
    p95LatencyMs: measurement(row => metricsOf(row).latencyMs ?? row.latencyMs ?? null, values => percentile(values, .95)),
    guardLatencyMs: measurement(guardValue), tokensSent: countMetric('tokensSentToCloud'), actualCloudSpendUsd: measurement(actualCost, values => values.reduce((a, b) => a + b, 0)),
    actualCloudCostPer1000Usd: per1000(actualCost), meteredCloudSpendUsd: measurement(meteredCost, values => values.reduce((a, b) => a + b, 0)),
    meteredCostPer1000Usd: per1000(meteredCost), projectedCostPer1000Usd: per1000(row => metricsOf(row).projectedCostUsd ?? metricsOf(row).projectedHandoffCostUsd ?? row.projectedCloudCostUsd ?? null),
    piiRedacted: countMetric('piiItemsRedacted'), outboundBlocks: ratio(row => metricsOf(row).guardOutbound == null && row.guardOutbound == null ? null : (metricsOf(row).guardOutbound ?? row.guardOutbound) === 'unsafe'),
    inboundFlags: ratio(row => metricsOf(row).guardInbound == null && row.guardInbound == null ? null : (metricsOf(row).guardInbound ?? row.guardInbound) === 'unsafe'),
    falseRefusals: ratio(row => row.safety?.kind !== 'safe' && row.item?.safety?.kind !== 'safe' && row.expectedSafe !== true ? null : score(row) == null ? null : scoringOf(row).refused === true || routeOf(row) === 'blocked_local'),
    leaks: countMetric('leaks'), receiptsVerified: ratio(row => metricsOf(row).receiptIssued === false ? null : metricsOf(row).receiptVerified ?? row.receiptVerified ?? (dataOf(row).receipt ? false : null)),
  };
  const deferred = rows.filter(row => /deferred|pending_cloud/.test(statusOf(row) ?? '') || /deferred|pending_cloud/.test(routeOf(row) ?? '')).length;
  const errors = rows.filter(row => ['error', 'unavailable'].includes(statusOf(row))).length;
  return { items: total, completed: total - deferred - errors, deferred, errors, metrics: stats, status: deferred || errors ? 'INCOMPLETE' : total ? 'COMPLETE' : 'PENDING',
    confidenceIntervalScope: 'Within-pipeline source-group bootstrap. Small Tier 0 samples and synthetic/template groups limit precision; intervals are null when not estimable.' };
}

export function summarizePipeline(rows, { pipeline, seed = 20261027, replicates = 400, cloudOnlyCostPer1000Usd } = {}) {
  const ids = new Set(rows.map(row => row.pipelineId ?? row.pipeline?.id).filter(Boolean));
  if (ids.size > 1) throw new Error('Never pool different pipelines or model sizes in a summary');
  const models = new Set(rows.map(row => row.localModelId ?? row.localModel).filter(Boolean));
  if (models.size > 1) throw new Error('Never average different local model sizes together');
  const options = { seed, replicates }, overall = summarizeRows(rows, options);
  const byCategory = {};
  for (const category of [...new Set(rows.map(row => row.category ?? row.item?.category ?? 'unclassified'))].sort()) byCategory[category] = summarizeRows(rows.filter(row => (row.category ?? row.item?.category ?? 'unclassified') === category), options);
  const estimatedCost = overall.metrics.projectedCostPer1000Usd.estimate;
  return { pipelineId: pipeline?.id ?? [...ids][0] ?? null, pipeline: pipeline ?? null, ...overall, byCategory,
    savingVsCloudOnlyPer1000Usd: finite(cloudOnlyCostPer1000Usd) && finite(estimatedCost) ? cloudOnlyCostPer1000Usd - estimatedCost : null,
    cloudOnlyCostPer1000Usd: finite(cloudOnlyCostPer1000Usd) ? cloudOnlyCostPer1000Usd : null };
}

// References and weights must be recorded before Tier 1; no result-dependent tuning.
export function rankPipelineSummaries(summaries, policy) {
  const accuracyWeight = policy.weights?.accuracy ?? policy.accuracyWeight, costWeight = policy.weights?.cost ?? policy.costWeight, latencyWeight = policy.weights?.latency ?? policy.latencyWeight;
  const costReferenceUsd = policy.costScaleUsdPer1000 ?? policy.costReferenceUsd, latencyReferenceMs = policy.latencyScaleMs ?? policy.latencyReferenceMs;
  const minimumScoringCoverage = policy.minimumAccuracyCoverage ?? policy.minimumScoringCoverage ?? 1;
  const candidateKinds = policy.candidateKinds ?? ['hybrid'];
  if (![accuracyWeight, costWeight, latencyWeight, costReferenceUsd, latencyReferenceMs].every(finite) || costReferenceUsd <= 0 || latencyReferenceMs <= 0 || Math.abs(accuracyWeight + costWeight + latencyWeight - 1) > 1e-9 || Math.min(accuracyWeight, costWeight, latencyWeight) < 0) throw new Error('A valid pre-declared ranking policy is required');
  return summaries.map(summary => {
    const accuracy = summary.metrics.accuracy, latency = summary.metrics.medianLatencyMs.estimate;
    const actual = summary.metrics.actualCloudCostPer1000Usd, metered = summary.metrics.meteredCostPer1000Usd;
    const costSource = actual?.coverage === 1 && finite(actual.estimate) ? 'provider-reported actual USD' : metered?.coverage === 1 && finite(metered.estimate) ? 'usage-priced metered USD; configured pricing assumptions' : null;
    const cost = costSource?.startsWith('provider') ? actual.estimate : costSource ? metered.estimate : null;
    const kind = summary.pipeline?.kind ?? summary.kind;
    const eligible = summary.status === 'COMPLETE' && candidateKinds.includes(kind) && accuracy.coverage >= minimumScoringCoverage && [accuracy.estimate, cost, latency].every(finite);
    return { pipelineId: summary.pipelineId, eligible, costSource, costPer1000Usd: cost, score: eligible ? accuracyWeight * accuracy.estimate + costWeight * (1 - Math.min(cost / costReferenceUsd, 1)) + latencyWeight * (1 - Math.min(latency / latencyReferenceMs, 1)) : null,
      reason: eligible ? 'Complete measured results under pre-declared utility' : 'Pending: completed cloud/test coverage and measured cost are required' };
  }).sort((a, b) => (b.score ?? -Infinity) - (a.score ?? -Infinity) || String(a.pipelineId).localeCompare(String(b.pipelineId)));
}

export function categoryWinners(summaries, policy) {
  const categories = [...new Set(summaries.flatMap(summary => Object.keys(summary.byCategory ?? {})))].sort();
  return Object.fromEntries(categories.map(category => {
    const entries = summaries.map(summary => ({ ...summary.byCategory[category], pipelineId: summary.pipelineId, pipeline: summary.pipeline })).filter(value => value.items > 0);
    const complete = entries.filter(value => value.status === 'COMPLETE');
    const choose = (key, direction) => {
      const available = complete.filter(value => finite(value.metrics[key].estimate));
      if (!available.length) return { pipelineIds: [], estimate: null, status: 'pending' };
      const best = (direction === 'max' ? Math.max : Math.min)(...available.map(value => value.metrics[key].estimate));
      return { pipelineIds: available.filter(value => Math.abs(value.metrics[key].estimate - best) < 1e-12).map(value => value.pipelineId), estimate: best, status: 'measured', note: 'Point-estimate winners; overlapping 95% intervals do not establish a significant difference.' };
    };
    const costs = complete.map(value => ({ ...value, cost: rankPipelineSummaries([value], policy)[0] })).filter(value => finite(value.cost.costPer1000Usd));
    const minimum = costs.length ? Math.min(...costs.map(value => value.cost.costPer1000Usd)) : null;
    const cost = { pipelineIds: costs.filter(value => Math.abs(value.cost.costPer1000Usd - minimum) < 1e-12).map(value => value.pipelineId), estimate: minimum, status: minimum == null ? 'pending' : 'measured',
      sources: Object.fromEntries(costs.map(value => [value.pipelineId, value.cost.costSource])), note: 'Provider-reported actual USD where complete, otherwise usage-priced metered USD under configured pricing assumptions.' };
    return [category, { accuracy: choose('accuracy', 'max'), cost, latency: choose('medianLatencyMs', 'min'), recommended: rankPipelineSummaries(entries, policy).find(value => value.eligible) ?? null }];
  }));
}
