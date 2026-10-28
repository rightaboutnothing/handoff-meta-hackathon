import {readFile} from 'node:fs/promises';
import {evaluateAcceptanceGate,extractAcceptanceFeatures} from '../comparison/acceptance-gates.mjs';
import {applyRiskCalibrator} from '../comparison/risk-calibration.mjs';
import {isCloudEligible} from '../comparison/policy.mjs';
import {validateCitations} from '../comparison/citations.mjs';
import {sha256} from './receipts.mjs';

export const LOCKED_COMPANY_MODEL='gemma3:12b';
export const LOCKED_POLICY_HASH='a1c9b90667b1f70bceaa4291e5660591c1edfec6223afdf41739828e8c2aad77';
const file=new URL('../../results/2026-10-28-stage3-dev-risk-calibration/policy.json',import.meta.url);
const companyCategory=category=>/^company-data(?:[ -]|$)/.test(String(category??''));
const terms=text=>new Set((String(text).toLowerCase().replace(/([a-z]{1,5})[- ]?(\d{2,5})/gi,'$1$2').match(/[a-z0-9]{3,}/g)??[]).filter(word=>!['the','and','for','what','which','how','are','does','that','this','with','from','our','your','their','have','company','synthetic','please','give','question','answer'].includes(word)));

export function validateLockedPolicy(document){
  if(document?.policyHash!==LOCKED_POLICY_HASH||document.lock?.policyHash!==LOCKED_POLICY_HASH||sha256(document.calibration)!==LOCKED_POLICY_HASH)throw new Error('Stage 3 locked policy integrity check failed');
  const calibration=document.calibration;
  for(const modelId of ['llama3.1:8b','gemma3:4b','gemma3:12b'])for(const slice of ['company','general']){
    const policy=calibration.models?.[modelId]?.slices?.[slice];
    if(!policy||policy.futureCertified!==false)throw new Error('Locked policy has an unsupported model or certificate scope');
    if(modelId===LOCKED_COMPANY_MODEL&&slice==='company'){
      if(!policy.certifiedFiniteFrame||!(policy.threshold>0)||policy.certificate.upperRisk>.05)throw new Error('Locked company policy is not certified for its fixed dev frame');
    }else if(policy.threshold!==0||policy.certifiedFiniteFrame!==false)throw new Error('Abstaining Stage 3 model/slice policy changed');
  }
  return calibration;
}
export async function loadLockedPolicy(){return validateLockedPolicy(JSON.parse(await readFile(file,'utf8')));}

/** Runtime task type comes from the local source catalogue and question overlap,
 * never from browser-supplied routing labels or benchmark references. Ambiguous
 * questions abstain. Trusted metadata can restrict safety, never override it. */
export function inferGatewayTask(question,retrieval,{id='live-question',localOnly=false,task}={}){
  if(task){
    const restricted=localOnly||!isCloudEligible(task);
    return{...task,id:task.id??id,safety:restricted?{kind:'local-only',cloudEligible:false}:task.safety,localOnly:restricted,classificationMethod:'trusted server task metadata; safety restrictions preserved'};
  }
  const chunks=(retrieval?.chunks??[]).filter(chunk=>chunk.verifiedLocalTool!==true),query=terms(question),body=terms(chunks.map(chunk=>`${chunk.file??''} ${chunk.text??''}`).join('\n'));
  const overlap=[...query].filter(term=>body.has(term)),plan=retrieval?.queryPlan;
  const entities=plan?.entities??[];
  const entityMatch=entities.some(entity=>query.has(String(entity).toLowerCase().replace(/[ -]/g,''))&&body.has(String(entity).toLowerCase().replace(/[ -]/g,'')));
  const businessIntent=/\b(?:our|company|business|polic(?:y|ies)|handbook|employee|customer|warranty|freight|shipping|stock|spare|supplier|support|ticket|sales|quote|invoice|purchase|probation|leave|reorder|return|product)\b/i.test(question);
  const sourceRequirement=(plan?.requiredFacets??[]).some(facet=>facet.kind==='product'||facet.kind==='policy'||facet.id&&facet.id!=='question-evidence');
  const company=chunks.length>0&&(entityMatch||businessIntent&&overlap.length>=2&&(sourceRequirement||overlap.length>=3));
  const requiredSources=retrieval?.completeness?.requiredSources??(plan?.requiredFacets??[]).flatMap(facet=>facet.sourceFiles??[]);
  const requiredCount=new Set(requiredSources.length?requiredSources:chunks.map(chunk=>chunk.file).filter(Boolean)).size;
  const category=company?(requiredCount>1?'company-data multi-doc':'company-data single-doc'):'knowledge';
  return{id,category,suite:company?'company-rag':'live-general',safety:{kind:localOnly?'local-only':'safe',cloudEligible:!localOnly},localOnly,
    classificationMethod:'local entity/business-policy evidence overlap; ambiguous/general questions abstain',companyInferred:company,evidenceTermOverlap:overlap.length};
}

export function decideLockedRoute(item,generated,prepared,calibration,{modelId=LOCKED_COMPANY_MODEL}={}){
  if(sha256(calibration)!==LOCKED_POLICY_HASH)throw new Error('Only the exact locked Stage 3 thresholds and rankers may route live answers');
  const row={modelId,category:item.category,answer:generated.answer,rawAnswer:generated.rawAnswer,rawCheck:generated.rawCheck};
  const gate=evaluateAcceptanceGate(item,row,prepared),features=extractAcceptanceFeatures(item,row,prepared,gate);
  const decision=applyRiskCalibrator(calibration,{...row,gate,features});
  if(!companyCategory(item.category)&&decision.route!=='local_only_safety')return{...decision,route:'escalate',accepted:false,reason:'Locked general policy abstains; a redacted Guard pass is required',gate,features,policyHash:LOCKED_POLICY_HASH};
  return{...decision,gate,features,policyHash:LOCKED_POLICY_HASH};
}

/** General tasks have no accepted local route in the locked policy. Skip model
 * generation instead of creating a draft that would be discarded. */
export function skippedGeneralAnswer(prepared){
  const citationAudit=validateCitations([],{chunks:[]},{requireCitations:false}),selfCheck={confidence:0,evidenceSupported:false,answerComplete:false,issues:['incomplete_answer'],parseValid:true};
  const raw={modelId:'code-policy-abstention',text:'',tokens:{input:0,output:0,total:0},latencyMs:0,settings:{maxTokens:768},doneReason:'not_generated'};
  return{version:'locked-general-abstention-v1',generationSkipped:true,stages:[],rawAnswer:raw,rawCheck:{...raw,settings:{maxTokens:128}},answer:{answer:'A safe cloud handoff is required by the locked general policy.',renderedAnswer:'A safe cloud handoff is required by the locked general policy.',citations:[],citationAudit,confidence:0,parseValid:true,selfCheckParseValid:true,selfCheck,needsCloud:true,features:{confidence:0,retrievalScore:prepared.retrievalScore??0,hasValidCitations:false,sourceDocCount:0,citationCount:0,needsCloud:true},routingSource:'locked-general-policy-abstention'}};
}
