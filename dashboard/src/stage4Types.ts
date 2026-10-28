export type Stage4Nullable = number | null;
export type Stage4Cloud = 'gemini' | 'muse-spark';
export type Stage4Tab = 'results' | 'costs' | 'privacy';
export interface Stage4Population { id: string; label: string; items: number; role?: string }
export interface Stage4Model { id: string; label: string; parametersB: number }
export interface Stage4Slice { id: string; label: string; parentId?: string | null; overlay?: boolean; definition?: string }
export interface Stage4Row {
  population: string; modelId: string; sliceId: string; items: number; safeItems: number;
  accepted: number; acceptedCorrect: number; acceptedUnknown?: number; acceptanceRate: Stage4Nullable;
  acceptedAccuracy: Stage4Nullable; acceptedAccuracyWilson95: [number, number] | null;
  escalations: number; escalationRate: Stage4Nullable; localOnly: number;
  medianLatencyMs: Stage4Nullable; medianAcceptedLatencyMs?: Stage4Nullable; latencyMeasured: number;
  errors?: number; exploratorySmallSlice?: boolean;
}
export interface Stage4Cost {
  population: string; modelId: string; sliceId: string; cloudId: Stage4Cloud;
  costPer1000: Stage4Nullable; cloudOnlyPer1000: Stage4Nullable;
  savingPer1000: Stage4Nullable; savingRate: Stage4Nullable;
  inputTokensPerQuery: Stage4Nullable; projectedTokensPerQuery: Stage4Nullable;
  handedOffQueries: number; actualCloudCalls: number; actualSpendUsd: number;
}
export interface Stage4WorkloadMix {
  population: string; modelId: string; companyShare: number; cloudId: Stage4Cloud;
  costPer1000: Stage4Nullable; cloudOnlyPer1000: Stage4Nullable;
  savingPer1000: Stage4Nullable; savingRate: Stage4Nullable;
  localAnswerRate?: Stage4Nullable; assumption?: boolean;
}
export interface Stage4Privacy {
  population: string; modelId: string; companyQueries: number; fullyLocalCompanyQueries: number;
  businessDataQueries: number; fullyLocalBusinessDataQueries: number; proposedBusinessHandoffs: number; actualBusinessCloudCalls: number; adPrivacyQueries: number;
  proposedBusinessPayloadsWithContext?: number; proposedBusinessPayloadsWithoutContext?: number;
  proposedCompanyHandoffs: number; actualCompanyCloudCalls: number; actualCloudCalls: number;
  guardScreenedHandoffs: Stage4Nullable; proposedPayloadsWithContext: number; draftPayloads: number;
  questionOnlyMeaning?: string; piiRedacted?: Stage4Nullable; piiItemsRedacted?: Stage4Nullable;
  rawPiiFindings?: Stage4Nullable; projectedCloudInputTokens?: Stage4Nullable; guardStatus?: string; privacyCheckScope?: string;
}
export interface Stage4Report {
  schemaVersion: number; runId: string; timestamp: string; sourceRun: string; primaryPopulation: string;
  modelIds: string[]; models: Stage4Model[]; populations: Stage4Population[]; slices: Stage4Slice[];
  rows: Stage4Row[]; costs: Stage4Cost[]; workloadMix: Stage4WorkloadMix[]; privacy: Stage4Privacy[];
  cloudCalls: number; spendUsd: number;
  recommendation: { modelId: string; label?: string; reason?: string; scope?: string; automaticProductionActivation?: boolean };
  certification: {
    modelId?: string; sliceId?: string; finiteDevUpperRisk: Stage4Nullable; auditOnlyUpperRisk: Stage4Nullable;
    finiteFrame?: number; acceptedCalib?: number; futureCertified: boolean;
    scope?: string; certifiedScope?: string; confidence?: number; errorBudget?: number;
  };
  summaryParagraph?: string; notes?: string[];
  sourcePolicyHash?: string;
  pricing?: { label?: string; assumption?: boolean; clouds?: Record<string, {modelId?: string; inputUsdPerMillion?: number; outputUsdPerMillion?: number}> };
  provenance?: { sourceCommit?: string; policyHash?: string; sourceReportHash?: string };
}

export const stage4CloudName = (cloud: Stage4Cloud) => cloud === 'muse-spark' ? 'Muse Spark' : 'Gemini';
export const stage4Interval = (interval: [number, number] | null | undefined) => interval ? `${(interval[0]*100).toFixed(1)}–${(interval[1]*100).toFixed(1)}%` : 'Pending';
