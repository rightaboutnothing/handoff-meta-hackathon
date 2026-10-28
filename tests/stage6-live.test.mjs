import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile,writeFile,mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {readLiveMuseConfig,buildMuseRequest,reserveMuseRequest,museCost,parseMuseResponse,readMuseUsage,createMuseRunBudget,isMuseKilled} from '../src/server/live-muse.mjs';
import {screenForCloud,assertCloudRelease,callMuse,assertMuseItem} from '../src/server/gateway-models.mjs';
import {createCloudPolicyRegistry} from '../src/comparison/policy.mjs';
import {sha256} from '../src/rag/receipts.mjs';
import {askRag} from '../src/rag/gateway.mjs';

const safe=async()=>({safe:true,classification:'safe',modelId:'synthetic-guard',tokens:{input:1,output:1,total:2}});
const input='Synthetic redacted policy question; content is never audited.';
const item={id:'synthetic-live-item',suite:'company-rag',category:'company-data single-doc',safety:{kind:'safe',cloudEligible:true},prompt:input};
const response=()=>({id:'synthetic-response',output_text:'OK',usage:{input_tokens:11,output_tokens:55,total_tokens:66,output_tokens_details:{reasoning_tokens:45}}});
async function directory(t){const folder=await mkdtemp(path.join(os.tmpdir(),'handoff-stage6-live-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('handoff-stage6-live-'));await rm(folder,{recursive:true,force:true});});return folder;}
async function config(){return{...await readLiveMuseConfig(),killSwitch:false};}
function access(t){for(const[key,value]of Object.entries({META_ACCESS_STATUS:'live',HANDOFF_META_ACCESS_CONFIRMED:'true',CLOUD_BUDGET_USD:'0.01'})){const previous=process.env[key];process.env[key]=value;t.after(()=>{if(previous===undefined)delete process.env[key];else process.env[key]=previous;});}}

test('live defaults are killed, tiny, reasoning inclusive and Responses uses max_output_tokens',async()=>{
  const defaults=await readLiveMuseConfig();assert.equal(defaults.killSwitch,true);assert.equal(defaults.maxCallsPerRun,1);assert.equal(defaults.maxTokensPerRun,4096);assert.equal(defaults.maxCostUsdPerRun,.01);assert.ok(defaults.maxCompletionTokens>=500);
  const body=buildMuseRequest(input,defaults);assert.equal(body.max_output_tokens,768);assert.equal(body.model,'muse-spark-1.3');assert.equal(body.input,input);assert.equal(body.reasoning.effort,'medium');assert.equal(Object.hasOwn(body,'max_completion_tokens'),false);
  assert.deepEqual(Object.keys(body).sort(),['input','max_output_tokens','model','reasoning']);
});

test('reasoning-heavy Responses parser reads output_text and empty text is a loud error with usage retained',()=>{
  const parsed=parseMuseResponse(response());assert.equal(parsed.text,'OK');assert.deepEqual(parsed.tokens,{input:11,output:55,completion:55,reasoning:45,visibleOutput:10,total:66});
  assert.throws(()=>parseMuseResponse({...response(),output_text:''}),error=>error.code==='LIVE_EMPTY_OUTPUT'&&error.tokens.reasoning===45);
  assert.throws(()=>parseMuseResponse({...response(),output_text:undefined}),/no output_text/);
  assert.throws(()=>readMuseUsage({...response(),usage:{input_tokens:1,output_tokens:2,total_tokens:3,output_tokens_details:{reasoning_tokens:4}}}),/inconsistent/);
});

test('a Guard pass expires, cannot be altered and cannot be reused',async t=>{
  let now=1000;t.mock.method(Date,'now',()=>now);
  const first=await screenForCloud(input,{guard:safe});now+=30001;assert.throws(()=>assertCloudRelease(input,first.releasePermit),/fresh unused Guard pass/);
  const next=await screenForCloud(input,{guard:safe});assert.throws(()=>assertCloudRelease(input+' changed',next.releasePermit),/Guard pass/);assert.equal(assertCloudRelease(input,next.releasePermit),true);assert.throws(()=>assertCloudRelease(input,next.releasePermit),/Guard pass/);
});

test('attack and PII-test metadata are structurally denied even with a safe classification and permissive metadata',async t=>{
  access(t);let calls=0;t.mock.method(globalThis,'fetch',async()=>{calls++;throw Error('No network');});
  for(const suite of ['guard-stress','jailbreak-benchmark','prompt-injection','pii-test','strongreject','poisoning']){
    const attack={...item,id:'synthetic-local-only',suite};const registry=createCloudPolicyRegistry([attack]);
    assert.throws(()=>assertMuseItem(attack,registry),/local-only|local-only, unregistered/);
    const screened=await screenForCloud(input,{guard:safe});await assert.rejects(callMuse(input,{offlineMeta:false,releasePermit:screened.releasePermit,item:attack,registry}),/local-only|local-only, unregistered/);
  }
  assert.equal(calls,0);
});

test('cloud client rejects missing or used Guard authorization before creating a client',async t=>{
  access(t);let calls=0;const client={responses:{create:async()=>{calls++;return response();}}},registry=createCloudPolicyRegistry([item]);
  await assert.rejects(callMuse(input,{offlineMeta:false,item,registry,dependencies:{client}}),/Guard pass/);
  const screened=await screenForCloud(input,{guard:safe});assertCloudRelease(input,screened.releasePermit);
  await assert.rejects(callMuse(input,{offlineMeta:false,item,registry,releasePermit:screened.releasePermit,dependencies:{client}}),/Guard pass/);assert.equal(calls,0);
});

test('attack source provenance and flags are immutable in the trusted cloud registry',()=>{
  for(const metadata of [{sourceKind:'jailbreak'},{attack:true},{attackSet:true},{piiTest:true}]){
    const attack={...item,...metadata},registry=createCloudPolicyRegistry([attack]);
    assert.throws(()=>assertMuseItem(attack,registry),/local-only/);
    Object.assign(attack,{sourceKind:'company-document',attack:false,attackSet:false,piiTest:false});
    assert.throws(()=>assertMuseItem(attack,registry),/local-only/);
  }
  const safeItem={...item,sourceKind:'company-document'},registry=createCloudPolicyRegistry([safeItem]);safeItem.sourceKind='other-document';assert.throws(()=>assertMuseItem(safeItem,registry),/local-only/);
});

test('both routing flags keep trusted sourceKind/attack/piiTest cases local before a permissive Guard or cloud client',async t=>{
  access(t);const chunk={chunkId:'synthetic-company-source',file:'synthetic-company.md',text:'The synthetic company warranty lasts 24 months.',score:.95,hash:sha256('The synthetic company warranty lasts 24 months.')};
  for(const lockedCompanyRouting of [false,true])for(const metadata of [{sourceKind:'jailbreak'},{attack:true},{attackSet:true},{piiTest:true}]){
    let guardCalls=0,cloudCalls=0;const result=await askRag('Analyse our synthetic company warranty.',{dataDir:await directory(t),lockedCompanyRouting,offlineMeta:false,task:{...item,...metadata},dependencies:{
      countTokens:text=>Buffer.byteLength(text,'utf8'),retrieve:async()=>({chunks:[chunk],quality:.95,bestMatchScore:.95,latencyMs:1,embeddingModel:'synthetic-embedding',completeness:{score:1,requiredSources:[chunk.file],missingFacets:[]}}),calculateLocal:async()=>({status:'not_applicable'}),
      localChat:async(_model,_messages,options)=>({modelId:'synthetic-local',latencyMs:1,tokens:{input:5,output:5,total:10},settings:{maxTokens:options.maxTokens},doneReason:'stop',text:JSON.stringify(options.schema?.properties?.confidence?{confidence:0,evidenceSupported:false,answerComplete:false,issues:['incomplete_answer']}:{claims:[{text:'The synthetic company warranty lasts 24 months.',citations:[chunk.chunkId]}]})}),
      guardText:async()=>{guardCalls++;return safe();},callMuse:async()=>{cloudCalls++;throw Error('The cloud dependency must be unreachable');},
    }});assert.notEqual(result.route,'cloud');assert.equal(guardCalls,0);assert.equal(cloudCalls,0);assert.equal(result.receipt,undefined);assert.equal(result.metrics.tokensSentToCloud,0);
  }
});

test('all three kill-switch mechanisms stop a run',async t=>{
  const dataDir=await directory(t),settings=await config();assert.equal(await isMuseKilled({...settings,killSwitch:true},{dataDir,environment:{}}),true);assert.equal(await isMuseKilled(settings,{dataDir,environment:{HANDOFF_CLOUD_KILL_SWITCH:'true'}}),true);assert.equal(await isMuseKilled(settings,{dataDir,environment:{}}),false);
  await writeFile(path.join(dataDir,'KILL_CLOUD'),'stop');assert.equal(await isMuseKilled(settings,{dataDir,environment:{}}),true);
  const budget=await createMuseRunBudget({runId:'killed',dataDir,config:settings,environment:{CLOUD_BUDGET_USD:'1'}});await assert.rejects(budget.reserve({itemId:item.id,inputHash:sha256(input),reservation:reserveMuseRequest(input,settings)}),{code:'LIVE_KILL_SWITCH'});
});

test('reservations include the whole reasoning-plus-answer cap and prevent token overspend',async t=>{
  const dataDir=await directory(t),settings={...await config(),maxCompletionTokens:500,maxTokensPerRun:760};
  const budget=await createMuseRunBudget({runId:'token-cap',dataDir,config:settings,environment:{CLOUD_BUDGET_USD:'1'}}),reservation=reserveMuseRequest(input,settings);
  assert.equal(reservation.completion,500);assert.equal(reservation.total,reservation.input+500);assert.ok(reservation.total>760);
  await assert.rejects(budget.reserve({itemId:item.id,inputHash:sha256(input),reservation}),{code:'LIVE_SPEND_CAP'});assert.equal((await budget.snapshot()).calls,0);
});

test('reasoning usage is charged once, persisted, and audit logs contain no content',async t=>{
  const dataDir=await directory(t),settings=await config(),budget=await createMuseRunBudget({runId:'usage',dataDir,config:settings,environment:{CLOUD_BUDGET_USD:'1'}}),reservation=reserveMuseRequest(input,settings),ticket=await budget.reserve({itemId:item.id,inputHash:sha256(input),reservation});
  const tokens=readMuseUsage(response()),settled=await budget.settle(ticket,{tokens});assert.equal(settled.costUsd,museCost({input:11,completion:55},settings));
  const saved=await budget.snapshot();assert.equal(saved.calls,1);assert.equal(saved.tokens,66);assert.equal(saved.costUsd,.000352);
  const audit=await readFile(path.join(dataDir,'cloud-runs/usage/audit.jsonl'),'utf8');assert.equal(audit.includes(input),false);const rows=audit.trim().split('\n').map(JSON.parse);assert.equal(rows[1].reasoningTokens,45);assert.equal(rows[1].completionTokens,55);assert.equal(rows[1].promptTokens,11);assert.ok(rows.every(row=>row.itemId===item.id&&row.payloadHash===sha256(input)&&row.guardVerdict==='safe'));
  await assert.rejects(budget.reserve({itemId:item.id,inputHash:sha256(input),reservation}),{code:'LIVE_SPEND_CAP'});
});

test('a crash leaves the full reservation in a resumed run and prevents further dispatch',async t=>{
  const dataDir=await directory(t),settings=await config(),options={runId:'resume',dataDir,config:settings,environment:{CLOUD_BUDGET_USD:'1'}},first=await createMuseRunBudget(options),reservation=reserveMuseRequest(input,settings);
  await first.reserve({itemId:item.id,inputHash:sha256(input),reservation});const resumed=await createMuseRunBudget(options);assert.equal((await resumed.snapshot()).tokens,reservation.total);await assert.rejects(resumed.reserve({itemId:item.id,inputHash:sha256(input),reservation}),{code:'LIVE_SPEND_CAP'});
  const changed=await createMuseRunBudget({...options,config:{...settings,maxCallsPerRun:2}});await assert.rejects(changed.snapshot(),{code:'LIVE_LEDGER_CHANGED'});
});

test('real adapter uses the Responses body, settles reasoning usage and audits without content under a mock client',async t=>{
  access(t);const dataDir=await directory(t),settings=await config(),configFile=path.join(dataDir,'live.json');await writeFile(configFile,JSON.stringify(settings));let calls=0;
  const client={responses:{create:async body=>{calls++;assert.equal(body.max_output_tokens,768);assert.equal(body.input,input);return response();}}},registry=createCloudPolicyRegistry([item]),screened=await screenForCloud(input,{guard:safe});
  const result=await callMuse(input,{offlineMeta:false,item,registry,liveRunId:'mock-live',dataDir,releasePermit:screened.releasePermit,dependencies:{client,configFile}});assert.equal(calls,1);assert.equal(result.text,'OK');assert.equal(result.tokens.reasoning,45);assert.equal(result.tokens.completion,55);
  const audit=await readFile(path.join(dataDir,'cloud-runs/mock-live/audit.jsonl'),'utf8');assert.equal(audit.includes(input),false);assert.equal(audit.includes('output_text'),false);assert.match(audit,/"reasoningTokens":45/);
});

test('an empty reasoning-heavy result fails loudly after settlement and an unknown result retains reservations',async t=>{
  access(t);const dataDir=await directory(t),settings=await config(),configFile=path.join(dataDir,'live.json');await writeFile(configFile,JSON.stringify(settings));const registry=createCloudPolicyRegistry([item]);
  for(const [runId,reply,code]of [['empty',{...response(),output_text:''},'LIVE_EMPTY_OUTPUT'],['missing',{output_text:'OK'},'LIVE_USAGE_INVALID']]){
    const screened=await screenForCloud(input,{guard:safe});await assert.rejects(callMuse(input,{offlineMeta:false,item,registry,liveRunId:runId,dataDir,releasePermit:screened.releasePermit,dependencies:{configFile,client:{responses:{create:async()=>reply}}}}),{code});
    const state=JSON.parse(await readFile(path.join(dataDir,'cloud-runs',runId,'state.json'),'utf8'));assert.equal(state.calls,1);assert.equal(state.tokens,runId==='empty'?66:reserveMuseRequest(input,settings).total);assert.equal(state.halted,runId!=='empty');
  }
});

test('missing budget authorization and tiny dollar caps fail before dispatch',async t=>{
  const dataDir=await directory(t),settings=await config();await assert.rejects(createMuseRunBudget({runId:'no-budget',dataDir,config:settings,environment:{}}),{code:'LIVE_BUDGET_UNSET'});
  const budget=await createMuseRunBudget({runId:'dollars',dataDir,config:{...settings,maxCostUsdPerRun:.000001},environment:{CLOUD_BUDGET_USD:'1'}});await assert.rejects(budget.reserve({itemId:item.id,inputHash:sha256(input),reservation:reserveMuseRequest(input,settings)}),{code:'LIVE_SPEND_CAP'});
});

test('a live call without a stable operator run ID fails closed before the client runs',async t=>{
  access(t);const prior=process.env.HANDOFF_LIVE_RUN_ID;delete process.env.HANDOFF_LIVE_RUN_ID;t.after(()=>{if(prior===undefined)delete process.env.HANDOFF_LIVE_RUN_ID;else process.env.HANDOFF_LIVE_RUN_ID=prior;});
  const dataDir=await directory(t),settings=await config(),configFile=path.join(dataDir,'live.json');await writeFile(configFile,JSON.stringify(settings));let calls=0;const screened=await screenForCloud(input,{guard:safe}),registry=createCloudPolicyRegistry([item]);
  await assert.rejects(callMuse(input,{offlineMeta:false,item,registry,dataDir,releasePermit:screened.releasePermit,dependencies:{configFile,client:{responses:{create:async()=>{calls++;return response();}}}}}),{code:'LIVE_RUN_ID_REQUIRED'});assert.equal(calls,0);
});

test('two Ask traces share the operator run ledger and the one-call cap blocks the second client invocation',async t=>{
  access(t);const prior=process.env.HANDOFF_LIVE_RUN_ID;process.env.HANDOFF_LIVE_RUN_ID='shared-operator-run';t.after(()=>{if(prior===undefined)delete process.env.HANDOFF_LIVE_RUN_ID;else process.env.HANDOFF_LIVE_RUN_ID=prior;});
  const dataDir=await directory(t),settings=await config(),configFile=path.join(dataDir,'live.json');await writeFile(configFile,JSON.stringify(settings));let calls=0;
  const client={responses:{create:async()=>{calls++;return{...response(),output_text:JSON.stringify({answer:'The synthetic answer is available.',confidence:.9,citations:[]})};}}};
  const dependencies={countTokens:text=>Buffer.byteLength(text,'utf8'),retrieve:async()=>({chunks:[],quality:0,bestMatchScore:0,latencyMs:1,embeddingModel:'synthetic-embedding',completeness:{score:0,requiredSources:[],missingFacets:[]}}),guardText:safe,callMuse:(wire,options)=>callMuse(wire,{...options,dependencies:{configFile,client}})};
  const first=await askRag('Explain binary search.',{dataDir,lockedCompanyRouting:true,offlineMeta:false,dependencies});
  const second=await askRag('Explain a hash table.',{dataDir,lockedCompanyRouting:true,offlineMeta:false,dependencies});
  assert.notEqual(first.runId,second.runId);assert.notEqual(first.runId,'shared-operator-run');assert.equal(first.route,'cloud');assert.equal(second.route,'deferred_cloud');assert.equal(second.metrics.cloudFailureCode,'LIVE_SPEND_CAP');assert.equal(calls,1);
  const state=JSON.parse(await readFile(path.join(dataDir,'cloud-runs/shared-operator-run/state.json'),'utf8'));assert.equal(state.calls,1);
  const audit=(await readFile(path.join(dataDir,'cloud-runs/shared-operator-run/audit.jsonl'),'utf8')).trim().split('\n').map(JSON.parse);assert.ok(audit.every(row=>row.runId==='shared-operator-run'));assert.equal(audit.at(-1).code,'LIVE_SPEND_CAP');
});
