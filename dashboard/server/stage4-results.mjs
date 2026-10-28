import {createHash} from 'node:crypto';
import {lstat,readFile,realpath} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {sanitizePublicResult} from '../../src/evaluation/publish-results.mjs';

const root=fileURLToPath(new URL('../../results/',import.meta.url));
const allowed=['schemaVersion','kind','version','runId','timestamp','timestampMeaning','reportBuiltFromFrozenAt','tier','status','seed','cloudCalls','modelCalls','remoteCountingCalls','spendUsd','externalRequests','network','source','sourceRun','sourcePolicyHash','sourceHashes','provenance','scope','primaryPopulation','populations','modelIds','models','slices','rows','costs','workloadMix','workloadAssumptions','privacy','recommendation','certification','pricing','tokenCounting','assumptions','notes','summaryParagraph','charts','coverage','primaryComposition','limitations','method','settings','summary','baseline','actualSpendUsd','futureCertified','readOnlyAnalysis','qualityPerDollar'];
async function regular(file,parent){
  const info=await lstat(file);if(!info.isFile()||info.isSymbolicLink()||info.size>8*1024*1024)throw new Error('Slice report must be a bounded regular local file');
  const resolved=await realpath(file);if(path.dirname(resolved).toLowerCase()!==parent.toLowerCase())throw new Error('Slice report escaped its published directory');
  return readFile(resolved,'utf8');
}
function removeRequests(value,key=''){
  if(/^(?:raw|rawAnswer|rawCheck|requests|records|checkpoints|payloads|privatePayloads|privateRecords|messages|piiMap|draft|localDraft|retrievedContext)$/i.test(key))return undefined;
  if(Array.isArray(value))return value.map(item=>removeRequests(item,key)).filter(item=>item!==undefined);
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,item])=>[name,removeRequests(item,name)]).filter(([,item])=>item!==undefined));
  return value;
}
/** Serves a hashed aggregate only. Private answers, tasks and payloads have no
 * route through this endpoint; no inference module is imported or invoked. */
export async function readStage4Results({resultsDir=root}={}){
  let base;try{base=await realpath(resultsDir);}catch(error){if(error.code==='ENOENT')return null;throw error;}
  let pointer;try{pointer=JSON.parse(await regular(path.join(base,'stage4-latest.json'),base));}catch(error){if(error.code==='ENOENT')return null;throw error;}
  if(pointer.schemaVersion!==1||typeof pointer.directory!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(pointer.directory)||!/^[a-f0-9]{64}$/.test(pointer.reportSha256??''))throw new Error('Invalid published slice report reference');
  const folder=path.join(base,pointer.directory),info=await lstat(folder);if(!info.isDirectory()||info.isSymbolicLink())throw new Error('Slice report directory must be local and regular');
  const resolved=await realpath(folder);if(path.dirname(resolved).toLowerCase()!==base.toLowerCase())throw new Error('Invalid slice report directory');
  const text=await regular(path.join(resolved,'report.json'),resolved);
  if(createHash('sha256').update(text).digest('hex')!==pointer.reportSha256)throw new Error('Slice report hash mismatch');
  const report=JSON.parse(text);
  if(report.schemaVersion!==1||report.kind!=='stage4-slice-report'||report.runId!==pointer.directory||!Array.isArray(report.rows)||!Array.isArray(report.models)||!Array.isArray(report.slices)||report.cloudCalls!==0||report.modelCalls!==0||report.spendUsd!==0||report.tier!=null&&report.tier!==0)throw new Error('Unsupported zero-call slice report');
  return removeRequests(sanitizePublicResult(Object.fromEntries(allowed.filter(key=>Object.hasOwn(report,key)).map(key=>[key,report[key]]))));
}
