import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sanitizePublicResult} from '../../src/evaluation/publish-results.mjs';

const root=fileURLToPath(new URL('../../results/',import.meta.url));
const pick=(value,keys)=>Object.fromEntries(keys.filter(key=>Object.hasOwn(value??{},key)).map(key=>[key,value[key]]));
const sha=text=>createHash('sha256').update(text).digest('hex');
const metricKeys=['id','label','area','n','events','rate','wilson95','errors','definition'];
const isId=value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,199}$/.test(value);
const strings=(value,name)=>{if(value===undefined)return undefined;if(!Array.isArray(value)||value.some(item=>typeof item!=='string'))throw new Error(`Invalid ${name} metadata`);return value;};
function numbers(value,keys){const out=pick(value,keys);if(Object.values(out).some(item=>!Number.isFinite(item)||item<0))throw new Error('Invalid readiness token or cap counts');return out;}
async function regular(file,parent){
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)throw new Error('Stress report must be a bounded regular local file');
  const resolved=await realpath(file);if(path.dirname(resolved).toLowerCase()!==parent.toLowerCase())throw new Error('Stress report escaped its published directory');
  return readFile(resolved,'utf8');
}
function metric(row){
  if(!isId(row?.id)||typeof row?.label!=='string'||typeof row?.area!=='string'||row.definition!==undefined&&typeof row.definition!=='string'||!Number.isInteger(row.n)||row.n<0||!Number.isInteger(row.events)||row.events<0||row.events>row.n||!Number.isInteger(row.errors)||row.errors<0)throw new Error('Invalid stress metric counts');
  if(row.n===0){if(row.rate!==null||row.wilson95!==null)throw new Error('Unmeasured stress rates must remain pending');}
  else if(!Number.isFinite(row.rate)||Math.abs(row.rate-row.events/row.n)>1e-8||!Array.isArray(row.wilson95)||row.wilson95.length!==2||row.wilson95.some(value=>!Number.isFinite(value)||value<0||value>1)||row.wilson95[0]>row.wilson95[1])throw new Error('Stress rates disagree with their denominators');
  return pick(row,metricKeys);
}
function metrics(rows){if(!Array.isArray(rows))throw new Error('Invalid stress metric array');const out=rows.map(metric);if(new Set(out.map(row=>row.id)).size!==out.length)throw new Error('Duplicate stress metric identity');return out;}
function readiness(value,runId){
  if(value==null)return null;
  if(value.schemaVersion!==1||value.kind!=='stage6-live-readiness'||value.tier!==0||value.dryRun!==true||value.runId!==runId||value.cloudCalls!==0||value.spendUsd!==0)throw new Error('Live readiness must match the prepare-only stress report');
  if(!Array.isArray(value.checks)||!Number.isInteger(value.preparedItems)||value.preparedItems<0)throw new Error('Invalid live readiness checks');
  for(const key of ['projectedCostUsd','reservedUpperUsd'])if(value[key]!=null&&(!Number.isFinite(value[key])||value[key]<0))throw new Error('Invalid live readiness cost');
  const out=pick(value,['schemaVersion','kind','runId','tier','dryRun','status','preparedItems','cloudCalls','spendUsd','projectedCostUsd','reservedUpperUsd','defaultKillSwitch','defaultRoutingFlag','maxCompletionTokens','runFitsDefaultCaps']);
  out.assumptions=strings(value.assumptions,'readiness assumptions');out.notes=strings(value.notes,'readiness notes');
  out.tokens=numbers(value.tokens,['input','visibleOutput','reasoning','completion','total']);
  out.reservedTokens=numbers(value.reservedTokens,['input','completion','total']);
  out.defaultCaps=numbers(value.defaultCaps,['calls','tokens','costUsd']);out.requiredCaps=numbers(value.requiredCaps,['calls','tokens','costUsd']);
  out.checks=value.checks.map(check=>{
    if(!isId(check.id)||typeof check.label!=='string'||check.detail!==undefined&&typeof check.detail!=='string'||![true,false,null].includes(check.pass))throw new Error('Invalid live readiness verdict');
    return pick(check,['id','label','pass','detail']);
  });
  return out;
}
/** The browser receives aggregates and category/ID/hash failure references.
 * No per-item prompts, outputs, private would-send payloads or raw model text. */
export async function readStage6Results({resultsDir=root}={}){
  let base;try{base=await realpath(resultsDir);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  let pointer;try{pointer=JSON.parse(await regular(path.join(base,'stage6-latest.json'),base));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(pointer.schemaVersion!==1||typeof pointer.directory!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(pointer.directory)||!/^[a-f0-9]{64}$/.test(pointer.reportSha256??''))throw new Error('Invalid published stress report reference');
  const folder=path.join(base,pointer.directory),info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Stress report directory must be local and regular');
  const resolved=await realpath(folder);if(path.dirname(resolved).toLowerCase()!==base.toLowerCase())throw new Error('Invalid stress report directory');
  const text=await regular(path.join(resolved,'report.json'),resolved);if(sha(text)!==pointer.reportSha256)throw new Error('Stress report hash mismatch');
  const report=JSON.parse(text);
  if(report.schemaVersion!==1||report.kind!=='stage6-guard-stress-report'||report.runId!==pointer.directory||report.tier!==0||report.cloudCalls!==0||report.modelAnswerCalls!==0||report.spendUsd!==0||!Array.isArray(report.metrics))throw new Error('Unsupported local-only stress report');
  const out=pick(report,['schemaVersion','kind','runId','timestamp','tier','status','dryRun','localOnly','guardModelId','cloudCalls','modelAnswerCalls','spendUsd']);
  out.notes=strings(report.notes,'stress notes');out.limitations=strings(report.limitations,'stress limitations');
  out.metrics=metrics(report.metrics);
  out.trickBreakdown=metrics(report.trickBreakdown??[]);
  out.categoryBreakdown=metrics(report.categoryBreakdown??[]);
  out.failuresByArea=Object.fromEntries(Object.entries(report.failuresByArea??{}).map(([area,rows])=>{
    if(!Array.isArray(rows))throw new Error('Invalid stress failure references');
    return[area,rows.slice(0,5).map(row=>{
      if(!isId(row?.id)||typeof row?.category!=='string'||row.hash!=null&&!/^[a-f0-9]{64}$/.test(row.hash))throw new Error('Invalid stress failure identity');
      return pick(row,['id','category','hash']);
    })];
  }));
  out.summary=Object.fromEntries(Object.entries(report.summary??{}).filter(([,value])=>value===null||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value)));
  out.sources=(report.sources??[]).map(source=>{const selected=pick(source,['id','name','url','source','licence','license','sha256']);if(Object.values(selected).some(value=>typeof value!=='string'))throw new Error('Invalid stress source metadata');return selected;});
  out.readiness=readiness(report.readiness,report.runId);
  return sanitizePublicResult(out);
}
