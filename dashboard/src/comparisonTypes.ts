export interface Estimate { estimate: number | null; ci95?: [number, number] | null; n?: number; total?: number; coverage?: number | null; groups?: number }
export type Measurement = Estimate | number | null | undefined;
export type ComparisonMetrics = Record<string, Measurement>;
export interface ComparisonPipeline {
  id: string; name: string; kind: string; localModelId?: string | null; parametersB?: number | null;
  guardModelId?: string | null; cloudId?: string | null; cloudName?: string | null; hero?: boolean;
  status: string; items?: number; completed?: number; deferred?: number; errors?: number;
  metrics: ComparisonMetrics;
  byCategory?: Record<string, { metrics?: ComparisonMetrics; status?: string; items?: number } | ComparisonMetrics>;
}
export interface CostPlan {
  pipelineId: string; name: string; sampleItems: number; plannedHandoffs: number;
  estimatedInputTokens: number; estimatedOutputTokens: number; estimatedReasoningTokens?: number;
  costPer1000Usd: number | null; cloudOnlyCostPer1000Usd: number | null;
  actualSpendUsd: number | null; assumptions: boolean;
  estimatedAllCloudInputTokens?: number | null; localAllocationIncluded?: number | null;
  expectedInputTokensPer1000?: number | null; expectedAllCloudInputTokensPer1000?: number | null;
  cloudOnlyReferenceCloudId?: string | null;
}
export interface CalibrationReport {
  modelId: string; status?: string; items?: number; scored?: number; threshold?: number;
  calibrated?: { auroc?: Measurement; ece?: Measurement; brier?: Measurement };
  baseline?: { auroc?: Measurement; ece?: Measurement };
  multiDocument?: { scored?: number; calibrated?: { acceptedWrongRate?: Measurement; coverage?: Measurement }; baseline?: { acceptedWrongRate?: Measurement; coverage?: Measurement } };
}
export interface ComparisonReport {
  schemaVersion: number; runId: string; timestamp?: string; tier: number; status: string; cloudCalls: number;
  provenance?: { gitCommit?: string | null };
  baseline?: { medianLatencyMs?: number; handoffRate?: number; label?: string; name?: string };
  pipelines: ComparisonPipeline[]; costPlan: CostPlan[]; calibration?: CalibrationReport[];
  environment?: Record<string, unknown>; selection?: Record<string, unknown>;
  categories?: string[]; notes?: string[]; pricing?: { currency?: string; label?: string; localAllocationUsdPerQuery?: number; expectedOutputTokens?: number; expectedReasoningTokens?: number; clouds?: Record<string, { modelId?: string; inputUsdPerMillion?: number; outputUsdPerMillion?: number }> };
  categoryWinners?: Record<string, { accuracy?: CategoryWinner; cost?: CategoryWinner; latency?: CategoryWinner; recommended?: { pipelineId?: string; score?: number | null } | null }>;
}
export interface CategoryWinner { pipelineIds?: string[]; estimate?: number | null; status?: string; note?: string }
export const valueOf = (metric: Measurement): number | null => {
  const value = typeof metric === 'object' && metric !== null ? metric.estimate : metric;
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
};
export const categoryMetrics = (pipeline: ComparisonPipeline, category: string): ComparisonMetrics => {
  if (category === 'overall') return pipeline.metrics;
  const entry = pipeline.byCategory?.[category];
  return entry && typeof entry === 'object' && 'metrics' in entry ? entry.metrics as ComparisonMetrics ?? {} : entry as ComparisonMetrics ?? {};
};
