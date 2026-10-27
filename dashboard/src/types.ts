export type PairingId = "meta-meta" | "meta-grok" | "gemma-meta" | "gemma-grok";

export type CharacterKind = "llama" | "gemma" | "guard" | "spark";

export type CharacterState =
  | "idle"
  | "receive"
  | "think"
  | "confident"
  | "unsure"
  | "hand_off"
  | "answer"
  | "block"
  | "celebrate";

export interface CharacterAnimator {
  setState(name: CharacterState): void;
}

export type HandoffEventType =
  | "received"
  | "screened"
  | "thinking"
  | "confidence"
  | "decision"
  | "handed_off"
  | "answered"
  | "blocked";

export type HandoffActor = "local" | "guard" | "cloud" | "system";

export interface HandoffEvent {
  id: string;
  type: HandoffEventType;
  step: 1 | 2 | 3 | 4 | 5 | 6;
  at: number;
  caption: string;
  actor: HandoffActor;
  data?: {
    status?: "checking" | "safe" | "blocked";
    confidence?: number;
    reason?: string;
    route?: "local" | "cloud" | "blocked_local" | "deferred_cloud";
    answer?: string;
    latencyMs?: number;
    costUsd?: number;
    savedUsd?: number;
  };
}

export interface DemoScenario {
  id: "easy" | "hard" | "blocked" | "live";
  label: string;
  menuLabel: string;
  prompt: string;
  description: string;
  duration: number;
  events: HandoffEvent[];
}

export interface PairingMetric {
  id: PairingId;
  name: string;
  localModel: string;
  cloudModel: string;
  accuracy: number;
  handoffRate: number;
  medianLatencyMs: number;
  costUsd: number;
  estimatedCostSavedUsd: number;
  benchmarks: Record<string, number | null>;
}

export interface BenchmarkData {
  generatedFrom: string;
  generatedAt: string;
  seed: number;
  progress: { completed: number; total: number; deferred: number };
  trust: {
    harmfulCloudPrompts: number;
    verifiedFromRequestTrace: boolean;
    offlinePassMadeZeroMetaCalls: boolean;
    note: string;
    evidence: {
      schemaVersion: number;
      methodVersion: string;
      executionMode: string;
      scope: string;
      startedAt: string;
      endedAt: string;
      traceSha256: string;
      resultsSha256: string;
      traceEventsReviewed: number;
      completedItems: number;
      requestStarts: number;
      cloudRequests: number;
      cloudTasks: number;
      safeCloudRequests: number;
      unverifiedCloudRequests: number;
      harmfulCloudPrompts: number;
      strongRejectCloudRequests: number;
      metaRequests: number;
      blockedRequests: number;
      legacyResultsExcluded: boolean;
      verificationSource: "local-request-trace" | "committed-trace-summary";
    };
  };
  pairings: PairingMetric[];
}
