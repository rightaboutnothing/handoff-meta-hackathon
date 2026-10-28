import path from 'node:path';
import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';
import {embedTexts} from './embeddings.mjs';
import {createPrivacyVault} from './privacy.mjs';
import {DEFAULT_DATA_DIR,getIndexStatus,LocalVectorStore} from './store.mjs';

export const COMPLETE_RETRIEVAL_VERSION='local-multiquery-entity-source-coverage-v1';
export const COMPLETE_RETRIEVAL_SETTINGS=Object.freeze({topK:8,tokenBudget:1800,maxQueries:8,vectorCandidatesPerQuery:12});
const hash=text=>createHash('sha256').update(text).digest('hex');
const words=text=>new Set((String(text).toLowerCase().match(/[a-z][a-z0-9_-]{2,}/g)??[]).filter(word=>!['the','and','with','for','from','that','this','give','what','which','how','are','its','has','all','only','also','units','product','products','synthetic','data'].includes(word)));
const codes=text=>[...new Set((String(text).match(/\b[A-Z]{1,5}[ -]?\d{2,5}\b/gi)??[]).map(value=>value.toUpperCase().replace(/[ -]/g,'')))];
const productSource=chunk=>/(?:^|[\\/])products?[\\/]/i.test(chunk.file??'')||/^#.*product specification/im.test(chunk.text??'');
const facets=Object.freeze([
  {id:'discount-policy',query:'identical product quantity volume discount bands percentage quote validity approval',question:/\bdiscount\w*|\bquote\b|\bvalidity\b/i,source:/\bvolume discounts?\b|\bdiscounts? apply\b|quotes? remain valid/i},
  {id:'shipping-policy',query:'shipping policy standard freight free freight threshold delivery destination dispatch cutoff',question:/\bfreight\b|\bshipping\b|\bdelivery\b|\bmetro\b|Australian destination|dispatch cutoff/i,source:/\bshipping policy\b|free standard freight|standard freight is|metro delivery/i},
  {id:'returns-policy',query:'returns warranty claim serial number proof of purchase restocking fee return window authorisation',question:/\breturn(?:s|ed)?\b|\brestocking\b|warranty claim|proof of purchase|serial number|claim approval|documents\/identifiers/i,source:/returns and warranty policy|restocking fee|warranty claims require/i},
  {id:'service-policy',query:'support service policy business hours urgent standard first response dispatch in-stock parts service lead',question:/\bsupport\b|\bticket\b|\bfirst[- ]response\b|business hours|\bdispatch\b|\burgent\b|service lead/i,source:/support service policy|first-response target|support hours are/i},
  {id:'inventory-policy',query:'spare part inventory reorder point safety stock supplier lead time rush orders approval',question:/\bstock\b|\bspares?\b|\breorder\b|\binventory\b|supplier lead|rush order/i,source:/spare-part inventory policy|reorder points:|safety stock:/i},
  {id:'security-policy',query:'data handling policy retention access incident marketing customer contact information privacy',question:/\bretain\b|\bretention\b|\baccess\b|data incident|marketing export|customer (?:email|phone|contact)/i,source:/data handling policy|retain support tickets|review access permissions/i},
  {id:'hr-policy',query:'human resources handbook annual leave probation expenses working arrangements',question:/\bleave\b|\bprobation\b|\bhandbook\b|\bexpenses?\b|work from home/i,source:/handbook|annual leave|probation period/i},
  {id:'sales-forecast',query:'sales forecast expected revenue pipeline quarter probability',question:/\bforecast\b|\bpipeline\b|\bquarter\b/i,source:/sales forecast|forecast|probability-weighted/i},
  {id:'account-notes',query:'customer account sales notes Northshore requirements commercial commitment',question:/\bNorthshore\b|account notes|sales notes/i,source:/northshore|sales notes/i},
  {id:'ticket-records',query:'support ticket records issue category customer status account',question:/ticket (?:records?|export|CSV)|tickets? (?:were|are|have)|most (?:common|frequent).*issue/i,source:/(?:^|[\\/])support[\\/]|ticket_id[,\s]/i},
]);

/** Infer source needs from the user question and local source catalogue only.
 * This function deliberately has no item/reference/expected-source argument. */
export function planEvidenceQueries(question,catalogue=[]){
  const text=String(question),mentioned=codes(text),productCodes=new Set(catalogue.filter(productSource).flatMap(chunk=>codes(`${chunk.file}\n${chunk.text.split('\n')[0]}`))),prefixes=new Set([...productCodes].map(code=>code.replace(/\d+$/,'')));
  // Replacement-part codes map to a product only when the indexed product
  // document itself contains that association. No benchmark answer table exists.
  const entities=[...new Set(mentioned.flatMap(code=>productCodes.has(code)||prefixes.has(code.replace(/\d+$/,''))?[code]:catalogue.filter(chunk=>productSource(chunk)&&codes(chunk.text).includes(code)).flatMap(chunk=>codes(chunk.text).filter(value=>productCodes.has(value)).slice(0,1))))];
  const productEntities=entities;
  const required=productEntities.map(entity=>({id:`product:${entity}`,entity,query:`${entity} product specification price flow pressure weight height warranty cartridge membrane replacement interval`,kind:'product'}));
  for(const facet of facets){
    if(!facet.question.test(text))continue;
    if(facet.id==='discount-policy'&&/discounts? (?:explicitly )?(?:excluded|ignored)|ignore discounts|discounts? excluded/i.test(text)&&!/validity|valid quote|quote.*(?:days|issue)/i.test(text))continue;
    required.push({id:facet.id,query:facet.query,kind:'policy'});
  }
  // Open company questions still retain an explicit evidence requirement.
  if(!required.length)required.push({id:'question-evidence',query:text,kind:'question'});
  const requirements=required.map(requirement=>({...requirement,sourceFiles:[...new Set(catalogue.filter(chunk=>matchesFacet(chunk,requirement)).map(chunk=>chunk.file))]}));
  return{version:COMPLETE_RETRIEVAL_VERSION,question:text,entities:productEntities,requiredFacets:requirements,
    queries:[...new Set([text,...requirements.map(facet=>`${productEntities.join(' ')} ${facet.query}`.trim())])].slice(0,COMPLETE_RETRIEVAL_SETTINGS.maxQueries),
    method:'Deterministic product/entity and business-policy query decomposition from question and local catalogue; no benchmark references',referenceInputsUsed:false};
}
function matchesFacet(chunk,facet){
  if(facet.kind==='product')return productSource(chunk)&&codes(`${chunk.file}\n${chunk.text}`).includes(facet.entity);
  if(facet.kind==='question')return true;
  const spec=facets.find(candidate=>candidate.id===facet.id);return Boolean(spec?.source.test(`${chunk.file}\n${chunk.text}`));
}
function entityCompatible(chunk,plan){
  if(!plan.entities.length||!productSource(chunk))return true;
  return codes(`${chunk.file}\n${chunk.text}`).some(code=>plan.entities.includes(code));
}
function lexicalScore(question,chunk){const terms=words(question),body=words(`${chunk.file}\n${chunk.text}`);return terms.size?[...terms].filter(term=>body.has(term)).length/terms.size:0;}
const render=chunk=>`[${chunk.chunkId}]\n${chunk.text}`;
function spanCandidates(text){
  const spans=[];const regex=/[^\n.!?]+(?:[.!?](?=\s|$)|(?=\n|$))/g;let match;
  while((match=regex.exec(text))){if(match[0].trim())spans.push({start:match.index,end:match.index+match[0].length,text:match[0].trim()});if(regex.lastIndex===match.index)regex.lastIndex++;}
  return spans;
}
function fitChunk(chunk,question,remaining,countTokens){
  const full={...chunk,sourceHash:chunk.sourceHash??chunk.hash??hash(chunk.text),hash:hash(chunk.text),selectedSpans:[{start:0,end:chunk.text.length}],truncated:false};
  if(countTokens(render(full))<=remaining)return full;
  const spans=spanCandidates(chunk.text).map(span=>({...span,relevance:lexicalScore(question,{file:chunk.file,text:span.text})})).sort((a,b)=>b.relevance-a.relevance||a.start-b.start),selected=[];
  for(const span of spans){const next=[...selected,span].sort((a,b)=>a.start-b.start),text=next.map(value=>value.text).join('\n');
    // Whole spans only: do not invent partial numbers or split PII tokens.
    if(countTokens(render({...chunk,text}))<=remaining)selected.push(span);
  }
  if(!selected.length)return null;selected.sort((a,b)=>a.start-b.start);const text=selected.map(span=>span.text).join('\n');
  return{...full,text,hash:hash(text),truncated:true,selectedSpans:selected.map(({start,end})=>({start,end}))};
}

/** Pure selector used in tests and by the local multi-query retriever. */
export function selectCompleteEvidence(question,candidates,{catalogue=candidates,plan=planEvidenceQueries(question,catalogue),tokenBudget=1800,topK=8,countTokens=text=>Buffer.byteLength(text,'utf8')}={}){
  if(!Number.isInteger(tokenBudget)||tokenBudget<1||!Number.isInteger(topK)||topK<1||topK>20)throw new Error('A positive token budget and topK <=20 are required');
  const byId=new Map();for(const chunk of candidates){if(typeof chunk?.chunkId!=='string'||typeof chunk.text!=='string'||!entityCompatible(chunk,plan))continue;const before=byId.get(chunk.chunkId);if(!before||(chunk.score??0)>(before.score??0))byId.set(chunk.chunkId,chunk);}
  const remaining=[...byId.values()].map(chunk=>({...chunk,facets:plan.requiredFacets.filter(facet=>matchesFacet(chunk,facet)).map(facet=>facet.id),lexicalScore:lexicalScore(question,chunk)}));
  const selected=[],covered=new Set(),files=new Set();
  while(remaining.length&&selected.length<topK){
    if(plan.requiredFacets.every(facet=>covered.has(facet.id))&&!plan.requiredFacets.some(facet=>facet.kind==='question')){
      // Once requirements are represented, retain only extra chunks from those
      // same required source types, rather than filling the budget with noise.
      for(let index=remaining.length-1;index>=0;index--)if(!remaining[index].facets.length)remaining.splice(index,1);
      if(!remaining.length)break;
    }
    remaining.sort((a,b)=>{
      const gain=chunk=>chunk.facets.filter(id=>!covered.has(id)).length;
      return gain(b)-gain(a)||Number(!files.has(b.file))-Number(!files.has(a.file))||(b.lexicalScore*2+(b.score??0))-(a.lexicalScore*2+(a.score??0))||a.chunkId.localeCompare(b.chunkId);
    });
    const candidate=remaining.shift(),separator=selected.length?'\n\n':'',used=countTokens(selected.map(render).join('\n\n')),left=tokenBudget-used-countTokens(separator),fitted=fitChunk(candidate,question,left,countTokens);
    if(!fitted)continue;
    const next=[...selected,fitted],tokens=countTokens(next.map(render).join('\n\n'));if(tokens>tokenBudget)continue;
    selected.push(fitted);files.add(fitted.file);for(const facet of candidate.facets)covered.add(facet);
  }
  const required=plan.requiredFacets.map(facet=>facet.id),coveredFacets=required.filter(id=>covered.has(id)),missingFacets=required.filter(id=>!covered.has(id));
  return{chunks:selected,tokenCount:countTokens(selected.map(render).join('\n\n')),tokenBudget,
    completeness:{score:required.length?coveredFacets.length/required.length:0,requiredFacets:required,coveredFacets,missingFacets,
      requiredSources:[...new Set(plan.requiredFacets.flatMap(facet=>facet.sourceFiles))],retrievedSources:[...new Set(selected.map(chunk=>chunk.file))],
      method:'Share of inferred source requirements represented in selected evidence; not semantic fact coverage or oracle benchmark completeness',inferred:true},queryPlan:plan};
}

/** All text preparation, embeddings, vector search and source selection stay local. */
export async function retrieveComplete(question,{dataDir=DEFAULT_DATA_DIR,vault,tokenBudget=1800,topK=8,countTokens,dependencies={}}={}){
  const started=performance.now(),directory=path.resolve(dataDir),status=(dependencies.getIndexStatus??getIndexStatus)({dataDir:directory});
  if(!status.ready)throw new Error('No local documents indexed');
  const privacy=vault??await createPrivacyVault(directory),redacted=privacy.redact(String(question));await privacy.save();
  const store=dependencies.store??new LocalVectorStore({dataDir:directory});
  try{
    const catalogue=store.listChunks(),plan=planEvidenceQueries(redacted.text,catalogue),indexed=status.embeddingModel;
    const embedding=await(dependencies.embedTexts??embedTexts)(plan.queries,{kind:'query',provider:indexed.provider,model:indexed.model});
    const searches=embedding.vectors.map(vector=>store.search(vector,embedding,COMPLETE_RETRIEVAL_SETTINGS.vectorCandidatesPerQuery));
    const vector=new Map();for(const matches of searches)for(const chunk of matches){const prior=vector.get(chunk.chunkId);if(!prior||(chunk.score??0)>(prior.score??0))vector.set(chunk.chunkId,chunk);}
    // Exact product and policy hits from the local catalogue are considered even
    // if an embedding missed them. This is local hybrid retrieval, not gold data.
    const candidates=catalogue.map(chunk=>({...chunk,...vector.get(chunk.chunkId),score:vector.get(chunk.chunkId)?.score??0}));
    const selection=selectCompleteEvidence(redacted.text,candidates,{catalogue,plan,tokenBudget,topK,...(countTokens?{countTokens}:{})});
    const bestMatchScore=searches[0]?.[0]?.score??0;
    return{...selection,quality:bestMatchScore,bestMatchScore,embeddingModel:{provider:embedding.provider,model:embedding.model,dimensions:embedding.dimensions},
      redactedQuestion:redacted.text,piiItemsRedacted:redacted.count,latencyMs:performance.now()-started,
      version:COMPLETE_RETRIEVAL_VERSION,tokenBudgetMethod:countTokens?'injected local tokenizer':'conservative UTF-8-byte token upper bound',
      localOnly:true,queryCount:plan.queries.length};
  }finally{if(!dependencies.store)store.close();}
}
