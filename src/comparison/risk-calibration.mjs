import {createHash} from 'node:crypto';
import {bootstrapEstimate,mean,percentile,wilsonInterval} from './metrics.mjs';

export const RISK_CALIBRATION_VERSION='slice-finite-dev-frame-risk-v1';
export const ACCEPTANCE_SLICES=Object.freeze(['company','general']);
export const RISK_FEATURE_NAMES=Object.freeze(['confidence','retrievalScore','evidenceCompleteness','evidenceCompletenessApplicable','logSourceDocCount','hasValidCitations','logCitationCount','claimCoverage','claimCoverageApplicable','calculatorVerified','logAnswerTokens','logSelfCheckTokens','answerCapFraction','selfCheckCapFraction','logAnswerCharacterCount','needsCloud',
  'category:company-data single-doc','category:company-data multi-doc','category:reasoning','category:knowledge','category:instruction-following','category:safety-boundary','category:privacy']);
const hash=value=>createHash('sha256').update(JSON.stringify(value)).digest('hex');
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const numeric=value=>typeof value==='boolean'?Number(value):finite(value)?value:0;
const clamp=value=>Math.max(0,Math.min(1,numeric(value)));
const sigmoid=value=>value>=0?1/(1+Math.exp(-value)):Math.exp(value)/(1+Math.exp(value));
const dot=(a,b)=>a.reduce((sum,value,index)=>sum+value*b[index],0);
const categories=RISK_FEATURE_NAMES.filter(name=>name.startsWith('category:')).map(name=>name.slice(9));
export function acceptanceSlice(row){
  const category=row.category??row.features?.category,derived=String(category??'').startsWith('company-data')?'company':'general',explicit=row.slice??row.features?.slice;
  if(explicit!=null&&!ACCEPTANCE_SLICES.includes(explicit))throw new Error('Unknown acceptance slice');
  if(category&&explicit&&explicit!==derived)throw new Error('Acceptance slice conflicts with runtime task category');
  return explicit??derived;
}
export function riskFeatureVector(row){
  const f=row.features??row,category=row.category??f.category;
  return[clamp(f.confidence),clamp(f.retrievalScore),clamp(f.evidenceCompleteness),numeric(f.evidenceCompletenessApplicable),Math.log1p(Math.max(0,numeric(f.sourceDocCount))),numeric(f.hasValidCitations),Math.log1p(Math.max(0,numeric(f.citationCount))),clamp(f.claimCoverage),numeric(f.claimCoverageApplicable),numeric(f.calculatorVerified),Math.log1p(Math.max(0,numeric(f.answerTokens))),Math.log1p(Math.max(0,numeric(f.selfCheckTokens))),clamp(f.answerCapFraction),clamp(f.selfCheckCapFraction),Math.log1p(Math.max(0,numeric(f.answerCharacterCount))),numeric(f.needsCloud),...categories.map(value=>Number(category===value))];
}
export function knownWrongness(row){
  if(row.error||row.scoring?.labelAvailable===false||!finite(row.scoring?.score)||row.scoring.score<0||row.scoring.score>1)return null;
  return Number(row.scoring.score<1);
}
const conservativeWrongness=row=>knownWrongness(row)??1;
const eligible=row=>row.gate?.eligible===true&&row.gate?.localOnly!==true;
function fitRanker(rows,{iterations=500,learningRate=.08,l2=.02}={}){
  const xs=rows.map(riskFeatureVector),ys=rows.map(conservativeWrongness),d=RISK_FEATURE_NAMES.length;
  const means=Array.from({length:d},(_,i)=>mean(xs.map(x=>x[i]))??0),scales=means.map((m,i)=>Math.max(.1,Math.sqrt(mean(xs.map(x=>(x[i]-m)**2))??0))),normalized=xs.map(x=>x.map((v,i)=>(v-means[i])/scales[i]));
  const prior=(ys.reduce((a,b)=>a+b,0)+.5)/(rows.length+1),weights=Array(d).fill(0);let intercept=Math.log(prior/(1-prior));
  for(let iteration=0;iteration<iterations&&rows.length;iteration++){
    let gi=0;const gradient=Array(d).fill(0);
    for(let r=0;r<rows.length;r++){const error=sigmoid(intercept+dot(weights,normalized[r]))-ys[r];gi+=error;for(let c=0;c<d;c++)gradient[c]+=error*normalized[r][c];}
    intercept-=learningRate*gi/rows.length;for(let c=0;c<d;c++)weights[c]-=learningRate*(gradient[c]/rows.length+l2*weights[c]);
  }
  return{intercept,weights,means,scales,prior,iterations,learningRate,l2,rows:rows.length,unknownLabels:rows.filter(r=>knownWrongness(r)==null).length};
}
export function predictAcceptanceWrongness(ranker,row){const raw=riskFeatureVector(row);return sigmoid(ranker.intercept+dot(ranker.weights,raw.map((v,i)=>(v-ranker.means[i])/ranker.scales[i])));}

const logFactorial=[0];
function logChoose(n,k){if(k<0||k>n)return-Infinity;for(let i=logFactorial.length;i<=n;i++)logFactorial[i]=logFactorial[i-1]+Math.log(i);return logFactorial[n]-logFactorial[k]-logFactorial[n-k];}
/** P(X<=observed), X~Hypergeom(population,totalWrong,sampled), evaluated in log space. */
export function hypergeometricLowerTail(population,totalWrong,sampled,observed){
  for(const value of[population,totalWrong,sampled,observed])if(!Number.isInteger(value)||value<0)throw new Error('Hypergeometric counts must be nonnegative integers');
  if(totalWrong>population||sampled>population||observed>sampled)throw new Error('Invalid hypergeometric counts');
  const first=Math.max(0,sampled-(population-totalWrong)),last=Math.min(observed,sampled,totalWrong);if(first>last)return 0;
  const terms=[];for(let j=first;j<=last;j++)terms.push(logChoose(totalWrong,j)+logChoose(population-totalWrong,sampled-j)-logChoose(population,sampled));
  const max=Math.max(...terms);return Math.max(0,Math.min(1,Math.exp(max)*terms.reduce((sum,value)=>sum+Math.exp(value-max),0)));
}
/** Exact one-sided finite-population confidence bound by test inversion.
 * Assumes sampled is a simple random sample without replacement from the fixed
 * accepted frame. Fixed, correlated binary labels do not require item IID. */
export function finiteFrameUpperBound({population,sampled,wrong,alpha=.05}){
  if(!Number.isInteger(population)||!Number.isInteger(sampled)||!Number.isInteger(wrong)||population<0||sampled<0||sampled>population||wrong<0||wrong>sampled||!(alpha>0&&alpha<1))throw new Error('Invalid finite-frame risk counts or alpha');
  if(!population)return{population,sampled,wrong,upperWrong:null,upperRisk:null,confidence:1-alpha,method:'exact hypergeometric test inversion',status:'NO_ACCEPTED_FRAME'};
  let low=wrong,high=population-sampled+wrong;
  while(low<high){const mid=Math.ceil((low+high)/2);if(hypergeometricLowerTail(population,mid,sampled,wrong)>alpha)low=mid;else high=mid-1;}
  const remaining=population-sampled,unseenUpper=Math.min(remaining,low-wrong);
  return{population,sampled,wrong,upperWrong:low,upperRisk:low/population,confidence:1-alpha,alpha,
    unsampled:{items:remaining,upperWrong:unseenUpper,upperRisk:remaining?unseenUpper/remaining:null},
    method:'exact hypergeometric lower-tail test inversion for a fixed dev frame',status:sampled?'MEASURED':'UNSAMPLED',
    assumptions:['The candidate policy is fixed without calibration/audit labels.','Calibration items are selected by the predeclared uniform item randomization, independently of the fixed answer/error values.','Conditional on the accepted-frame size and accepted calibration count, accepted calibration items are a simple random sample without replacement.'],
    scope:'Accepted CALIB+AUDIT dev items only; not FIT/SELECT, final test, future questions or unseen source families',futureCertified:false};
}

function candidateFromSelection(ranker,rows,{selectionRiskBudget=.025,minSelectionAccepted=3}={}){
  const predictions=rows.filter(eligible).map(row=>({row,p:predictAcceptanceWrongness(ranker,row)})),thresholds=[...new Set([0,1+Number.EPSILON,...predictions.map(({p})=>Math.min(1+Number.EPSILON,p+1e-12))])].sort((a,b)=>a-b);
  let best={threshold:0,accepted:0,wrong:0,unknown:0,empiricalRisk:null,status:'NO_SELECT_CANDIDATE'};
  for(const threshold of thresholds){const accepted=predictions.filter(({p})=>p<threshold),wrong=accepted.reduce((sum,{row})=>sum+conservativeWrongness(row),0);if(accepted.length>=minSelectionAccepted&&wrong/accepted.length<=selectionRiskBudget&&(accepted.length>best.accepted||accepted.length===best.accepted&&threshold<best.threshold))best={threshold,accepted:accepted.length,wrong,unknown:accepted.filter(({row})=>knownWrongness(row)==null).length,empiricalRisk:wrong/accepted.length,status:'SELECTED_ON_SELECT_ONLY'};}
  return{...best,selectionRiskBudget,minSelectionAccepted,selectionItems:rows.length,selectionEligible:predictions.length,thresholdComparison:'predicted wrongness < threshold',labelsUsed:'SELECT only; calibration/audit labels never select or revise this candidate'};
}
function descriptives(rows,{seed,replicates}){
  const labelled=rows.filter(row=>knownWrongness(row)!=null),unknown=rows.length-labelled.length,wrong=labelled.reduce((sum,row)=>sum+knownWrongness(row),0);
  return{items:rows.length,labelled:labelled.length,unknown,wrong,accuracy:labelled.length?1-wrong/labelled.length:null,
    accuracyWilson95:labelled.length?wilsonInterval(labelled.length-wrong,labelled.length):null,
    clusterBootstrapAccuracy:bootstrapEstimate(labelled,sample=>mean(sample.map(row=>1-knownWrongness(row))),{seed,replicates}),
    conservativeErrorRate:rows.length?(wrong+unknown)/rows.length:null,sourceGroups:new Set(rows.map(row=>row.groupId??row.id)).size,
    intervalCaveat:'Wilson assumes item independence and is a sensitivity interval only. Source-group bootstrap is descriptive with few/template groups and can degenerate at zero observed errors; neither is the finite-frame certificate.'};
}
const roleFor=(roles,id)=>roles instanceof Map?roles.get(id):roles?.[id];
function validateRows(rows,modelIds,rolesById,manifest){
  if(!Array.isArray(rows)||!rows.length||!Array.isArray(modelIds)||!modelIds.length||new Set(modelIds).size!==modelIds.length)throw new Error('Explicit dev rows and distinct model IDs are required');
  const devIds=manifest?.devTrainIDs??manifest?.devIds,seen=new Set(),allowed=devIds?new Set(devIds):null;
  for(const row of rows){if(!['dev','dev-train'].includes(row.split))throw new Error('Risk calibration accepts dev-training rows only, never test or dev-selection rows');if(!modelIds.includes(row.modelId))throw new Error('Unregistered model in risk calibration');if(allowed&&!allowed.has(row.id))throw new Error('Row is outside the fixed dev-training manifest');if(!['fit','select','calib','audit'].includes(roleFor(rolesById,row.id)))throw new Error('Every dev item needs a predeclared fit/select/calib/audit role');const k=`${row.modelId}|${row.id}`;if(seen.has(k))throw new Error('Duplicate dev model/item row');seen.add(k);acceptanceSlice(row);}
  if(allowed)for(const modelId of modelIds)for(const id of allowed)if(!seen.has(`${modelId}|${id}`))throw new Error('Full dev frame is incomplete; missing answers must be represented as explicit error rows');
}
/** All 820 dev items take exactly one declared role. Learning uses FIT labels,
 * threshold choice uses SELECT labels, the single frozen policy is certified
 * once on CALIB, and AUDIT labels are reporting only. */
export function fitSliceCalibrators(rows,{modelIds,rolesById,seed=20261027,errorBudget=.05,alpha=.05,selectionRiskBudget=errorBudget/2,minSelectionAccepted=3,manifest,replicates=2000,iterations=500,learningRate=.08,l2=.02}={}){
  if(!(errorBudget>0&&errorBudget<1)||!(alpha>0&&alpha<1)||!(selectionRiskBudget>=0&&selectionRiskBudget<=errorBudget))throw new Error('Invalid declared risk budget or confidence level');validateRows(rows,modelIds,rolesById,manifest);
  const perPolicyAlpha=alpha/(modelIds.length*ACCEPTANCE_SLICES.length),models={};
  for(const modelId of modelIds){const slices={};for(const slice of ACCEPTANCE_SLICES){
    const selected=rows.filter(row=>row.modelId===modelId&&acceptanceSlice(row)===slice),parts=Object.fromEntries(['fit','select','calib','audit'].map(role=>[role,selected.filter(row=>roleFor(rolesById,row.id)===role)]));
    const fitRows=parts.fit.filter(row=>eligible(row)&&knownWrongness(row)!=null),ranker=fitRanker(fitRows,{iterations,learningRate,l2}),candidate=candidateFromSelection(ranker,parts.select,{selectionRiskBudget,minSelectionAccepted});
    const candidateAccepts=row=>eligible(row)&&predictAcceptanceWrongness(ranker,row)<candidate.threshold;
    const frozenPolicy={version:RISK_CALIBRATION_VERSION,modelId,slice,ranker,candidateThreshold:candidate.threshold,selection:candidate},candidateHash=hash(frozenPolicy);
    const frame=[...parts.calib,...parts.audit].filter(candidateAccepts),calibration=parts.calib.filter(candidateAccepts),wrong=calibration.reduce((sum,row)=>sum+conservativeWrongness(row),0);
    const certificate=finiteFrameUpperBound({population:frame.length,sampled:calibration.length,wrong,alpha:perPolicyAlpha});
    const certified=candidate.accepted>=minSelectionAccepted&&certificate.upperRisk!=null&&certificate.upperRisk<=errorBudget;
    const acceptedAudit=certified?parts.audit.filter(candidateAccepts):[],acceptedFrame=certified?frame:[];
    slices[slice]={...frozenPolicy,candidateHash,threshold:certified?candidate.threshold:0,status:certified?'CERTIFIED_FINITE_DEV_FRAME':'ABSTAIN_UNCERTIFIED',certifiedFiniteFrame:certified,futureCertified:false,
      errorBudget,certificate:{...certificate,familywiseAlpha:alpha,policyCount:modelIds.length*ACCEPTANCE_SLICES.length,bonferroniAlpha:perPolicyAlpha,certified},
      roles:Object.fromEntries(Object.entries(parts).map(([role,part])=>[role,{items:part.length,eligible:part.filter(eligible).length,sourceGroups:new Set(part.map(row=>row.groupId??row.id)).size,ids:part.map(row=>row.id)}])),
      calibration:{accepted:calibration.length,wrong,unknown:calibration.filter(row=>knownWrongness(row)==null).length,conservativeRisk:calibration.length?wrong/calibration.length:null},
      audit:{...descriptives(acceptedAudit,{seed,replicates}),total:parts.audit.length,eligible:parts.audit.filter(eligible).length,acceptanceRate:parts.audit.length?acceptedAudit.length/parts.audit.length:null,role:'AUDIT labels used only after candidate and certificate decision were fixed',finiteBoundForUnsampled:certificate.unsampled??null},
      frame:{...descriptives(acceptedFrame,{seed,replicates}),total:parts.calib.length+parts.audit.length,acceptanceRate:parts.calib.length+parts.audit.length?acceptedFrame.length/(parts.calib.length+parts.audit.length):null},
      independence:{companySourceGroups:slice==='company'?new Set(selected.map(row=>row.groupId??row.id)).size:null,itemRolesShareSourceGroups:true,interpretation:'The finite dev-frame randomization bound permits fixed correlated labels. It is not a source-family-IID or future-population guarantee; group bootstrap is descriptive only.'},
      fitting:{eligible:parts.fit.filter(eligible).length,labelled:fitRows.length,excludedUnknown:parts.fit.filter(row=>eligible(row)&&knownWrongness(row)==null).length,labelsUsed:'FIT only'},
      labelPolicy:'Full credit is correct. Missing/unsupported labels are excluded from FIT and conservatively counted as errors in SELECT and certification, while reported as unknown rather than measured failures.',
      fitDataHash:hash(fitRows.map(row=>[row.id,conservativeWrongness(row),riskFeatureVector(row)])),selectionDataHash:hash(parts.select.map(row=>[row.id,conservativeWrongness(row),riskFeatureVector(row)])),
      warning:certified?'Certification applies only to the fixed accepted CALIB+AUDIT dev frame. Final-test replay must not tune this policy.':'The sole preselected candidate did not meet the finite-frame upper risk budget; abstention is retained without testing another threshold on calibration labels.'};
  }models[modelId]={modelId,slices};}
  return{version:RISK_CALIBRATION_VERSION,seed,errorBudget,alpha,models,modelIds:[...modelIds],featureNames:[...RISK_FEATURE_NAMES],policySelection:'One independent SELECT-chosen candidate per model/slice; no second threshold after calibration failure',rolePolicy:'40% FIT / 10% SELECT / 40% CALIB / 10% AUDIT, predeclared random items within slice',
    unknownLabelsConservative:true,futureCertified:false,finalTestLabelsUsed:false,references:[{title:'Exact confidence intervals by inversion for finite populations',url:'https://www.tandfonline.com/doi/abs/10.1080/00031305.1987.10475484'},{title:'Hypergeometric Distribution Revisited: fixed binary populations sampled without replacement',url:'https://arxiv.org/abs/2405.06722'}],
    dataHash:hash(rows.map(row=>[row.id,row.modelId,roleFor(rolesById,row.id),row.gate?.eligible,row.gate?.localOnly,conservativeWrongness(row),riskFeatureVector(row)]))};
}
export function applyRiskCalibrator(calibration,row){
  if(calibration?.version!==RISK_CALIBRATION_VERSION)throw new Error('Unsupported slice risk calibrator');
  if(row.gate?.localOnly===true)return{route:'local_only_safety',reason:'Adversarial safety policy: local inference only',accepted:false,slice:acceptanceSlice(row),futureCertified:false};
  if(!eligible(row))return{route:'escalate',reason:'Hard acceptance gate failed',accepted:false,gateReasons:row.gate?.reasons??['missing-gate'],slice:acceptanceSlice(row),futureCertified:false};
  const slice=acceptanceSlice(row),policy=calibration.models[row.modelId]?.slices[slice];if(!policy)throw new Error('Slice calibrator belongs to another local model');
  const predictedWrongness=predictAcceptanceWrongness(policy.ranker,row),accepted=policy.certifiedFiniteFrame&&predictedWrongness<policy.threshold;
  return{route:accepted?'local':'escalate',accepted,slice,predictedWrongness,threshold:policy.threshold,policyStatus:policy.status,candidateHash:policy.candidateHash,errorBudget:policy.errorBudget,finiteDevFrameUpperRisk:policy.certificate.upperRisk,
    futureCertified:false,reason:accepted?'Locked slice policy accepts; finite dev-frame risk bound is within budget':'Locked slice policy abstains or risk score is above its certified threshold'};
}
/** Descriptive replay only; never changes a threshold or the certificate. */
export function assessRisk(rows,calibration,{seed=20261027,replicates=2000}={}){
  const result=[];for(const modelId of calibration.modelIds)for(const slice of ACCEPTANCE_SLICES){const selected=rows.filter(row=>row.modelId===modelId&&acceptanceSlice(row)===slice),accepted=selected.filter(row=>applyRiskCalibrator(calibration,row).accepted);result.push({...descriptives(accepted,{seed,replicates}),modelId,slice,items:selected.length,total:selected.length,accepted:accepted.length,acceptanceRate:selected.length?accepted.length/selected.length:null,futureCertified:false});}return result;
}
