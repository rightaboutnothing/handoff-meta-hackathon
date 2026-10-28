import {readFile,mkdir,open,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {randomUUID} from 'node:crypto';
import {acquireRunLock} from '../comparison/run-lock.mjs';
import {sha256} from '../rag/receipts.mjs';

const defaultConfig=fileURLToPath(new URL('../../config/live-muse.json',import.meta.url));
const fail=(code,message)=>Object.assign(new Error(message),{code});
const nonnegative=value=>Number.isFinite(value)&&value>=0;
const positiveInteger=value=>Number.isSafeInteger(value)&&value>0;
export async function readLiveMuseConfig(file=defaultConfig){
  const config=JSON.parse(await readFile(file,'utf8'));
  if(config.schemaVersion!==1||config.modelId!=='muse-spark-1.3'||config.endpoint!=='responses'||typeof config.killSwitch!=='boolean'||!positiveInteger(config.maxCompletionTokens)||config.maxCompletionTokens<500||!positiveInteger(config.guardPermitMaxAgeMs)||config.guardPermitMaxAgeMs>30000||!positiveInteger(config.maxCallsPerRun)||!positiveInteger(config.maxTokensPerRun)||!nonnegative(config.maxCostUsdPerRun)||config.maxCostUsdPerRun===0||!positiveInteger(config.inputFramingReserveTokens)||!nonnegative(config.inputUsdPerMillion)||!nonnegative(config.outputUsdPerMillion)||config.pricingAssumptions!==true)throw fail('LIVE_CONFIG_INVALID','The live Muse settings are invalid');
  return config;
}
export function buildMuseRequest(input,config){
  if(typeof input!=='string'||!input.trim())throw fail('LIVE_INPUT_INVALID','A nonempty redacted input is required');
  if(config.modelId!=='muse-spark-1.3'||config.maxCompletionTokens<500)throw fail('LIVE_CONFIG_INVALID','The pinned Muse model and completion budget are required');
  return{model:config.modelId,input,reasoning:{effort:config.reasoningEffort},max_output_tokens:config.maxCompletionTokens};
}
export function museCost({input,completion},config){return(input*config.inputUsdPerMillion+completion*config.outputUsdPerMillion)/1e6;}
export function reserveMuseRequest(input,config){
  // A documented conservative bound, not the public Muse tokenizer: one token
  // per UTF-8 byte plus explicit framing reserve. Completion includes thinking.
  const inputTokens=Buffer.byteLength(input,'utf8')+config.inputFramingReserveTokens,completionTokens=config.maxCompletionTokens;
  return{input:inputTokens,completion:completionTokens,total:inputTokens+completionTokens,costUsd:museCost({input:inputTokens,completion:completionTokens},config)};
}
export function readMuseUsage(response){
  const usage=response?.usage,input=usage?.input_tokens,completion=usage?.output_tokens,total=usage?.total_tokens,reasoning=usage?.output_tokens_details?.reasoning_tokens;
  if(![input,completion,total].every(value=>Number.isSafeInteger(value)&&value>=0)||total!==input+completion||reasoning!==undefined&&(!Number.isSafeInteger(reasoning)||reasoning<0||reasoning>completion))throw fail('LIVE_USAGE_INVALID','Muse usage is missing or inconsistent; the full reservation is retained');
  return{input,output:completion,completion,reasoning:reasoning??null,visibleOutput:reasoning===undefined?null:completion-reasoning,total};
}
export function parseMuseResponse(response){
  const tokens=readMuseUsage(response);
  if(typeof response?.output_text!=='string'||!response.output_text.trim())throw Object.assign(fail('LIVE_EMPTY_OUTPUT','Muse returned no output_text; the answer is not usable'),{tokens});
  return{text:response.output_text,tokens};
}
async function exists(file){try{await readFile(file);return true;}catch(error){if(error.code==='ENOENT')return false;throw error;}}
async function atomic(file,value){await mkdir(path.dirname(file),{recursive:true});const temporary=`${file}.${process.pid}.${randomUUID()}.tmp`,handle=await open(temporary,'wx',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}await rename(temporary,file);}
async function append(file,value){const handle=await open(file,'a',0o600);try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}}
const auditId=id=>/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(String(id))&&!/^(?:sk-|hf_|AIza|Bearer|\d{6,}$)/i.test(String(id))?String(id):`hashed-${sha256(String(id))}`;
export async function isMuseKilled(config,{dataDir=path.resolve('.handoff'),environment=process.env}={}){
  return config.killSwitch||/^(?:1|true|on)$/i.test(environment.HANDOFF_CLOUD_KILL_SWITCH??'')||await exists(path.join(dataDir,'KILL_CLOUD'));
}
/** Persist reservations before dispatch. A crash/timeout keeps the complete
 * reservation, and configuration changes cannot reset an existing run. */
export async function createMuseRunBudget({runId,dataDir=path.resolve('.handoff'),config,environment=process.env}={}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(String(runId??'')))throw fail('LIVE_RUN_ID_REQUIRED','A stable server-side live run ID is required');
  const dollars=Number(environment.CLOUD_BUDGET_USD);
  if(!Number.isFinite(dollars)||dollars<=0)throw fail('LIVE_BUDGET_UNSET','A positive cloud budget must be authorized before a live run');
  const limits={maxCalls:config.maxCallsPerRun,maxTokens:config.maxTokensPerRun,maxCostUsd:Math.min(config.maxCostUsdPerRun,dollars)},identity=sha256({config,limits});
  const folder=path.join(dataDir,'cloud-runs',runId),stateFile=path.join(folder,'state.json'),auditFile=path.join(folder,'audit.jsonl');await mkdir(folder,{recursive:true});
  async function locked(action){const release=await acquireRunLock(path.join(folder,'run.lock'),{owner:{runId,purpose:'cloud-spend-reservation'}});try{
    let state;try{state=JSON.parse(await readFile(stateFile,'utf8'));}catch(error){if(error.code!=='ENOENT')throw fail('LIVE_LEDGER_INVALID','The live budget ledger is unreadable');state={schemaVersion:1,identity,runId,limits,calls:0,tokens:0,costUsd:0,halted:false,reservations:{}};}
    if(state.identity!==identity)throw fail('LIVE_LEDGER_CHANGED','Resume cannot change a live run budget or pricing configuration');
    return await action(state);
  }finally{await release();}}
  return{
    limits,
    async reserve({itemId,inputHash,guardVerdict='safe',reservation}){return locked(async state=>{
      const record={at:new Date().toISOString(),runId,itemId:auditId(itemId),payloadHash:inputHash,guardVerdict,modelId:config.modelId,phase:'reserved',promptTokens:null,completionTokens:null,reasoningTokens:null,costUsd:null,reservedTokens:reservation.total,reservedCostUsd:reservation.costUsd};
      const killed=await isMuseKilled(config,{dataDir,environment});
      let error;if(killed||state.halted)error=fail('LIVE_KILL_SWITCH','The live cloud kill switch is active');
      else if(state.calls+1>limits.maxCalls||state.tokens+reservation.total>limits.maxTokens||state.costUsd+reservation.costUsd>limits.maxCostUsd)error=fail('LIVE_SPEND_CAP','The live run would exceed its call, total-token or dollar cap');
      if(error){await append(auditFile,{...record,phase:'blocked',code:error.code});throw error;}
      const id=randomUUID();state.calls++;state.tokens+=reservation.total;state.costUsd+=reservation.costUsd;state.reservations[id]={...reservation,status:'outstanding'};
      await atomic(stateFile,state);await append(auditFile,record);return{id,record};
    });},
    async settle(ticket,{tokens,providerCostUsd=null,code=null}={}){return locked(async state=>{
      const held=state.reservations[ticket.id];if(!held||held.status!=='outstanding')throw fail('LIVE_RESERVATION_INVALID','A live reservation cannot be reused');
      let actual=null;if(tokens){const estimated=museCost({input:tokens.input,completion:tokens.completion},config);actual=Math.max(estimated,nonnegative(providerCostUsd)?providerCostUsd:0);held.status='settled';held.actualTokens=tokens.total;held.actualCostUsd=actual;
        state.tokens=Object.values(state.reservations).reduce((sum,row)=>sum+(row.status==='settled'?row.actualTokens:row.total),0);state.costUsd=Object.values(state.reservations).reduce((sum,row)=>sum+(row.status==='settled'?row.actualCostUsd:row.costUsd),0);
        if(tokens.input>held.input||tokens.completion>held.completion||state.tokens>limits.maxTokens||state.costUsd>limits.maxCostUsd)state.halted=true;
      }else{held.status='unknown';state.halted=true;}
      await atomic(stateFile,state);await append(auditFile,{...ticket.record,at:new Date().toISOString(),phase:tokens?'completed':'unknown',code,promptTokens:tokens?.input??null,completionTokens:tokens?.completion??null,reasoningTokens:tokens?.reasoning??null,costUsd:actual,providerCostUsd:nonnegative(providerCostUsd)?providerCostUsd:null,pricingAssumptions:true,halted:state.halted});
      return{halted:state.halted,costUsd:actual};
    });},
    async snapshot(){return locked(async state=>structuredClone(state));},
  };
}
