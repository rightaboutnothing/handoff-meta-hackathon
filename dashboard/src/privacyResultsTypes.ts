export interface PrivacyMetric {
  n:number;
  events:number;
  rate:number|null;
  wilson95:[number,number]|null;
  errors:number;
}

export interface PrivacyAttribution {
  layerId:'tokenize_lost_intent'|'question_validation'|'prompt_guard'|'harmful_content'|'rewrite'|'other';
  label:string;
  firstBlocks:number|null;
  overlapping:PrivacyMetric|null;
}

export interface PrivacySetup {
  id:string;
  label:string;
  productionCandidate:boolean;
  pii:{frozen:PrivacyMetric|null;multicountry:PrivacyMetric|null};
  usable:{frozen:PrivacyMetric|null;multicountry:PrivacyMetric|null};
  attacks:PrivacyMetric|null;
  safe:PrivacyMetric|null;
  applications:{complete:PrivacyMetric|null;fullCredit:PrivacyMetric|null;mode:'local-surrogate'};
  gate:{status:'PASS'|'FAIL'|'PENDING';checks:{id:string;label:string;pass:boolean|null}[];reasons:string[]};
  errors:number|null;
  attribution:PrivacyAttribution[];
}

export interface PrivacyProgress {
  stage:'6b'|'6c'|'6d'|'6f';
  runId:string|null;
  timestamp:string|null;
  timestampAwst?:string|null;
  sourceHash:string|null;
  reportSha256:string|null;
  setups:{id:string;label:string;usableFrozen:PrivacyMetric|null;usableMulticountry:PrivacyMetric|null;safeOperational:PrivacyMetric|null;safeDetected:PrivacyMetric|null}[];
}

export interface PrivacyPromptGuard {
  variant:'86m'|'22m';
  threshold:number|null;
  attempted:number|null;
  available:number|null;
  errors:number|null;
  jailbreak:PrivacyMetric|null;
  injection:PrivacyMetric|null;
  safe:PrivacyMetric|null;
  latency:{n:number;medianMs:number|null;p95Ms:number|null}|null;
}

export interface PrivacyResultsReport {
  schemaVersion:1;
  kind:'privacy-results-dashboard';
  stage:'6f'|'6d'|'6c';
  runId:string;
  timestamp:string;
  timestampAwst:string;
  sourceHash:string;
  sourceCommit:string|null;
  reportSha256:string;
  seed:number|null;
  cloudCalls:0;
  spendUsd:0;
  liveDispatchEnabled:false;
  setups:PrivacySetup[];
  progress:PrivacyProgress[];
  promptGuard:PrivacyPromptGuard[];
  gaps:string[];
  notes:string[];
}

export type PrivacyPanel='headline'|'progress'|'attribution'|'prompt-guard'|'provenance';
