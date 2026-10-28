import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {performance} from 'node:perf_hooks';
import {decodeVariants} from './decode.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const executable=process.env.HANDOFF_PRIVACY_PYTHON??path.join(root,'.cache/privacy-python312/Scripts/python.exe');
let child,buffer='',sequence=0;const pending=new Map();
function failed(code){return{status:'error',available:false,failClosed:true,code,findings:[],decodedVariants:[]};}
function start(){
  if(child)return;
  const allowed=new Set(['PATH','PATHEXT','SYSTEMROOT','WINDIR','TMP','TEMP','USERPROFILE','LOCALAPPDATA','APPDATA','HOMEDRIVE','HOMEPATH','PROGRAMFILES','PROGRAMFILES(X86)']);
  const environment=Object.fromEntries(Object.entries(process.env).filter(([name])=>allowed.has(name.toUpperCase())));
  const instance=spawn(executable,['-u',path.join(root,'scripts/privacy-worker.py')],{cwd:root,windowsHide:true,stdio:['pipe','pipe','ignore'],env:{...environment,HF_HUB_OFFLINE:'1',TRANSFORMERS_OFFLINE:'1',PYTHONUTF8:'1',PYTHONIOENCODING:'utf-8'}});child=instance;
  instance.stdout.setEncoding('utf8');instance.stdout.on('data',chunk=>{if(child!==instance)return;buffer+=chunk;while(buffer.includes('\n')){const end=buffer.indexOf('\n'),line=buffer.slice(0,end);buffer=buffer.slice(end+1);try{const value=JSON.parse(line),entry=pending.get(value.id);if(entry){pending.delete(value.id);clearTimeout(entry.timer);entry.resolve(value);}}catch{for(const entry of pending.values()){clearTimeout(entry.timer);entry.resolve(failed('PRIVACY_PROTOCOL_ERROR'));}pending.clear();}}});
  const gone=()=>{if(child!==instance)return;child=null;buffer='';for(const entry of pending.values()){clearTimeout(entry.timer);entry.resolve(failed('PRIVACY_WORKER_UNAVAILABLE'));}pending.clear();};instance.on('error',gone);instance.on('exit',gone);instance.unref();instance.stdin.unref?.();instance.stdout.unref?.();
}
async function request(action,fields={}){
  start();const id=++sequence;
  return new Promise(resolve=>{const timer=setTimeout(()=>{pending.delete(id);resolve(failed('PRIVACY_WORKER_TIMEOUT'));},60000);pending.set(id,{resolve,timer});child.stdin.write(JSON.stringify({id,action,...fields})+'\n',error=>{if(error&&pending.has(id)){pending.delete(id);clearTimeout(timer);resolve(failed('PRIVACY_WORKER_UNAVAILABLE'));}});});
}
export async function privacyHealth(){return request('health');}
export async function validatePrivacyValue(type,value){return request('validate',{type,value});}
export async function scanPrivateText(text,{countries,decode=true}={}){
  const started=performance.now(),input=String(text??''),decoded=decode?decodeVariants(input):{variants:[],issues:[],failClosed:false,limitsExceeded:false};
  if(decoded.failClosed)return{...failed('PRIVACY_DECODE_FAILED'),decodeIssues:decoded.issues,limitsExceeded:decoded.limitsExceeded,latencyMs:performance.now()-started};
  const raw=await request('scan',{text:input,countries});if(raw.status!=='ok')return{...raw,latencyMs:performance.now()-started};
  const findings=raw.findings.map(item=>({...item,source:'original'})),variants=[];
  for(const variant of decoded.variants){const scan=await request('scan',{text:variant.text,countries});if(scan.status!=='ok')return{...scan,failClosed:true,latencyMs:performance.now()-started};variants.push({...variant,findings:scan.findings});for(const item of scan.findings){const span=variant.originSpan??{start:0,end:input.length};findings.push({...item,decodedStart:item.start,decodedEnd:item.end,start:span.start,end:span.end,value:input.slice(span.start,span.end),source:'decoded',encoding:variant.encoding});}}
  return{status:'ok',available:true,failClosed:false,limitsExceeded:false,decodeIssues:[],findings,decodedVariants:variants,latencyMs:performance.now()-started};
}
export const scanPrivacy=scanPrivateText;
export async function scanPresidio(text){const started=performance.now(),result=await request('presidio',{text:String(text??'')});return{...result,latencyMs:performance.now()-started,failClosed:result.status!=='ok',comparisonOnly:true};}
export async function closePrivacyWorker(){if(child){const instance=child;child=null;buffer='';for(const entry of pending.values()){clearTimeout(entry.timer);entry.resolve(failed('PRIVACY_WORKER_CLOSED'));}pending.clear();instance.stdin.end();instance.kill();}}
