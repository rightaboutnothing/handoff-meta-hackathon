import { sha256 } from '../rag/receipts.mjs';

export const INSTRUMENTATION_VERSION = 'comparison-paid-v2';
export const resultKey = row => `${row.pipelineId}|${row.id}`;
export function latestResults(rows) { return [...new Map(rows.map(row => [resultKey(row), row])).values()]; }
export function shouldResumeResult(row, { tier, metaEnabled = false, hasCloudReply = false } = {}) {
  if (!row) return true;
  if (tier === 0) return false;
  if (row.status === 'deferred_cloud') return row.cloudStatus === 'deferred_meta' && metaEnabled;
  return row.status === 'error' && hasCloudReply;
}
export function orderPipelines(pipelines, localModels) {
  const result = localModels.flatMap(model => pipelines.filter(pipeline => pipeline.localModelId === model.modelId));
  result.push(...pipelines.filter(pipeline => !pipeline.localModelId));
  if (new Set(result.map(pipeline => pipeline.id)).size !== pipelines.length) throw new Error('Pipeline order contains an unregistered local model or duplicate ID');
  return result;
}
export function stageIdentity({ stage, item, input, modelId, settings, sourceHash, corpusHash = null }) {
  return { version: INSTRUMENTATION_VERSION, stage, itemId: item?.id ?? null, promptHash: sha256(item?.prompt ?? ''), inputHash: sha256(input), modelId, settingsHash: sha256(settings), sourceHash, corpusHash };
}
export function checkedCache(record, identity) {
  if (!record || sha256(record.cacheIdentity) !== sha256(identity)) throw new Error('Cached model stage does not match frozen source, input, model or settings');
  if (record.modelId && record.modelId !== identity.modelId) throw new Error('Cached stage model ID changed');
  return record;
}
export function cumulativeCloudAccounting(rows) {
  // A result may be replaced during deferred/postprocessing resume. One request
  // ID is billed once; the durable budget remains authoritative for unknowns.
  const calls = new Map();
  for (const row of rows) {
    if (row.cloudStatus !== 'ok') continue;
    const id = row.cloudRequestId ?? row.receipt?.cloudRequestId ?? resultKey(row);
    if (!calls.has(id)) calls.set(id, row.metrics ?? {});
  }
  const totals = getter => { const values = [...calls.values()].map(getter), known = values.filter(value => typeof value === 'number' && Number.isFinite(value)); return { total: known.length === values.length ? known.reduce((a, b) => a + b, 0) : null, knownSubtotal: known.reduce((a, b) => a + b, 0), coverage: values.length ? known.length / values.length : 1 }; };
  return { successfulRequests: calls.size, providerReportedUsd: totals(value => value.cloudCostUnknown ? null : value.actualCloudSpendUsd), meteredUsd: totals(value => value.meteredCloudSpendUsd), tokensSent: totals(value => value.tokensSentToCloud) };
}
