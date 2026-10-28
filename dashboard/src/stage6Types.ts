export interface Stage6Metric {
  id: string; label: string; area: string;
  n: number; events: number; rate: number | null;
  wilson95: [number,number] | null; errors: number; definition?: string;
}
export interface Stage6Failure {id:string;category:string;hash?:string}
export interface Stage6ReadinessCheck {id:string;label:string;pass:boolean|null;detail?:string}
export interface Stage6Readiness {
  schemaVersion?:number;kind?: string;runId?:string;tier?:number;dryRun?:boolean;status?: string; preparedItems?: number; cloudCalls?: number; spendUsd?: number;
  checks: Stage6ReadinessCheck[];
  projectedCostUsd?: number | null; reservedUpperUsd?: number | null;
  tokens?: {input?:number;visibleOutput?:number;reasoning?:number;completion?:number;total?:number};
  reservedTokens?:{input?:number;completion?:number;total?:number};
  defaultCaps?:{calls?:number;tokens?:number;costUsd?:number};requiredCaps?:{calls?:number;tokens?:number;costUsd?:number};
  runFitsDefaultCaps?:boolean;defaultRoutingFlag?:boolean;maxCompletionTokens?:number;
  assumptions?: string[]; notes?:string[]; defaultKillSwitch?:boolean;
}
export interface Stage6GuardReport {
  schemaVersion:number; kind:'stage6-guard-stress-report'; runId:string;timestamp:string;
  tier:number;status?:string;dryRun?:boolean;localOnly?:boolean;
  cloudCalls:number;modelAnswerCalls:number;spendUsd:number;guardModelId:string;
  metrics:Stage6Metric[];trickBreakdown?:Stage6Metric[];categoryBreakdown?:Stage6Metric[];
  failuresByArea:Record<string,Stage6Failure[]>;
  summary?:Record<string,number|boolean|null>;
  readiness?:Stage6Readiness|null;
  notes?:string[];limitations?:string[];
  sources?:{id?:string;name?:string;url?:string;source?:string;licence?:string;license?:string;sha256?:string}[];
  provenance?:Record<string,unknown>;settings?:Record<string,unknown>;environment?:Record<string,unknown>;
}
