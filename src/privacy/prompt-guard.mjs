import {spawn} from 'node:child_process';
import {readFile,readdir,stat} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {performance} from 'node:perf_hooks';

const configFile=new URL('../../config/stage6b.json',import.meta.url),artifactFile=new URL('../../config/prompt-guard-artifacts.json',import.meta.url),worker=fileURLToPath(new URL('./prompt_guard_worker.py',import.meta.url));
const root=fileURLToPath(new URL('../../',import.meta.url));
const models=new Map(),verifiedAssets=new Map();
const digest=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const pending=(variant,modelId,reason,start)=>({status:'PENDING',available:false,detected:false,reason,variant,modelId,latencyMs:performance.now()-start});
async function readJson(file){return JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));}
async function localSettings({runtimeFile}={}){
  let runtime={schemaVersion:1};
  try{runtime=await readJson(runtimeFile??process.env.HANDOFF_PROMPT_GUARD_RUNTIME??path.join(root,'.cache/prompt-guard-local.json'));}catch(error){if(error.code!=='ENOENT')throw Error('INVALID_LOCAL_PG_RUNTIME');}
  if(runtime.schemaVersion!==1||runtime.torchThreads!==undefined&&(!Number.isInteger(runtime.torchThreads)||runtime.torchThreads<1||runtime.torchThreads>8))throw Error('INVALID_LOCAL_PG_RUNTIME');
  const settings=(await readJson(configFile)).promptGuard,artifacts=await readJson(artifactFile);
  return{settings,artifacts,runtime,python:runtime.pythonExecutable??process.env.STAGE6B_PYTHON??process.env.HANDOFF_PRIVACY_PYTHON??path.join(root,'.cache/privacy-python312/Scripts/python.exe'),torchThreads:runtime.torchThreads??4};
}
async function fileHash(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
/** Hash-pinned local assets authorize only the official binary-label fallback.
 * Paths and file contents are never included in returned public metadata. */
export async function inspectPromptGuardAssets({variant='86m',directory,settings:provided}={}){
  const local=provided??await localSettings(),expected=local.artifacts.variants[variant],model=local.settings.variants[variant];
  if(!expected||!model||model.modelId!==expected.modelId)throw Error('PG_MODEL_NOT_APPROVED');
  const target=path.resolve(directory??local.runtime.variants?.[variant]?.directory??path.resolve(root,model.directory));
  const names=await readdir(target).catch(()=>[]);if(!names.includes('config.json')||!names.includes('model.safetensors'))return{available:false,reason:'LOCAL_MODEL_UNAVAILABLE',variant,modelId:model.modelId};
  const fingerprints={};for(const name of Object.keys(expected.files)){const info=await stat(path.join(target,name));if(!info.isFile())throw Error('PG_ASSET_INVALID');fingerprints[name]={bytes:info.size,modified:info.mtimeMs};}
  const identity=digest({target,fingerprints,expected}),cached=verifiedAssets.get(identity);if(cached)return cached;
  const hashes={};for(const [name,hash]of Object.entries(expected.files)){const actual=await fileHash(path.join(target,name));if(actual!==hash)throw Error('PG_ASSET_HASH_MISMATCH');hashes[name]=actual;}
  const config=await readJson(path.join(target,'config.json'));
  if(config.architectures?.[0]!=='DebertaV2ForSequenceClassification'||config.max_position_embeddings!==512)throw Error('PG_ARCHITECTURE_UNAPPROVED');
  const value={available:true,variant,modelId:expected.modelId,revision:expected.revision,assetHashes:hashes,assetIdentity:digest({modelId:expected.modelId,revision:expected.revision,hashes}),labelMapping:local.artifacts.labelMapping,mappingSource:local.artifacts.mappingSource,threshold:local.settings.threshold,device:'cpu',torchThreads:local.torchThreads};verifiedAssets.set(identity,value);return value;
}
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
/** No hub lookup, model download or credential use is permitted. */
export async function runPromptGuard(texts,{variant='86m',predict,modelDirectory,runtimeFile}={}){
  const start=performance.now();let model;
  try{
    const local=await localSettings({runtimeFile}),{settings}=local;model=settings.variants[variant];if(!model)throw Error('PG_VARIANT_INVALID');
    const input=Array.isArray(texts)?texts:[texts];if(!input.length||input.some(text=>typeof text!=='string'||text.length>65536))return{status:'BLOCKED',available:false,detected:false,reason:'INPUT_LIMIT',variant,modelId:model.modelId,latencyMs:performance.now()-start};
    const assets=predict?null:await inspectPromptGuardAssets({variant,directory:modelDirectory,settings:local});if(assets&&!assets.available)return pending(variant,model.modelId,assets.reason,start);
    const directory=path.resolve(modelDirectory??local.runtime.variants?.[variant]?.directory??path.resolve(root,model.directory));
    const result=predict?await predict(input,{variant,...settings,modelId:model.modelId}):await localWorker({action:'predict',texts:input,directory,variant,threshold:settings.threshold,maxWindowTokens:settings.maxWindowTokens,overlapTokens:settings.overlapTokens,assetIdentity:assets.assetIdentity,torchThreads:local.torchThreads},local);
    if(result.status!=='READY'||result.localOnly!==true)return pending(variant,model.modelId,/^[A-Z_]{1,60}$/.test(result.reason??'')?result.reason:'LOCAL_MODEL_UNAVAILABLE',start);
    if(!Number.isInteger(result.windows)||result.windows<1||!Number.isFinite(result.maxScore)||result.maxScore<0||result.maxScore>1)throw Error('PG_RESULT_INVALID');
    return{status:result.maxScore>=settings.threshold?'BLOCKED':'PASS',available:true,detected:result.maxScore>=settings.threshold,variant,modelId:model.modelId,...(assets?{revision:assets.revision,assetIdentity:assets.assetIdentity}:{}),windows:result.windows,maxScore:result.maxScore,threshold:settings.threshold,latencyMs:performance.now()-start,...(result.tokenizeMs!==undefined?{tokenizeMs:result.tokenizeMs,inferenceMs:result.inferenceMs,loadMs:result.loadMs}:{}),device:'cpu',torchThreads:local.torchThreads};
  }catch{return pending(variant,model?.modelId??'local-prompt-guard', 'LOCAL_MODEL_UNAVAILABLE',start);}
}
/** Metadata-only readiness, including a real files-only model load but no prediction. */
export async function promptGuardHealth({variants=['86m','22m'],runtimeFile}={}){
  const local=await localSettings({runtimeFile}),values=[];
  for(const variant of variants){
    try{const assets=await inspectPromptGuardAssets({variant,settings:local});if(!assets.available){values.push({...assets,status:'PENDING'});continue;}
      const directory=path.resolve(local.runtime.variants?.[variant]?.directory??path.resolve(root,local.settings.variants[variant].directory));
      const result=await localWorker({action:'health',directory,variant,assetIdentity:assets.assetIdentity,torchThreads:local.torchThreads},local);
      values.push({...assets,status:result.status==='READY'?'READY':'PENDING',available:result.status==='READY',reason:result.reason??null,versions:result.versions??null,labelMapping:result.labelMapping??assets.labelMapping,networkDisabled:result.networkDisabled===true,loadMs:result.loadMs??null});
    }catch{values.push({variant,status:'PENDING',available:false,reason:'LOCAL_MODEL_UNAVAILABLE'});}
  }
  return{status:values.every(row=>row.status==='READY')?'READY':'PENDING',localOnly:true,device:'cpu',torchThreads:local.torchThreads,threshold:local.settings.threshold,thresholdRationale:local.artifacts.thresholdRationale,variants:values};
}
export async function warmPromptGuard({variant='86m'}={}){const result=await runPromptGuard(['Please summarize the public document.'],{variant});return{...result,excludedFromTimings:true,warmup:true};}
function localWorker(message,local){
  const key=digest({python:local.python,threads:local.torchThreads});let record=models.get(key);
  if(!record){
    const environment=Object.fromEntries(['PATH','Path','SystemRoot','WINDIR','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','LANG','LC_ALL'].filter(name=>typeof process.env[name]==='string').map(name=>[name,process.env[name]]));
    const child=spawn(local.python,['-u',worker],{stdio:['pipe','pipe','ignore'],windowsHide:true,env:{...environment,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',HF_HUB_DISABLE_TELEMETRY:'1',HF_HUB_DISABLE_PROGRESS_BARS:'1',TOKENIZERS_PARALLELISM:'false',DO_NOT_TRACK:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8',OMP_NUM_THREADS:String(local.torchThreads),MKL_NUM_THREADS:String(local.torchThreads)}});
    record={child,mailbox:createPromptGuardMailbox(),buffer:''};models.set(key,record);child.stdout.on('data',bytes=>{record.buffer+=bytes.toString();if(record.buffer.length>65536){record.mailbox.failAll();child.kill();return;}while(record.buffer.includes('\n')){const end=record.buffer.indexOf('\n'),line=record.buffer.slice(0,end);record.buffer=record.buffer.slice(end+1);try{record.mailbox.deliver(JSON.parse(line));}catch{record.mailbox.failAll();}}});child.on('error',()=>{record.mailbox.failAll();models.delete(key);});child.on('exit',()=>{record.mailbox.failAll();models.delete(key);});
  }
  const request=record.mailbox.register();record.child.stdin.write(JSON.stringify({...message,id:request.id})+'\n',failure=>{if(failure)record.mailbox.cancel(request.id);});return request.promise;
}
export function closePromptGuardWorkers(){for(const record of models.values())record.child.kill();models.clear();}
export const screenPromptGuardInputs=(texts,{size='86m',...options}={})=>runPromptGuard(texts,{variant:size,...options});
