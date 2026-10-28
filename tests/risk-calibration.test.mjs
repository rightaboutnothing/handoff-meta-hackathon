import test from'node:test';
import assert from'node:assert/strict';
import{hypergeometricLowerTail,finiteFrameUpperBound,fitSliceCalibrators,applyRiskCalibrator,assessRisk,riskFeatureVector,knownWrongness}from'../src/comparison/risk-calibration.mjs';

const model='llama3.1:8b';
function fixture({company=200,general=200,wrong=false}={}){
  const rows=[],roles={};
  for(const[slice,count]of[['company',company],['general',general]])for(let i=0;i<count;i++){
    const id=`${slice}-${i}`,role=i<Math.floor(count*.4)?'fit':i<Math.floor(count*.5)?'select':i<Math.floor(count*.9)?'calib':'audit';roles[id]=role;
    rows.push({id,groupId:`family-${slice}-${i%6}`,split:'dev',slice,category:slice==='company'?'company-data multi-doc':'reasoning',modelId:model,features:{confidence:.99,retrievalScore:.9,evidenceCompleteness:1,evidenceCompletenessApplicable:slice==='company',sourceDocCount:3,hasValidCitations:true,citationCount:3,claimCoverage:1,claimCoverageApplicable:slice==='company',calculatorVerified:slice==='company',answerTokens:60,selfCheckTokens:40,answerCapFraction:60/768,selfCheckCapFraction:40/128,answerCharacterCount:150,needsCloud:false},gate:{eligible:true,localOnly:false,reasons:[]},scoring:{score:wrong?0:1,labelAvailable:true}});
  }
  return{rows,roles};
}
const fit=(rows,roles,options={})=>fitSliceCalibrators(rows,{modelIds:[model],rolesById:roles,seed:20261027,replicates:40,iterations:80,...options});

test('hypergeometric lower tail matches direct small-universe probabilities and edge cases',()=>{
  assert.ok(Math.abs(hypergeometricLowerTail(10,2,5,0)-56/252)<1e-12);
  assert.equal(hypergeometricLowerTail(10,0,5,0),1);assert.equal(hypergeometricLowerTail(10,10,5,4),0);assert.equal(hypergeometricLowerTail(10,10,5,5),1);
  assert.throws(()=>hypergeometricLowerTail(5,6,1,0),/Invalid/);
});
test('exact inverted bound has the stated one-sided coverage over every small fixed population',()=>{
  const alpha=.05;
  for(let population=1;population<=14;population++)for(let sampled=0;sampled<=population;sampled++)for(let trueWrong=0;trueWrong<=population;trueWrong++){
    let undercoverage=0,previous=0;
    for(let observed=0;observed<=sampled;observed++){
      const cdf=hypergeometricLowerTail(population,trueWrong,sampled,observed),probability=Math.max(0,cdf-previous);previous=cdf;
      if(finiteFrameUpperBound({population,sampled,wrong:observed,alpha}).upperWrong<trueWrong)undercoverage+=probability;
    }
    assert.ok(undercoverage<=alpha+1e-10,`${population},${sampled},${trueWrong}: ${undercoverage}`);
  }
});
test('zero observed errors do not produce a spurious zero bound; a census is exact',()=>{
  const zero=finiteFrameUpperBound({population:100,sampled:80,wrong:0,alpha:.05/6});
  assert.ok(zero.upperWrong>0);assert.ok(zero.upperRisk<=.05);assert.ok(zero.unsampled.upperRisk>zero.upperRisk);
  assert.equal(finiteFrameUpperBound({population:100,sampled:100,wrong:7}).upperRisk,.07);
  assert.equal(finiteFrameUpperBound({population:100,sampled:0,wrong:0}).upperRisk,1);
  assert.equal(finiteFrameUpperBound({population:0,sampled:0,wrong:0}).upperRisk,null);
});
test('separate model/slice candidates are selected on SELECT and certified on CALIB only',()=>{
  const{rows,roles}=fixture(),calibration=fit(rows,roles),company=calibration.models[model].slices.company;
  assert.equal(company.status,'CERTIFIED_FINITE_DEV_FRAME');assert.equal(company.certificate.population,100);assert.equal(company.certificate.sampled,80);assert.ok(company.certificate.upperRisk<=.05);assert.equal(company.futureCertified,false);
  assert.equal(calibration.models[model].slices.general.slice,'general');assert.equal(calibration.finalTestLabelsUsed,false);
  const before=structuredClone(company),changed=rows.map(row=>roles[row.id]==='audit'?{...row,scoring:{score:0,labelAvailable:true}}:row),after=fit(changed,roles).models[model].slices.company;
  assert.deepEqual(after.ranker,before.ranker);assert.equal(after.candidateHash,before.candidateHash);assert.deepEqual(after.certificate,before.certificate);assert.notEqual(after.audit.accuracy,before.audit.accuracy);
});
test('a failed calibration certificate abstains without selecting another threshold',()=>{
  const{rows,roles}=fixture(),baseline=fit(rows,roles).models[model].slices.company;
  const changed=rows.map(row=>roles[row.id]==='calib'&&row.slice==='company'?{...row,scoring:{score:0,labelAvailable:true}}:row),calibration=fit(changed,roles),policy=calibration.models[model].slices.company;
  assert.equal(policy.candidateHash,baseline.candidateHash);assert.equal(policy.candidateThreshold,baseline.candidateThreshold);assert.equal(policy.status,'ABSTAIN_UNCERTIFIED');assert.equal(policy.threshold,0);assert.equal(policy.certifiedFiniteFrame,false);
  assert.equal(applyRiskCalibrator(calibration,rows.find(row=>row.slice==='company')).route,'escalate');
});
test('unknown labels cannot improve the certificate and are not relabelled as known failures',()=>{
  const{rows,roles}=fixture(),modified=rows.map(row=>roles[row.id]==='calib'&&row.slice==='company'?{...row,scoring:{score:null,labelAvailable:false}}:row),calibration=fit(modified,roles),policy=calibration.models[model].slices.company;
  assert.equal(policy.calibration.unknown,80);assert.equal(policy.calibration.wrong,80);assert.equal(policy.status,'ABSTAIN_UNCERTIFIED');assert.equal(knownWrongness(modified.find(row=>roles[row.id]==='calib')),null);
  assert.equal(knownWrongness({scoring:{score:.9999999999,labelAvailable:true}}),1);assert.equal(knownWrongness({scoring:{score:2,labelAvailable:true}}),null);
});
test('dev/test, role, model and manifest leakage guards fail closed',()=>{
  const{rows,roles}=fixture({company:20,general:20});
  assert.throws(()=>fit([{...rows[0],split:'test'},...rows.slice(1)],roles),/dev-training/);
  assert.throws(()=>fit([{...rows[0],modelId:'gemma3:12b'},...rows.slice(1)],roles),/Unregistered/);
  assert.throws(()=>fit([...rows,rows[0]],roles),/Duplicate/);
  assert.throws(()=>fit(rows,{...roles,[rows[0].id]:'test'}),/predeclared/);
  assert.throws(()=>fit(rows.slice(1),roles,{manifest:{devIds:rows.map(row=>row.id)}}),/incomplete/);
  assert.throws(()=>fit(rows,roles,{manifest:{devIds:[]}}),/outside/);
});
test('references and arbitrary correctness fields never become features or learned scores',()=>{
  const{rows,roles}=fixture(),first=fit(rows,roles),mutated=rows.map(row=>({...row,reference:{answer:'GOLD MUST NEVER BE A FEATURE'},features:{...row.features,oracleCorrectness:1,expectedAnswer:'GOLD'}}));
  assert.deepEqual(riskFeatureVector(mutated[0]),riskFeatureVector(rows[0]));assert.deepEqual(fit(mutated,roles),first);
});
test('hard gates and adversarial local-only policy override every certified threshold',()=>{
  const{rows,roles}=fixture(),calibration=fit(rows,roles),row=rows[0];
  assert.equal(applyRiskCalibrator(calibration,row).route,'local');
  assert.equal(applyRiskCalibrator(calibration,{...row,gate:{eligible:false,reasons:['truncated']}}).route,'escalate');
  assert.equal(applyRiskCalibrator(calibration,{...row,gate:undefined}).route,'escalate');
  assert.equal(applyRiskCalibrator(calibration,{...row,gate:{eligible:false,localOnly:true}}).route,'local_only_safety');
  assert.throws(()=>applyRiskCalibrator(calibration,{...row,modelId:'unregistered'}),/another local model/);
});
test('descriptive frozen replay preserves total denominator and cannot change the calibrator',()=>{
  const{rows,roles}=fixture(),calibration=fit(rows,roles),before=structuredClone(calibration),result=assessRisk(rows,calibration,{replicates:40});
  assert.equal(result[0].items,200);assert.equal(result[0].accepted,200);assert.equal(result[0].futureCertified,false);assert.deepEqual(calibration,before);
});
