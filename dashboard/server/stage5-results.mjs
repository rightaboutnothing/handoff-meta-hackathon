import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sanitizePublicResult} from '../../src/evaluation/publish-results.mjs';

const root=fileURLToPath(new URL('../../results/',import.meta.url));
const allowed=['schemaVersion','kind','version','runId','timestamp','tier','status','dryRun','sourceRun','sourceStage4Run','sourceHashes','sourcePolicyHash','provenance','settings','scope','population','localModelId','guardModel','guardModelId','environment','warmup','runOrder','summary','items','certification','cloudCalls','modelAnswerCalls','spendUsd','externalRequests','network','notes','limitations','flagDefaultEnabled','routingFlagDefault','routingConfig','inboundStatus','privateSnapshotLocation','wouldSendSnapshots','guardCalls','method'];
async function regular(file,parent){
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>4*1024*1024)throw new Error('Guard report must be a bounded regular local file');
  const resolved=await realpath(file);if(path.dirname(resolved).toLowerCase()!==parent.toLowerCase())throw new Error('Guard report escaped its published directory');
  return readFile(resolved,'utf8');
}
function stripPrivate(value,key=''){
  if(/^(?:raw|rawAnswer|rawCheck|rawGuard|guardText|requests|records|checkpoints|payloads|privatePayloads|wire|messages|piiMap|draft|localDraft|retrievedContext|wouldSendSnapshots|privateSnapshotLocation)$/i.test(key))return undefined;
  if(Array.isArray(value))return value.map(item=>stripPrivate(item,key)).filter(item=>item!==undefined);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,stripPrivate(item,name)]).filter(([,item])=>item!==undefined));
  return value;
}
/** A measured local Guard report, never task text or would-send contents. */
export async function readStage5Results({resultsDir=root}={}){
  let base;try{base=await realpath(resultsDir);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  let pointer;try{pointer=JSON.parse(await regular(path.join(base,'stage5-latest.json'),base));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(pointer.schemaVersion!==1||typeof pointer.directory!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(pointer.directory)||!/^[a-f0-9]{64}$/.test(pointer.reportSha256??''))throw new Error('Invalid published Guard report reference');
  const folder=path.join(base,pointer.directory),info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Guard report directory must be local and regular');
  const resolved=await realpath(folder);if(path.dirname(resolved).toLowerCase()!==base.toLowerCase())throw new Error('Invalid Guard report directory');
  const text=await regular(path.join(resolved,'report.json'),resolved);
  if(createHash('sha256').update(text).digest('hex')!==pointer.reportSha256)throw new Error('Guard report hash mismatch');
  const report=JSON.parse(text);
  if(report.schemaVersion!==1||report.kind!=='stage5-guard-report'||report.runId!==pointer.directory||report.tier!==0||report.dryRun!==true||report.cloudCalls!==0||report.modelAnswerCalls!==0||report.spendUsd!==0||!Array.isArray(report.items)||!report.summary)throw new Error('Unsupported dry-run Guard report');
  const released=report.items.filter(item=>item.wouldRelease===true);
  if(released.some(item=>item.screened!==true||item.verdict!=='safe'||item.releaseStatus!=='would_release')||report.summary.items!==report.items.length||report.summary.released!==released.length||report.summary.screened!==report.items.filter(item=>item.screened===true).length||report.summary.blocked!==report.items.length-released.length)throw new Error('Guard release summary disagrees with recorded verdicts');
  return stripPrivate(sanitizePublicResult(Object.fromEntries(allowed.filter(key=>Object.hasOwn(report,key)).map(key=>[key,report[key]]))));
}
