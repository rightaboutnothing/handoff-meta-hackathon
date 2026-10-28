import {readFile,readdir,mkdir,open,rename} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {sha256} from '../rag/receipts.mjs';

export const STAGE6B_ROOT=fileURLToPath(new URL('../../',import.meta.url));
export const stage6bPrivateRoot=(root=STAGE6B_ROOT)=>path.resolve(process.env.STAGE6B_PRIVATE_ROOT??path.join(root,'../Handoff-private/stage6b'));
export const readStage6bJson=async file=>JSON.parse((await readFile(file,'utf8')).replace(/^\uFEFF/,''));
export async function optionalStage6bJson(file){try{return await readStage6bJson(file);}catch(error){if(error.code==='ENOENT')return null;throw error;}}
export async function durableStage6bJson(file,value){await mkdir(path.dirname(file),{recursive:true});const temporary=file+'.'+process.pid+'.tmp',handle=await open(temporary,'w',0o600);try{await handle.writeFile(JSON.stringify(value,null,2)+'\n');await handle.sync();}finally{await handle.close();}await rename(temporary,file);}
export async function appendStage6bJsonl(file,value){await mkdir(path.dirname(file),{recursive:true});const handle=await open(file,'a',0o600);try{await handle.writeFile(JSON.stringify(value)+'\n');await handle.sync();}finally{await handle.close();}}
export async function readStage6bJournal(file){
  let text;try{text=await readFile(file,'utf8');}catch(error){if(error.code==='ENOENT')return[];throw error;}
  if(text&&!text.endsWith('\n')){const complete=text.lastIndexOf('\n')+1,handle=await open(file,'r+');try{await handle.truncate(Buffer.byteLength(text.slice(0,complete)));await handle.sync();}finally{await handle.close();}text=text.slice(0,complete);}
  return text.split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
async function listFiles(directory){const entries=await readdir(directory,{withFileTypes:true}),out=[];for(const entry of entries){const file=path.join(directory,entry.name);if(entry.isDirectory())out.push(...await listFiles(file));else if(entry.isFile())out.push(file);}return out;}
export async function fingerprintStage6b(root=STAGE6B_ROOT){
  const names=['config/stage6b.json','config/stage6b-evaluation.json','config/live-muse.json','config/rag.json','src/evaluation/stage6b-io.mjs','src/evaluation/stage6b-metrics.mjs','src/evaluation/stage6b-network.mjs','src/evaluation/stage6b-runner.mjs','src/server/privacy-models.mjs','src/server/gateway-models.mjs','src/comparison/policy.mjs','scripts/privacy-worker.py'];
  const files=[...names.map(name=>path.join(root,name)),...await listFiles(path.join(root,'src/privacy')),...await listFiles(path.join(root,'config/privacy-rules'))],hashes={};
  for(const file of files.sort())hashes[path.relative(root,file).replaceAll('\\','/')]=sha256((await readFile(file,'utf8')).replace(/\r\n/g,'\n'));
  return{hash:sha256(hashes),files:hashes,gitCommit:execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8',windowsHide:true}).trim()};
}
export async function loadStage6bInputs({root=STAGE6B_ROOT}={}){
  const settings=await readStage6bJson(path.join(root,'config/stage6b-evaluation.json')),privateRoot=stage6bPrivateRoot(root),stage6=path.resolve(process.env.STAGE6_PRIVATE_ROOT??path.join(root,'../Handoff-private/stage6')),manifest=await readStage6bJson(path.join(stage6,'manifest.json')),body=await readFile(path.join(stage6,'corpus.jsonl'),'utf8');
  const items=body.trim().split(/\r?\n/).map(JSON.parse);
  if(sha256(body)!==manifest.corpusSha256||items.length!==522||manifest.count!==522||items.some(row=>row.localOnly!==true||row.attackSet!==true||row.safety?.cloudEligible!==false||row.sourceSuite==='gpqa'))throw Error('STAGE6B_FROZEN_CORPUS_INVALID');
  const multiManifest=await readStage6bJson(path.join(privateRoot,'multicountry-manifest.json')),multiText=await readFile(path.join(privateRoot,'multicountry.jsonl'),'utf8'),multicountry=multiText.trim().split(/\r?\n/).map(JSON.parse);
  if(sha256(multiText)!==multiManifest.corpusSha256||multicountry.length<50||new Set(multicountry.map(row=>row.id)).size!==multicountry.length)throw Error('STAGE6B_MULTICOUNTRY_INVALID');
  return{root,settings,privateRoot,items,multicountry,manifest,multiManifest,inputHashes:{frozenCorpus:sha256(body),frozenManifest:sha256(manifest),multicountry:sha256(multiText),multicountryManifest:sha256(multiManifest)}};
}
export async function loadStage6bQuality(inputs){
  const {root,settings}=inputs,pointer=await readStage6bJson(path.join(root,'results/stage5-latest.json')),text=await readFile(path.join(root,'results',pointer.directory,'report.json'),'utf8');
  if(sha256(text)!==pointer.reportSha256)throw Error('STAGE6B_QUALITY_SOURCE_CHANGED');
  const report=JSON.parse(text);if(report.runId!==settings.qualitySourceRun||report.items.length!==11||report.items.some(row=>row.verdict!=='safe'))throw Error('STAGE6B_QUALITY_SOURCE_INVALID');
  const tasksText=await readFile(path.join(root,'tasks/comparison/items.jsonl'),'utf8'),tasks=new Map(tasksText.trim().split(/\r?\n/).map(JSON.parse).map(row=>[row.id,row]));
  const rows=[];
  for(const selected of report.items){
    const task=tasks.get(selected.id),frozen=inputs.items.find(row=>row.area==='safe'&&row.sourceItemId===selected.id);
    if(!task||!frozen||task.safety?.kind!=='safe'||task.suite==='gpqa')throw Error('STAGE6B_QUALITY_TASK_INVALID');
    let context=[];
    if(task.suite==='company-rag'){
      const file=path.join(root,'.logs/stage2/2026-10-28-stage2-complete-retrieval/contexts',sha256(task.id)+'.json'),prepared=await readStage6bJson(file);context=prepared.chunks??[];
    }
    rows.push({id:selected.id,sourceItem:frozen,task,context,contextHash:sha256(context)});
  }
  return{rows,hash:sha256({report:pointer.reportSha256,tasks:sha256(tasksText),contexts:rows.map(row=>[row.id,row.contextHash])})};
}
