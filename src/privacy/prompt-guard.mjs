import {spawn} from 'node:child_process';
import {readFile,readdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

const configFile=new URL('../../config/stage6b.json',import.meta.url),worker=fileURLToPath(new URL('./prompt_guard_worker.py',import.meta.url));
const models=new Map();
export function createPromptGuardMailbox({timeoutMs=120000}={}){
  const pending=new Map();let sequence=0;
  return{
    register(){const id=++sequence;let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no;});const timer=setTimeout(()=>{const slot=pending.get(id);if(slot){pending.delete(id);slot.reject(Error('Local classifier timed out'));}},timeoutMs);pending.set(id,{resolve:value=>{clearTimeout(timer);resolve(value);},reject:failure=>{clearTimeout(timer);reject(failure);}});return{id,promise};},
    deliver(value){const slot=pending.get(value?.id);if(!slot)return false;pending.delete(value.id);slot.resolve(value);return true;},
    cancel(id){const slot=pending.get(id);if(!slot)return false;pending.delete(id);slot.reject(Error('Local classifier request expired'));return true;},
    failAll(){for(const slot of pending.values())slot.reject(Error('Local classifier stopped'));pending.clear();},
    get size(){return pending.size;},
  };
}
/** No hub/network lookup, authentication token or remote fallback is permitted. */
export async function runPromptGuard(texts,{variant='86m',predict}={}){
  const start=performance.now(),settings=JSON.parse(await readFile(configFile,'utf8')).promptGuard,model=settings.variants[variant];
  if(!model)throw Error('Unknown local Prompt Guard variant');
  const input=Array.isArray(texts)?texts:[texts];if(input.some(text=>typeof text!=='string'||text.length>65536))return{status:'BLOCKED',available:false,detected:false,reason:'INPUT_LIMIT',variant,modelId:model.modelId,latencyMs:performance.now()-start};
  try{
    const directory=path.resolve(model.directory);
    if(!predict){const files=await readdir(directory).catch(()=>[]);if(!files.includes('config.json')||!files.some(name=>name.endsWith('.safetensors')))return{status:'PENDING',available:false,detected:false,reason:'LOCAL_MODEL_UNAVAILABLE',variant,modelId:model.modelId,latencyMs:performance.now()-start};}
    const result=predict?await predict(input,{variant,...settings,modelId:model.modelId}):await localWorker({texts:input,directory,threshold:settings.threshold,maxWindowTokens:settings.maxWindowTokens,overlapTokens:settings.overlapTokens,positiveLabel:settings.positiveLabel});
    if(result.status!=='READY'||result.localOnly!==true)return{status:'PENDING',available:false,detected:false,reason:result.reason==='PENDING_MAPPING'?'PENDING_MAPPING':'LOCAL_MODEL_UNAVAILABLE',variant,modelId:model.modelId,latencyMs:performance.now()-start};
    if(!Number.isInteger(result.windows)||result.windows<1||!Number.isFinite(result.maxScore)||result.maxScore<0||result.maxScore>1)throw Error('Invalid local classifier result');
    return{status:result.maxScore>=settings.threshold?'BLOCKED':'PASS',available:true,detected:result.maxScore>=settings.threshold,variant,modelId:model.modelId,windows:result.windows,maxScore:result.maxScore,threshold:settings.threshold,latencyMs:performance.now()-start};
  }catch{return{status:'PENDING',available:false,detected:false,reason:'LOCAL_MODEL_UNAVAILABLE',variant,modelId:model.modelId,latencyMs:performance.now()-start};}
}
function localWorker(message){
  const python=process.env.STAGE6B_PYTHON??process.env.HANDOFF_PRIVACY_PYTHON??path.resolve('.cache/privacy-python312/Scripts/python.exe'),key=python;
  let record=models.get(key);
  if(!record){
    const environment=Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','HOME','LANG','LC_ALL','PYTHONPATH'].filter(name=>typeof process.env[name]==='string').map(name=>[name,process.env[name]]));
    const child=spawn(python,['-u',worker],{stdio:['pipe','pipe','ignore'],windowsHide:true,env:{...environment,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1'}});
    record={child,mailbox:createPromptGuardMailbox(),buffer:''};models.set(key,record);child.stdout.on('data',bytes=>{record.buffer+=bytes.toString();if(record.buffer.length>65536){record.mailbox.failAll();child.kill();return;}while(record.buffer.includes('\n')){const end=record.buffer.indexOf('\n'),line=record.buffer.slice(0,end);record.buffer=record.buffer.slice(end+1);try{record.mailbox.deliver(JSON.parse(line));}catch{record.mailbox.failAll();}}});child.on('error',()=>{record.mailbox.failAll();models.delete(key);});child.on('exit',()=>{record.mailbox.failAll();models.delete(key);});
  }
  const request=record.mailbox.register();record.child.stdin.write(JSON.stringify({...message,id:request.id})+'\n',failure=>{if(failure)record.mailbox.cancel(request.id);});return request.promise;
}
export function closePromptGuardWorkers(){for(const record of models.values())record.child.kill();models.clear();}
export const screenPromptGuardInputs=(texts,{size='86m',...options}={})=>runPromptGuard(texts,{variant:size,...options});
