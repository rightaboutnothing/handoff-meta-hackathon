import {sha256} from '../rag/receipts.mjs';
import {calculateLocal} from '../rag/calculators.mjs';
import {extractPrivateTask} from './request-task.mjs';

const fail=code=>Object.assign(Error(code),{code});
const normalized=text=>String(text).normalize('NFKC').replace(/\s+/g,' ').trim();
const finite=value=>typeof value==='number'&&Number.isFinite(value)&&Math.abs(value)<=1e12;
const allIds=rows=>[...new Set(rows.map(row=>row.chunkId))];

function evidenceSpans(rows){
  return rows.flatMap(row=>{
    const spans=[];let offset=0;
    while(offset<row.text.length){
      let end=Math.min(row.text.length,offset+400);
      if(end<row.text.length&&/[\uD800-\uDBFF]/.test(row.text[end-1]))end--;
      if(end<row.text.length){const block=row.text.slice(offset,end),boundary=Math.max(block.lastIndexOf('\n'),block.lastIndexOf('. '),block.lastIndexOf('; '),block.lastIndexOf(' '));if(boundary>100)end=offset+boundary+1;}
      const original=row.text.slice(offset,end),text=original.trim();if(text)spans.push({spanId:'span:'+sha256({chunkId:row.chunkId,hash:row.hash,start:offset,end}).slice(0,20),chunkId:row.chunkId,text,sourceHash:row.hash,start:offset,end});offset=end;
    }
    return spans;
  });
}

function objectInText(text){
  const start=text.indexOf('{');if(start<0)return null;let depth=0,quoted=false,escaped=false;
  for(let at=start;at<text.length;at++){const char=text[at];if(quoted){if(escaped)escaped=false;else if(char==='\\')escaped=true;else if(char==='"')quoted=false;continue;}if(char==='"'){quoted=true;continue;}if(char==='{')depth++;if(char==='}'&&--depth===0){try{return{value:JSON.parse(text.slice(start,at+1)),prefix:text.slice(0,start),suffix:text.slice(at+1)};}catch{return null;}}}return null;
}
function unpack(source){
  const task=extractPrivateTask(source);
  const found=objectInText(task);return{question:found?.value?.campaigns?found.prefix+' '+found.suffix:task,data:found?.value??null};
}
function campaignDataInSource(source,depth=0){
  if(depth>4)return null;const found=objectInText(source);if(!found?.value||typeof found.value!=='object')return null;
  if(Array.isArray(found.value.campaigns))return found.value;
  for(const key of ['question','task','prompt','request'])if(typeof found.value[key]==='string'){const nested=campaignDataInSource(found.value[key],depth+1);if(nested)return nested;}
  return null;
}

const queryStop=new Set('a an the what which who when where why how is are was were be been can could should would do does did give provide please tell show quote passage supplied actual local original private fictional synthetic document documents evidence source sources this that these those it its all both requested task question data information using based from with without for of to in on at by as or'.split(' '));
const queryTerms=text=>[...new Set((String(text).normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu)??[]).filter(term=>term.length>1&&!queryStop.has(term)).map(term=>term.replace(/ies$/,'y').replace(/(?<!s)s$/,'')))];

/** Query-only relevance signals, never labels/reference answers. These reorder
 * actual available evidence and detect an obviously irrelevant selection; they
 * cannot prove missing source facts exist or repair absent retrieval. */
export function rankLocalApplicationSpans(context){
  const terms=queryTerms(context.question),sets=new Map(context.spans.map(span=>[span.spanId,new Set(queryTerms(span.text))]));
  const weight=term=>1+Math.log((context.spans.length+1)/(1+[...sets.values()].filter(set=>set.has(term)).length));
  const facets=context.question.split(/\band\b|\bversus\b|\bvs\b|;/i).map(text=>queryTerms(text)).filter(words=>words.length&&context.spans.some(span=>words.some(word=>sets.get(span.spanId).has(word))));
  const requiredFacets=facets.length>1?facets:[],ranked=context.spans.map((span,index)=>{const set=sets.get(span.spanId),matched=terms.filter(term=>set.has(term));return{...span,relevance:{score:matched.reduce((sum,term)=>sum+weight(term),0),matchedQueryTerms:matched.length,facets:requiredFacets.flatMap((facet,id)=>facet.some(term=>set.has(term))?[id]:[]),originalOrder:index}};}).sort((a,b)=>b.relevance.score-a.relevance.score||a.relevance.originalOrder-b.relevance.originalOrder);
  const anchors=[...new Set((context.question.match(/\b(?=[A-Za-z0-9-]*\d)(?=[A-Za-z0-9-]*[A-Za-z])[A-Za-z0-9-]+\b/g)??[]).map(value=>value.toLowerCase()))];
  return{ranked,requiredFacets:requiredFacets.map((facet,id)=>({id,termHashes:facet.map(term=>sha256(term))})),audit:{method:'actual-question lexical coverage and source-bound span ranking; not a semantic fact-coverage certificate',queryTerms:terms.length,queryTermsAvailable:terms.filter(term=>ranked.some(span=>sets.get(span.spanId).has(term))).length,requiredFacets:requiredFacets.length,queryEntityAnchors:anchors.length,missingEntityAnchors:anchors.filter(anchor=>!context.citable.some(row=>row.text.toLowerCase().includes(anchor))).length}};
}

function validateApplicationRelevance(selected,context){
  const plan=rankLocalApplicationSpans(context),selectedIds=new Set(selected.map(span=>span.spanId)),available=plan.ranked.some(span=>span.relevance.score>0),rows=plan.ranked.filter(span=>selectedIds.has(span.spanId));
  if(available&&!rows.some(span=>span.relevance.score>0))throw fail('LOCAL_APPLICATION_RELEVANCE_INVALID');
  const covered=new Set(rows.flatMap(span=>span.relevance.facets)),missing=plan.requiredFacets.filter(facet=>!covered.has(facet.id));
  if(missing.length)throw fail('LOCAL_APPLICATION_RELEVANCE_INVALID');
  return{...plan.audit,selectedQueryTerms:rows.reduce((maximum,row)=>Math.max(maximum,row.relevance.matchedQueryTerms),0),selectedFacets:covered.size};
}

/** Private context only: task values and evidence never enter public logs. */
export function buildLocalApplicationContext(source,localContext=[]){
  if(typeof source!=='string'||!source.trim()||source.length>65536||!Array.isArray(localContext))throw fail('LOCAL_APPLICATION_SOURCE_INVALID');
  const sourceHash=sha256(source),sourceRecordId='local-task:'+sourceHash.slice(0,24),task=unpack(source),seen=new Map();
  const evidence=localContext.map(row=>{
    const chunkId=row?.chunkId??row?.id;if(typeof chunkId!=='string'||!chunkId||typeof row?.text!=='string'||!row.text.trim())throw fail('LOCAL_APPLICATION_EVIDENCE_INVALID');
    const text=row.text,hash=sha256(text);if(seen.has(chunkId)&&seen.get(chunkId)!==hash)throw fail('LOCAL_APPLICATION_EVIDENCE_CONFLICT');seen.set(chunkId,hash);
    return{chunkId,text,hash,...(typeof row.file==='string'?{file:row.file}:{}),...(typeof row.location==='string'?{location:row.location}:{})};
  }).filter((row,index,rows)=>rows.findIndex(other=>other.chunkId===row.chunkId)===index);
  // Request extraction removes the surrounding record export from the task,
  // while the actual hash-bound records are still parsed from the full source.
  const data=task.data??campaignDataInSource(source),records=Array.isArray(data?.campaigns)?data.campaigns:null;
  const taskRecord={chunkId:sourceRecordId,text:source,hash:sourceHash,file:'local-original-task',location:'restored source'};
  const mode=evidence.length?'extractive':records?'record_extract':'general_method';
  const localRecords=records?.map((record,index)=>({chunkId:'local-record:'+sha256({sourceHash,index,record}).slice(0,24),text:JSON.stringify({campaign:record.campaign,spend_usd:record.spend_usd,conversions:record.conversions,cpa_usd:record.cpa_usd}),hash:sha256({sourceHash,index,record}),file:'local-campaign-record',location:'row:'+String(index+1)}));
  const citable=mode==='extractive'?evidence:mode==='record_extract'?localRecords:[taskRecord];
  return{source,sourceHash,sourceRecordId,question:task.question,data,records,evidence,taskRecord,citable,mode,allowedIds:allIds(citable),spans:mode==='general_method'?[]:evidenceSpans(citable)};
}

function campaignTool(context){
  const {records,question}=context;if(!records?.length||records.length>10000)return null;
  const direction=/\b(highest|largest|maximum|most|lowest|smallest|minimum|least)\b/i.exec(question);if(!direction)return null;
  const following=question.slice(direction.index+direction[0].length,direction.index+direction[0].length+80),metric=/\b(cpa|cost\s+per\s+acquisition|spend|conversions)\b/i.exec(following);if(!metric||/[.;?!]/.test(following.slice(0,metric.index)))return null;
  if(/\b(?:under|below|above|between|where|except|exclude|weighted|average|median|sum|total|forecast|predict|growth|trend)\b/i.test(question))return null;
  const field=/cpa|cost/i.test(metric[1])?'cpa_usd':/^spend$/i.test(metric[1])?'spend_usd':'conversions',maximum=/highest|largest|maximum|most/i.test(direction[1]);
  const rows=records.map((row,index)=>{
    if(!row||typeof row.campaign!=='string'||!row.campaign.trim()||row.campaign.length>256||!finite(row.spend_usd)||row.spend_usd<0||!Number.isInteger(row.conversions)||row.conversions<0||!finite(row.cpa_usd)||row.cpa_usd<0)throw fail('LOCAL_ANALYTICS_DATA_INVALID');
    return{index,campaign:row.campaign,spend_usd:row.spend_usd,conversions:row.conversions,cpa_usd:row.cpa_usd};
  });
  const extreme=(maximum?Math.max:Math.min)(...rows.map(row=>row[field])),matching=rows.filter(row=>row[field]===extreme);if(matching.length!==1)return null;
  const selected=matching[0],answerValue={campaign:selected.campaign,spend_usd:selected.spend_usd,conversions:selected.conversions,cpa_usd:selected.cpa_usd},operation=(maximum?'maximum:':'minimum:')+field;
  const trace={version:'local-campaign-extreme-v1',operation,sourceHash:context.sourceHash,sourceRecordId:context.sourceRecordId,recordHashes:context.citable.map(row=>row.hash),selectedIndex:selected.index,selectedRecordHash:context.citable[selected.index].hash,resultHash:sha256(answerValue)},traceHash=sha256(trace),toolId='calc:'+traceHash.slice(0,32);
  return{method:'deterministic_campaign_analytics',answer:JSON.stringify(answerValue),citations:[toolId,context.citable[selected.index].chunkId],audit:{supported:true,claims:4,method:'exact fields selected by an explicit extrema query over actual local records'},calculator:{status:'computed',toolId,traceHash,sourceChunkIds:context.citable.map(row=>row.chunkId),sourceHashes:context.citable.map(row=>({chunkId:row.chunkId,hash:row.hash})),operation,resultHash:sha256(answerValue)},toolId};
}

export function computeLocalApplication(context){
  const campaigns=campaignTool(context);if(campaigns)return campaigns;
  if(context.evidence.length){
    const result=calculateLocal(context.question,context.evidence);
    if(result.status==='computed'&&result.complete===true&&result.calculations.length&&result.sourceChunkIds.every(id=>context.evidence.some(row=>row.chunkId===id))){
      return{method:'deterministic_company_calculator',answer:result.answerText,citations:[...new Set(result.citations)],audit:{supported:true,claims:result.claims.length,method:'allowlisted deterministic arithmetic with actual question operands and retrieved evidence'},calculator:{status:result.status,toolId:result.toolId,traceHash:result.traceHash,sourceChunkIds:result.sourceChunkIds,sourceHashes:context.evidence.filter(row=>result.sourceChunkIds.includes(row.chunkId)).map(row=>({chunkId:row.chunkId,hash:row.hash})),operation:result.arithmeticIntent,resultHash:sha256(result.answerText)}};
    }
  }
  return null;
}

export function localApplicationSchema(context){
  const min=context.mode==='general_method'?0:1;
  if(context.mode!=='general_method'&&!context.spans.length)throw fail('LOCAL_APPLICATION_NO_BOUNDED_EXCERPT');
  return{type:'object',additionalProperties:false,properties:{answer:context.mode==='general_method'?{type:'string',minLength:1,maxLength:2400}:{type:'array',minItems:1,maxItems:Math.min(8,context.spans.length),uniqueItems:true,items:{type:'string',enum:context.spans.map(row=>row.spanId)}},citations:{type:'array',minItems:min,maxItems:Math.min(8,context.allowedIds.length),uniqueItems:true,items:{type:'string',enum:context.allowedIds}}},required:['answer','citations']};
}

export function validateLocalApplication(value,context){
  if(!value||!Array.isArray(value.citations)||value.citations.some(id=>typeof id!=='string')||Object.keys(value).sort().join(',')!=='answer,citations')throw fail('LOCAL_APPLICATION_INVALID');
  const citations=[...new Set(value.citations)];if(citations.some(id=>!context.allowedIds.includes(id)))throw fail('LOCAL_APPLICATION_CITATION_INVALID');
  if(Array.isArray(value.answer)){
    if(context.mode==='general_method'||!value.answer.length||value.answer.length>8||value.answer.some(id=>typeof id!=='string')||new Set(value.answer).size!==value.answer.length)throw fail('LOCAL_APPLICATION_INVALID');
    const selected=value.answer.map(id=>context.spans.find(row=>row.spanId===id));if(selected.some(row=>!row))throw fail('LOCAL_APPLICATION_SUPPORT_INVALID');
    const actual=[...new Set(selected.map(row=>row.chunkId))];if(actual.length!==citations.length||actual.some(id=>!citations.includes(id)))throw fail('LOCAL_APPLICATION_CITATION_INVALID');
    const relevance=validateApplicationRelevance(selected,context);
    return{answer:selected.map(row=>row.text).join('\n'),citations,audit:{supported:true,claims:selected.length,method:'code renders selected hash-bound source spans; the model emits only enumerated pointers and cannot generate factual text',claimHashes:selected.map(row=>sha256(row.text)),selectedSpanIds:selected.map(row=>row.spanId),relevance}};
  }
  if(typeof value.answer!=='string'||!value.answer.trim())throw fail('LOCAL_APPLICATION_INVALID');
  if(context.mode==='general_method')return{answer:value.answer.trim(),citations,audit:{supported:true,claims:null,method:'general method answer; no private-data factual claim certificate'}};
  if(!citations.length)throw fail('LOCAL_APPLICATION_CITATION_MISSING');
  const cited=context.citable.filter(row=>citations.includes(row.chunkId)),used=new Set(),parts=value.answer.split(/\n+/).map(part=>part.replace(/^\s*[-*]\s+|^\s*\d+[.)]\s+/,'').replace(/\[cite:\s*[^\]]+\]/g,'').replace(/^["“]|["”]$/g,'').trim()).filter(Boolean);
  if(!parts.length)throw fail('LOCAL_APPLICATION_SUPPORT_INVALID');
  for(const part of parts){const quote=normalized(part),matches=cited.filter(row=>normalized(row.text).includes(quote));if(quote.length<3||!matches.length)throw fail('LOCAL_APPLICATION_SUPPORT_INVALID');matches.forEach(row=>used.add(row.chunkId));}
  if(citations.some(id=>!used.has(id)))throw fail('LOCAL_APPLICATION_SUPPORT_INVALID');
  return{answer:value.answer.trim(),citations,audit:{supported:true,claims:parts.length,method:'each returned excerpt is present verbatim modulo whitespace in its cited actual local evidence',claimHashes:parts.map(text=>sha256(text))}};
}

export function localApplicationMessages(context,{abstractQuestion,guidance,repairCode}={}){
  const relevance=rankLocalApplicationSpans(context);
  return[
    {role:'system',content:context.mode==='general_method'?'Answer the original private task using the checked general guidance. Return compact answer and citations JSON. Use only the enumerated citation IDs; citations may be empty for a general method. Do not invent private facts.': 'Answer the original private task by SELECTING the actual LOCAL EVIDENCE spans needed. Return answer as an array of spanId pointers, not generated prose, and citations as the unique chunkId values of those selected spans. Select every span needed for all requested facts, across documents when necessary. For a request to quote an entire passage, select all its consecutive spans. Use only enumerated IDs. Code will render the selected source text locally. Never invent an ID or factual text, paraphrase, calculate unsupported results, or repeat the generic method. All source data remains local.'},
    {role:'user',content:JSON.stringify({applicationMode:context.mode,task:context.question,evidence:relevance.ranked,sourceCoverage:relevance.audit,requiredFacets:relevance.requiredFacets,allowedCitationIds:context.allowedIds,allowedSpanIds:context.spans.map(row=>row.spanId),abstractQuestion,generalGuidance:guidance,...(repairCode?{repair:{code:repairCode,instruction:'The previous local attempt failed validation. Select valid source span pointers and their actual chunk IDs from the same evidence; cover the actual question facets present in evidence; do not fabricate, omit unsupported citation errors, or change the question.'}}:{})})},
  ];
}

/** Transport ceiling only, not a guessed tokenizer. Returned Ollama input usage
 * and truncation metadata are independently checked before accepting output. */
export function assertLocalApplicationInputBudget(messages){
  const bytes=Buffer.byteLength(JSON.stringify(messages),'utf8');if(bytes>16384)throw fail('LOCAL_APPLICATION_CONTEXT_BUDGET');return{bytes,maximumBytes:16384};
}
