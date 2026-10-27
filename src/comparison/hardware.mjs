import { execFileSync } from 'node:child_process';
import os from 'node:os';
import { sha256 } from '../rag/receipts.mjs';

export async function recordEnvironment(){
  let ollamaVersion=null,gpus=[],ollamaModels=[];
  try{ollamaVersion=execFileSync('ollama',['--version'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']}).trim();}catch{}
  try{const output=execFileSync('nvidia-smi',['--query-gpu=name,driver_version,memory.total','--format=csv,noheader,nounits'],{encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','ignore']});gpus=output.trim().split('\n').filter(Boolean).map(line=>{const [name,driverVersion,vramMiB]=line.split(',').map(part=>part.trim());return{name,driverVersion,vramMiB:Number(vramMiB)};});}catch{}
  try{const response=await fetch('http://127.0.0.1:11434/api/tags',{signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error();const tags=await response.json();ollamaModels=tags.models.map(model=>({modelId:model.name,digest:model.digest,bytes:model.size,details:model.details}));}catch{}
  const environment={profile:'SMB-class local workstation',recordedAt:new Date().toISOString(),cpu:{name:os.cpus()[0]?.model??null,logicalCores:os.cpus().length},ramGiB:Number((os.totalmem()/2**30).toFixed(2)),gpus,os:{platform:os.platform(),release:os.release(),architecture:os.arch()},ollamaVersion,ollamaModels};
  const guardTemplates=[];
  for(const modelId of ['llama-guard3:8b','shieldgemma:9b']){
    try{const response=await fetch('http://127.0.0.1:11434/api/show',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({model:modelId}),signal:AbortSignal.timeout(10000)});if(!response.ok)throw new Error();const info=await response.json();guardTemplates.push({modelId,templateSha256:sha256(info.template??''),parametersSha256:sha256(info.parameters??'')});}catch{guardTemplates.push({modelId,templateSha256:null,parametersSha256:null});}
  }
  environment.guardTemplates=guardTemplates;
  return{...environment,sha256:sha256(environment)};
}
