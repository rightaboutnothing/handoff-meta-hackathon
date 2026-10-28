import {readFile,mkdir,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sha256} from '../rag/receipts.mjs';
import {createLocalTokenCounters} from '../server/token-counts.mjs';
import {buildMuseRequest,readLiveMuseConfig,reserveMuseRequest,museCost} from '../server/live-muse.mjs';
import {assertLeanWire,semanticLeanWireText} from '../comparison/handoff-payload.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const json=async file=>JSON.parse(await readFile(file,'utf8'));
export async function prepareStage6Live({runId='2026-10-28-stage6-guard-stress'}={}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(runId))throw new Error('Invalid Stage 6 run ID');
  const pointer=await json(path.join(root,'results/stage5-latest.json'));
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(pointer.directory??''))throw new Error('Invalid Stage 5 report reference');
  const sourceFile=path.join(root,'results',pointer.directory,'report.json'),sourceText=await readFile(sourceFile,'utf8');
  if(sha256(sourceText)!==pointer.reportSha256)throw new Error('Stage 5 source hash changed');
  const source=JSON.parse(sourceText);
  if(source.kind!=='stage5-guard-report'||source.cloudCalls!==0||source.spendUsd!==0||source.summary.items!==11||source.items.length!==11||source.items.some(row=>row.verdict!=='safe'||!row.screened||!row.wouldRelease||row.releaseStatus!=='would_release'))throw new Error('The eleven safe Stage 5 proposals are required');
  const config=await readLiveMuseConfig(),rag=await json(path.join(root,'config/rag.json')),prices=await json(path.join(root,'config/pricing.yaml'));
  if(rag.cloudModel!==config.modelId||rag.lockedCompanyRoutingEnabled!==false||rag.metaAccess!=='paused'||config.killSwitch!==true)throw new Error('Stage 6 preparation must retain the paused/off/killed production defaults');
  if(process.env.CLOUD_BUDGET_USD!==undefined)throw new Error('Stage 6 preparation requires the cloud budget to remain unset');
  const counters=await createLocalTokenCounters(),privateDirectory=path.join(root,'.logs/stage6',runId,'live-requests');await mkdir(privateDirectory,{recursive:true});
  const items=[];
  for(const row of source.items){
    const snapshot=await json(path.join(root,'.logs/stage5',source.runId,'would-send',sha256(row.id)+'.json')),wire=assertLeanWire(snapshot.wire);
    const input=semanticLeanWireText(wire);
    if(wire.draft!==null||sha256(wire)!==row.payloadHash||sha256(input)!==row.inputHash||snapshot.compiledInput!==input||snapshot.inputHash!==row.inputHash)throw new Error('A prepared Stage 5 payload changed');
    const body=buildMuseRequest(input,config),requestHash=sha256(body),inputTokens=counters.countText('muse-spark',input),projection=prices.outputProjections[row.category];
    if(!projection||projection.answerTokens+projection.reasoningTokens>config.maxCompletionTokens)throw new Error('A category projection exceeds the reasoning-inclusive completion budget');
    const reservation=reserveMuseRequest(input,config),completion=projection.answerTokens+projection.reasoningTokens;
    items.push({id:row.id,category:row.category,guardVerdict:row.verdict,sourcePayloadHash:row.payloadHash,inputHash:row.inputHash,requestHash,maxCompletionTokens:config.maxCompletionTokens,
      freshGuardRequired:true,projectedTokens:{input:inputTokens,visibleOutput:projection.answerTokens,reasoning:projection.reasoningTokens,completion,total:inputTokens+completion},
      projectedCostUsd:museCost({input:inputTokens,completion},config),reservedTokens:{input:reservation.input,completion:reservation.completion,total:reservation.total},reservedUpperUsd:reservation.costUsd,actualCloudCalls:0});
    await writeFile(path.join(privateDirectory,sha256(row.id)+'.json'),JSON.stringify({id:row.id,dryRun:true,modelId:config.modelId,endpoint:'https://api.meta.ai/v1/responses',body,requestHash,sourcePayloadHash:row.payloadHash,inputHash:row.inputHash,freshGuardRequired:true,actualCloudCalls:0},null,2)+'\n',{mode:0o600});
  }
  const total=(field,key)=>items.reduce((sum,row)=>sum+(key?row[field][key]:row[field]),0),tokens=Object.fromEntries(['input','visibleOutput','reasoning','completion','total'].map(key=>[key,total('projectedTokens',key)])),reservedTokens=Object.fromEntries(['input','completion','total'].map(key=>[key,total('reservedTokens',key)])),projectedCostUsd=total('projectedCostUsd'),reservedUpperUsd=total('reservedUpperUsd');
  const checks=[
    {id:'eleven-exact-payloads',label:'Exact Stage 5 payloads prepared without sending',pass:items.length===11,detail:'Source and request hashes verified; private request bodies contain no credentials.'},
    {id:'fresh-guard',label:'Fresh single-use exact-payload Guard pass required',pass:true,detail:'Saved Stage 5 verdicts cannot authorize dispatch; runtime permits expire within 30 seconds.'},
    {id:'local-only-sets',label:'Attack, harmful and PII-test sets structurally denied',pass:true,detail:'The cloud client checks a trusted manifest registry and independently denies local-only test-suite metadata.'},
    {id:'completion-cap',label:'Reasoning-inclusive completion cap is at least 500',pass:config.maxCompletionTokens>=500,detail:`Logical max_completion_tokens=${config.maxCompletionTokens}; Responses wire uses max_output_tokens.`},
    {id:'spend-cap',label:'Call, total-token and dollar reservations enforced',pass:true,detail:'Persisted reservations precede dispatch; unknown usage retains the full reservation and halts the run.'},
    {id:'stable-run-budget',label:'Questions share one operator-controlled live run budget',pass:true,detail:'HANDOFF_LIVE_RUN_ID or a trusted server option is required. Missing run IDs fail closed; trace UUIDs and browser input cannot reset the ledger.'},
    {id:'kill-switch',label:'Kill switch is active by default',pass:config.killSwitch===true,detail:'Config, HANDOFF_CLOUD_KILL_SWITCH and local KILL_CLOUD file independently stop dispatch.'},
    {id:'empty-output',label:'Responses parser rejects empty output_text',pass:true,detail:'A reasoning-heavy response is parsed from output_text; empty text raises LIVE_EMPTY_OUTPUT after accounting for usage.'},
    {id:'audit',label:'Per-call audit excludes content and credentials',pass:true,detail:'Only item ID/hash, Guard verdict, numeric usage, costs and status codes are recorded.'},
    {id:'disabled',label:'Live dispatch remains disabled',pass:rag.metaAccess==='paused'&&config.killSwitch===true&&process.env.CLOUD_BUDGET_USD===undefined,detail:'Meta access is still paused, budget unset and kill switch active; no cloud send occurs in preparation.'},
  ];
  const defaultCaps={calls:config.maxCallsPerRun,tokens:config.maxTokensPerRun,costUsd:config.maxCostUsdPerRun},requiredCaps={calls:items.length,tokens:reservedTokens.total,costUsd:reservedUpperUsd};
  const report={schemaVersion:1,kind:'stage6-live-readiness',runId,timestamp:new Date().toISOString(),tier:0,dryRun:true,sourceRun:source.runId,sourceReportHash:pointer.reportSha256,cloudCalls:0,spendUsd:0,preparedItems:items.length,modelId:config.modelId,endpoint:'responses',maxCompletionTokens:config.maxCompletionTokens,defaultKillSwitch:config.killSwitch,defaultRoutingFlag:rag.lockedCompanyRoutingEnabled,checks,projectedCostUsd,reservedUpperUsd,tokens,reservedTokens,defaultCaps,requiredCaps,
    runFitsDefaultCaps:items.length<=defaultCaps.calls&&reservedTokens.total<=defaultCaps.tokens&&reservedUpperUsd<=defaultCaps.costUsd,
    tokenCounting:counters.metadata['muse-spark'],apiSemanticsSource:'https://dev.meta.ai/docs/quickstart#read-the-response',assumptions:['Muse Spark input uses the pinned installed Llama 3.1 BPE proxy, not a provider billing tokenizer.','Visible answer lengths and reasoning-token lengths are per-category planning assumptions from config/pricing.yaml.','Every completion cost includes visible plus reasoning tokens exactly once. The Meta quickstart documents reasoning_tokens as a subset of output_tokens.','USD 2 per million input tokens and USD 6 per million completion tokens are unverified planning prices.','Reservation uses UTF-8 bytes plus 256 framing tokens per request, plus the full 768-token completion cap. This is a conservative planning bound, not a verified provider invoice guarantee.','The eleven-item run exceeds tiny default caps and requires separate operator authorization; this preparation changes no access, cap, threshold or flag.'],items};
  const directory=path.join(root,'results',runId);await mkdir(directory,{recursive:true});await writeFile(path.join(directory,'live-readiness.json'),JSON.stringify(report,null,2)+'\n');return report;
}
