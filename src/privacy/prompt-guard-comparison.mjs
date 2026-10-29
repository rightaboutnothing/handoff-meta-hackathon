import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {compileNeutralRequest,extractPrivateTask} from './request-task.mjs';

const threshold=.5;
const proofs=new WeakMap();
const roles='PERSON|COMPANY|AMOUNT|DATE|IDENTIFIER|ADDRESS|PHONE|EMAIL|VALUE|PRODUCT|RECORD';
const rolePattern=new RegExp('\\[(?:'+roles+')\\]','g');
const roleAtomSuffix=new RegExp('\\[(?:'+roles+')\\]$');
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const hardScopeBoundary=/["`<>:{}\\\r\n\u201c\u201d\u2018\u2019\u300c\u300d\u300e\u300f\u00ab\u00bb]/;
const unknownRoles=value=>/[\[\]]/.test(value.replace(rolePattern,''));
const operationBoundary=/(?:^|\b(?:and|then|also|or)\s+)(?:calculate|compute|compare|summarize|summarise|write|draft|explain|find|identify|list|extract|analyze|analyse|provide|select|describe|recommend|create|generate|outline|derive|determine|rank|return|format|answer|respond|use|round)\b/i;
export const PROMPT_GUARD_PROVENANCE_LIMITS=Object.freeze({maxFindings:2048,maxStates:1024,maxValueCharacters:2048});
function scopeBoundary(text){
  if(hardScopeBoundary.test(text))return true;
  for(let index=0;index<text.length;index++)if(text[index]==="'"){
    const left=text[index-1]??'',right=text[index+1]??'';
    if(/[A-Za-z]/.test(left)&&/[A-Za-z]/.test(right))continue;
    const atom=roleAtomSuffix.test(text.slice(Math.max(0,index-16),index));
    const suffixS=/s/i.test(right)&&!/[A-Za-z0-9_]/.test(text[index+2]??'');
    const bare=!/[A-Za-z0-9_]/.test(right);
    if((atom||/[A-Za-z0-9_]/.test(left))&&suffixS)continue;
    if((atom||/[sS]/.test(left))&&bare)continue;
    return true;
  }
  return false;
}
function findingRole(type){
  if(/EMAIL/i.test(type))return'[EMAIL]';if(/PHONE/i.test(type))return'[PHONE]';if(/ADDRESS|POST|ZIP/i.test(type))return'[ADDRESS]';if(/NAME|PERSON/i.test(type))return'[PERSON]';if(/DATE|BIRTH/i.test(type))return'[DATE]';if(/COMPANY|ORGANIZATION/i.test(type))return'[COMPANY]';if(/PRODUCT/i.test(type))return'[PRODUCT]';if(/AMOUNT|COST|SPEND|PRICE/i.test(type))return'[AMOUNT]';if(/ENTITY_VALUE/i.test(type))return'[VALUE]';return'[IDENTIFIER]';
}

/** A proof can account only for literal source clauses and canonical neutral
 * value substitutions. It does not certify their meaning or safety. */
function sourceBoundTask(sourceText,neutralTask,privateValues){
  const actual=extractPrivateTask(sourceText);
  if(!actual||!neutralTask||neutralTask.length>320||neutralTask!==neutralTask.trim()||extractPrivateTask(neutralTask)!==neutralTask)return false;
  // Removing quotes, role boundaries or line structure could change whether
  // copied text is an instruction. Such changes cannot obtain this proof.
  if(scopeBoundary(actual)||scopeBoundary(neutralTask)||unknownRoles(actual)||unknownRoles(neutralTask))return false;
  if(actual===neutralTask)return true;
  const parts=neutralTask.split(new RegExp('(\\[(?:'+roles+')\\])','g'));
  const lower=actual.toLowerCase();if(lower.length!==actual.length||!lower.startsWith(parts[0].toLowerCase()))return false;
  if(privateValues.length>PROMPT_GUARD_PROVENANCE_LIMITS.maxFindings)return false;
  const pools=new Map();
  // A finding may not swallow a clause, quotation or command boundary. The
  // apostrophe check here deliberately remains stricter than the grammar scan:
  // the possessive must stay OUTSIDE the substituted private value.
  const safeValue=value=>value.length>0&&value.length<=PROMPT_GUARD_PROVENANCE_LIMITS.maxValueCharacters&&!/[;!?\r\n:{}<>"`\\]/.test(value)&&!/\.(?:\s|$)/.test(value)&&!/(?<![A-Za-z])'|'(?![A-Za-z])/.test(value)&&!operationBoundary.test(value);
  for(const row of privateValues){
    if(typeof row?.value!=='string'||!safeValue(row.value))continue;
    const normalized=row.value.toLowerCase();if(normalized.length!==row.value.length)continue;
    const marker=findingRole(row.type??'PRIVATE');if(!pools.has(marker))pools.set(marker,new Map());pools.get(marker).set(normalized,row.value);
  }
  const memo=new Map();let states=0,exhausted=false;
  function paths(index,cursor){
    if(exhausted)return 0;
    const key=index+':'+cursor;if(memo.has(key))return memo.get(key);
    if(++states>PROMPT_GUARD_PROVENANCE_LIMITS.maxStates){exhausted=true;return 0;}
    if(index>=parts.length)return cursor===actual.length?1:0;
    const marker=parts[index],anchor=parts[index+1].toLowerCase(),candidates=new Map(pools.get(marker)??[]);
    candidates.set(marker.toLowerCase(),marker);
    // Match the existing numeric masking rule at a source word boundary; do
    // not invent or search for arbitrary replacement spans.
    if(marker==='[VALUE]'&&(cursor===0||!/[A-Za-z0-9_]/.test(actual[cursor-1]))){const numeric=/^\d[\d,.%:/+-]*\b/.exec(actual.slice(cursor))?.[0];if(numeric&&safeValue(numeric))candidates.set(numeric.toLowerCase(),numeric);}
    let count=0;
    for(const [normalized,value]of candidates){
      const end=cursor+value.length;
      if(!lower.startsWith(normalized,cursor)||!lower.startsWith(anchor,end))continue;
      count=Math.min(2,count+paths(index+2,end+anchor.length));
      if(count>1||exhausted)break;
    }
    memo.set(key,count);return count;
  }
  return paths(1,parts[0].length)===1&&!exhausted;
}

/** The boundary creates this only from its actual sanitized task, then binds
 * the object reference into its own preparation proof. JSON copies do not
 * inherit authority. The factory never grants cloud permission. */
export function createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy,privateValues=[]}={}){
  const inputValid=typeof sourceText==='string'&&sourceText.length>0&&sourceText.length<=65536&&typeof question==='string'&&question.length>0&&question.length<=320&&typeof neutralTask==='string'&&neutralTask.length>0&&neutralTask.length<=65536;
  let proofKind='unproved',proofCode='PG_REWRITE_PROVENANCE_UNAVAILABLE';
  if(inputValid){
    if(!Array.isArray(privateValues)||!sourceBoundTask(sourceText,neutralTask,privateValues))proofCode='PG_REWRITE_SOURCE_SCOPE_UNPROVED';
    else if(rewriteStrategy==='preserved_valid_task'&&question===neutralTask){proofKind='preserved';proofCode='PG_REWRITE_EXACT_PRESERVATION';}
    else if(rewriteStrategy==='compiled_neutral_request'){
      const compiled=compileNeutralRequest(neutralTask,{maxCharacters:320});
      if(compiled.eligible&&compiled.question===question){proofKind='compiled';proofCode='PG_REWRITE_EXACT_NEUTRAL_COMPILER';}
      else proofCode='PG_REWRITE_COMPILER_MISMATCH';
    }else proofCode='PG_REWRITE_NOT_MECHANICAL';
  }
  const proof=Object.freeze({schemaVersion:1,sourceHash:typeof sourceText==='string'?hash(sourceText):null,questionHash:typeof question==='string'?hash(question):null,neutralTaskHash:typeof neutralTask==='string'?hash(neutralTask):null,proofKind,proofCode});
  proofs.set(proof,{...proof,inputValid,rewriteStrategy});return proof;
}

function rawMetadata(result,variant){
  const known=['PASS','BLOCKED','PENDING','ERROR'].includes(result?.status),score=Number.isFinite(result?.maxScore)&&result.maxScore>=0&&result.maxScore<=1?result.maxScore:null,windows=Number.isInteger(result?.windows)&&result.windows>0?result.windows:null;
  const configured=result?.threshold===undefined?threshold:result.threshold;
  const available=result?.available===true&&known&&configured===threshold&&score!==null&&windows!==null&&(result.variant===undefined||result.variant===variant)&&['PASS','BLOCKED'].includes(result.status);
  const consistent=available&&result.detected===(score>=threshold)&&result.status===(score>=threshold?'BLOCKED':'PASS');
  const status=consistent?result.status:known&&result.status==='PENDING'?'PENDING':'ERROR';
  const out={status,available:consistent,detected:consistent?result.detected:false,variant,modelId:typeof result?.modelId==='string'&&/^[A-Za-z0-9_./:-]{1,160}$/.test(result.modelId)?result.modelId:'local-prompt-guard',maxScore:score,threshold:configured===threshold?threshold:null,windows,latencyMs:Number.isFinite(result?.latencyMs)&&result.latencyMs>=0?result.latencyMs:0};
  for(const key of ['revision','assetIdentity'])if(typeof result?.[key]==='string'&&/^[a-f0-9]{40,64}$/.test(result[key]))out[key]=result[key];
  for(const key of ['tokenizeMs','inferenceMs','loadMs'])if(Number.isFinite(result?.[key])&&result[key]>=0)out[key]=result[key];
  return out;
}

async function decodedInputs(text,decode){
  if(typeof text!=='string'||!text.length||text.length>65536||typeof decode!=='function')return{texts:typeof text==='string'&&text.length>0&&text.length<=65536?[text]:[],complete:false};
  try{
    const value=await decode(text);if(value===null||typeof value!=='object')return{texts:[text],complete:false};
    const variants=Array.isArray(value)?value:Array.isArray(value.variants)?value.variants:value.decodedVariants;
    if(!Array.isArray(variants))return{texts:[text],complete:false};
    const rows=variants.map(row=>typeof row==='string'?row:row?.text),valid=rows.every(row=>typeof row==='string'&&row.length>0&&row.length<=65536);
    const complete=valid&&!Array.isArray(value)&&Array.isArray(value.issues)&&value.status!=='error'&&value.failClosed===false&&value.limitsExceeded!==true&&!value.issues.some(row=>row?.fatal===true);
    return{texts:[...new Set([text,...rows.filter(row=>typeof row==='string'&&row.length>0&&row.length<=65536)])],complete};
  }catch{return{texts:[text],complete:false};}
}

/** Original and rewritten groups are scored independently at the same locked
 * threshold. A raw rewrite positive is retained even when the explicit
 * comparative policy accounts for a mechanically source-derived question.
 * This helper returns evidence only and cannot issue a release permit. */
export async function screenPromptGuardComparison({sourceText,question,proof,priorBlocked=false}={}, {variant='86m',decode,promptGuard}={}){
  const started=performance.now(),source=await decodedInputs(sourceText,decode),noOutgoingCandidate=question===''&&priorBlocked===true,rewrite=noOutgoingCandidate?{texts:[],complete:true}:await decodedInputs(question,decode),record=proof&&proofs.get(proof),bound=record?.inputValid===true&&record.sourceHash===hash(sourceText)&&record.questionHash===hash(question);
  const call=async(texts,inputKind)=>{
    if(!texts.length||typeof promptGuard!=='function'||!['86m','22m'].includes(variant))return rawMetadata({status:'ERROR'},variant);
    try{return rawMetadata(await promptGuard(texts,{variant,inputKind}),variant);}catch{return rawMetadata({status:'ERROR'},variant);}
  };
  const original=await call(source.texts,'original'),rewritten=noOutgoingCandidate?{status:'NOT_RUN_AFTER_BLOCK',available:false,detected:false,variant,modelId:original.modelId,maxScore:null,threshold,windows:0,latencyMs:0}:await call(rewrite.texts,'rewrite');
  const originalFlagged=original.available&&original.detected,rewriteFlagged=rewritten.available&&rewritten.detected;
  const sourceDerived=bound&&rewrite.texts.length===1&&['preserved','compiled'].includes(record.proofKind),rewriteOnlyFlagCleared=!originalFlagged&&original.available&&source.complete&&rewritten.available&&rewrite.complete&&rewriteFlagged&&sourceDerived;
  let status='PASS',code='PG_BOTH_GROUPS_PASS';
  if(originalFlagged){status='BLOCKED';code='PG_ORIGINAL_FLAGGED';}
  else if(!source.complete||!original.available){status='PENDING';code=source.complete?'PG_ORIGINAL_UNAVAILABLE':'PG_ORIGINAL_DECODE_UNAVAILABLE';}
  else if(noOutgoingCandidate)code='PG_NO_OUTGOING_CANDIDATE';
  else if(!rewrite.complete||!rewritten.available){status='PENDING';code=rewrite.complete?'PG_REWRITE_UNAVAILABLE':'PG_REWRITE_DECODE_UNAVAILABLE';}
  else if(rewriteFlagged&&!sourceDerived){status='BLOCKED';code=bound?'PG_REWRITE_NEW_OR_UNPROVEN_CONTENT':'PG_REWRITE_PROOF_REQUIRED';}
  else if(rewriteOnlyFlagCleared)code='PG_REWRITE_PROVEN_SOURCE_DERIVED';
  const comparison={schemaVersion:1,policy:'source-bound-original-or-new-content-v1',sourceHash:typeof sourceText==='string'?hash(sourceText):null,questionHash:typeof question==='string'?hash(question):null,neutralTaskHash:record?.neutralTaskHash??null,proofKind:bound?record.proofKind:'unproved',proofCode:bound?rewrite.texts.length===1?record.proofCode:'PG_REWRITE_DECODED_SCOPE_UNPROVED':'PG_REWRITE_PROOF_REQUIRED',inputHashes:{original:hash(source.texts),rewrite:hash(rewrite.texts)},original, rewrite:rewritten,originalFlagged,rewriteFlagged,rewriteOnlyFlagCleared,noOutgoingCandidate,sourceDecodeComplete:source.complete,rewriteDecodeComplete:rewrite.complete,code};
  return{status,available:original.available&&(noOutgoingCandidate||rewritten.available)&&source.complete&&rewrite.complete,detected:status==='BLOCKED',rawDetected:originalFlagged||rewriteFlagged,variant,modelId:original.modelId,threshold,windows:(original.windows??0)+(rewritten.windows??0),maxScore:noOutgoingCandidate?original.maxScore:original.maxScore===null||rewritten.maxScore===null?null:Math.max(original.maxScore,rewritten.maxScore),latencyMs:performance.now()-started,comparison};
}
