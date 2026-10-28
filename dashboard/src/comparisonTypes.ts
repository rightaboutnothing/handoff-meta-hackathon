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
  pipelineId: string; name: string; sampleItems?: number; plannedHandoffs?: number;
  estimatedInputTokens?: number; estimatedOutputTokens?: number; estimatedReasoningTokens?: number;
  costPer1000Usd: number | null; cloudOnlyCostPer1000Usd: number | null;
  actualSpendUsd: number | null; assumptions: boolean;
  estimatedAllCloudInputTokens?: number | null; localAllocationIncluded?: number | null;
  expectedInputTokensPer1000?: number | null; expectedAllCloudInputTokensPer1000?: number | null;
  cloudOnlyReferenceCloudId?: string | null;
  variant?: string; items?: number; eligibleItems?: number; handedOffItems?: number;
  cloudId?: string; localModelId?: string | null;
  allQueries?: CloudFeeScope; handedOffQueries?: CloudFeeScope;
  localAllocationPer1000Usd?: number | null; combinedCostPer1000AllQueriesUsd?: number | null;
  qualityPerDollar?: number | null; qualityPerDollarStatus?: string;
  actualCloudCalls?: number; actualCloudSpendUsd?: number | null;
  cloudTokensPerQuery?: number | null; cloudTokensPerHandoff?: number | null;
  tokenMethods?: string[]; serverFramingKnown?: boolean; outputLengthsAreProjected?: boolean;
}
export interface CloudFeeScope {
  items?: number; cloudInputTokensPerQuery?: Measurement; cloudTotalTokensPerQuery?: Measurement;
  projectedAnswerTokensPerQuery?: Measurement; projectedReasoningTokensPerQuery?: Measurement;
  cloudOnlyInputTokensPerQuery?: Measurement;
  costPer1000Usd?: Measurement; cloudOnlyCostPer1000Usd?: Measurement;
  savingPer1000Usd?: Measurement; savingRate?: Measurement;
  inputTokensBySource?: Record<string, { handoff?: Measurement; cloudOnly?: Measurement }>;
}
export interface TokenizerMetadata {
  cloudId?: string; modelId?: string; requestedModelId?: string; method?: string; description?: string;
  tokenizerModelId?: string; tokenizerId?: string; revision?: string; tokenizerRevision?: string;
  repository?: string; algorithmSource?: string; limitation?: string;
  proxy?: boolean; label?: string; note?: string; notes?: string[]; limitations?: string[];
  serverFramingKnown?: boolean;
}
export interface GradeModelSummary {
  items?: number; firstLabelled?: number; secondLabelled?: number; pairedLabelled?: number;
  firstScore?: Measurement; secondScore?: Measurement; exactScoreAgreement?: Measurement;
  fullCreditAgreement?: Measurement; fullCreditKappa?: Measurement; formatDisagreements?: number;
  disagreements?: { id?: string; category?: string; firstScore?: number | null; secondScore?: number | null; reason?: string }[];
}
export interface GradeCohort {
  items?: number; pairedModels?: number; models?: Record<string, GradeModelSummary>;
  baselineGap?: Measurement; secondMethodGap?: Measurement; gapChange?: Measurement; gapDefinition?: string;
}
export interface PromptFormatAblation {
  items?: number; requestedItems?: number; gapDefinition?: string;
  models?: Record<string,{ items?: number; requestedItems?: number; originalScore?: Measurement; plainScore?: Measurement; withinModelChange?: Measurement; originalEnvelopeValidRate?: Measurement }>;
  originalPromptGap?: Measurement; plainPromptGap?: Measurement; gapChange?: Measurement;
  originalBothEnvelopesValid?: {items?:number;originalPromptGap?:Measurement;plainPromptGap?:Measurement};
  limitations?: string[];
}
export interface CostAudit {
  version?: string; tokenizers?: Record<string, TokenizerMetadata>; neverRemoteCounting?: boolean; actualInferenceCalls?: number;
  legacyReconciliation?: {
    historicalCombinedCostPer1000Usd?: number; historicalCloudFeesPer1000Usd?: number;
    historicalLocalAllocationPer1000Usd?: number; historicalCloudOnlyPer1000Usd?: number;
    cloudFeeSavingPer1000Usd?: number; combinedPremiumPer1000Usd?: number; explanation?: string;
    sourceBreakdown?: Record<string, number>; sourceBreakdownCloudOnly?: Record<string, number>; scope?: string;
  };
  gemmaComparison?: { cloudId?: string; guardModelId?: string; variant?: string; same?: boolean; reason?: string; items?: number }[];
  gradingAudit?: { method?: string; seed?: number; random200?: GradeCohort; originalReportedSlice?: GradeCohort; promptFormatAblation?: PromptFormatAblation; limitations?: string[]; protections?: Record<string, boolean> };
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
  costPlanVariants?: CostPlan[]; costAudit?: CostAudit;
  environment?: Record<string, unknown>; selection?: Record<string, unknown>;
  categories?: string[]; notes?: string[]; pricing?: { currency?: string; label?: string; localAllocationUsdPerQuery?: number; expectedOutputTokens?: number; expectedReasoningTokens?: number; outputProjections?:Record<string,{answerTokens?:number;reasoningTokens?:number}>; clouds?: Record<string, { modelId?: string; inputUsdPerMillion?: number; outputUsdPerMillion?: number }> };
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
