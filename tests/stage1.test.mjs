import test from 'node:test';
import assert from 'node:assert/strict';
import {stage1Route,scoreStage1Answer,baselineStage1Row}from'../src/comparison/stage1.mjs';
import {trainCalibrator}from'../src/comparison/calibration.mjs';

const prepared={question:'Question',restore:text=>text,chunks:[{chunkId:'source-001',file:'policy.md',text:'Two days.',hash:'h'}],retrievalScore:.9};
const item={id:'fixture',category:'company-data single-doc',safety:{kind:'safe',cloudEligible:true},reference:{requiredFacts:['two days']},expectedChunkIds:['source-001']};
const answer={answer:'Two days.',citations:[{chunkId:'source-001',valid:true}],confidence:.99,parseValid:true,needsCloud:false,routingSource:'code-derived',citationAudit:{grounded:true,rejectedIds:[]},features:{confidence:.99,retrievalScore:.9,sourceDocCount:1,hasValidCitations:true,citationCount:1,needsCloud:false}};
test('the scoring boundary rejects an invented citation rather than treating it as grounded',()=>{
  assert.throws(()=>scoreStage1Answer(item,{...answer,citations:[{chunkId:'invented-id'}]},prepared),/validated/);
  const score=scoreStage1Answer(item,answer,prepared);assert.equal(score.scoring.score,1);assert.equal(score.groundedFullCredit,true);
});
test('zero frozen acceptance threshold still abstains and unsafe items remain local regardless of checker',()=>{
  const modelId='gemma3:12b',rows=Array.from({length:8},(_,n)=>({id:String(n),split:'dev',modelId,category:'knowledge',wrong:n%2===0,features:{confidence:.8}}));
  const classifier=trainCalibrator(rows,{modelId});classifier.threshold=0;const before=structuredClone(classifier);
  assert.equal(stage1Route(item,answer,classifier).route,'escalate');assert.deepEqual(classifier,before);
  const unsafe={...item,safety:{kind:'red-team',cloudEligible:false}};
  assert.equal(stage1Route(unsafe,{...answer,needsCloud:true},classifier).route,'local_only_safety');
});
test('baseline normalization preserves raw citation errors and the historical score',()=>{
  const record={answer:{answer:'Two days. [invented-id]',citations:['invented-id'],parseValid:true},raw:{text:'Two days. [invented-id]',tokens:{input:1,output:2},latencyMs:1},scoring:{score:1,labelAvailable:true}};
  const row=baselineStage1Row(item,record,prepared,{modelId:'llama3.1:8b',cohort:'plain50'});
  assert.equal(row.answer.answer,'Two days.');assert.equal(row.answer.citationAudit.hadInvalidIds,true);assert.equal(row.answer.citationAudit.missingRequired,true);assert.deepEqual(row.answer.citations,[]);assert.equal(row.scoring.score,1);assert.equal(row.historicalScoring.score,1);assert.equal(row.groundedFullCredit,false);
});
test('noncompany task-native JSON and array content are unchanged by baseline normalization',()=>{
  const question={...item,category:'instruction-following',reference:{instruction_ids:['detectable_format:json_format'],kwargs:[{}]}};
  const body='{"values":[1,2],"note":"[keep]"}',record={answer:{answer:body,citations:[],parseValid:true},raw:{text:body}};
  const row=baselineStage1Row(question,record,{...prepared,chunks:[]},{modelId:'llama3.1:8b',cohort:'plain50'});
  assert.equal(row.answer.answer,body);assert.equal(row.scoring.score,1);assert.equal(row.company,false);
});
