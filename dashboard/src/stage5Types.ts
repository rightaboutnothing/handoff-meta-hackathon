export type Stage5Verdict = 'safe' | 'unsafe' | 'invalid' | 'unavailable' | 'blocked_local';
export interface Stage5GuardItem {
  id: string; suite: string; category: string; guardModelId: string;
  verdict: Stage5Verdict; safetyCategories: string[]; screened: boolean;
  wouldRelease: boolean; releaseStatus: 'would_release' | 'blocked_local';
  redactionsApplied: number; newRedactionsByType?: Record<string,number>;
  preexistingPlaceholderOccurrences: number; preexistingPlaceholdersByType?: Record<string,number>;
  privateFieldsExcluded: number; privateScalarValuesExcluded?: number; payloadHash?: string; sourcePayloadHash?: string; inputHash?: string;
  latencyMs: number | null; tokens?: {input:number;output:number;total:number}; attempts?: number;
  error?: string | null;
}
export interface Stage5GuardReport {
  schemaVersion: number; kind: 'stage5-guard-report'; runId: string; timestamp: string;
  sourceRun: string; sourceStage4Run: string; population: string;
  localModelId: string; guardModelId: string; dryRun: boolean; cloudCalls: number; spendUsd: number;
  inboundStatus: string; routingFlagDefault: boolean;
  summary: {
    items: number; screened: number; released: number; wouldRelease: number; blocked: number;
    unsafe: number; errors: number; redactionsApplied: number; preexistingPlaceholderOccurrences: number;
    redactedItems: number; alreadyRedactedItems: number; privateFieldsExcluded: number; privateScalarValuesExcluded?: number;
    companyDocuments: number; adExports: number; actualCloudCalls: number; actualBusinessCloudCalls: number;
  };
  items: Stage5GuardItem[];
  certification: {finiteDevUpperRisk: number | null; auditOnlyUpperRisk: number | null; scope?: string; futureCertified: boolean};
  notes?: string[]; provenance?: Record<string,unknown>; settings?: Record<string,unknown>; environment?: Record<string,unknown>;
}
