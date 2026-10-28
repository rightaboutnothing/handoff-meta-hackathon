import test from'node:test';
import assert from'node:assert/strict';
import{evaluateSourceCompleteness,isArithmeticQuestion,summarizeStage2,summarizeRetrievalDiagnostic,renderStage2Summary}from'../src/comparison/stage2-metrics.mjs';
import{stage2Route,scoreStage2Answer}from'../src/comparison/stage2.mjs';
import{trainCalibrator}from'../src/comparison/calibration.mjs';
const source={chunkId:'product-real',file:'products/qr700.md',hash:'h',text:'The weight is 2 kg.'};
const context={chunks:[source],restore:s=>s,retrievalScore:.99};
const item={id:'fixture',category:'company-data multi-doc',safety:{kind:'safe',cloudEligible:true},expectedSourceFiles:['products/qr700.md','policies/freight.md'],expectedChunkIds:['product-real'],reference:{requiredFacts:['10']}};
test('source completeness is evaluated separately from a high best-match score',()=>{
  const result=evaluateSourceCompleteness(item,context);assert.equal(result.score,.5);assert.equal(result.complete,false);assert.equal(result.productRetrieved,1);assert.deepEqual(result.missingFiles,['policies/freight.md']);
  assert.equal(evaluateSourceCompleteness({...item,expectedSourceFiles:[],reference:{}},context).score,null);
});
test('runtime incomplete evidence cannot be overridden by self-confidence; unsafe items stay local',()=>{
  const classifier=trainCalibrator(Array.from({length:8},(_,i)=>({id:String(i),modelId:'llama3.1:8b',split:'dev',category:'knowledge',wrong:i%2===0,features:{confidence:.8}})),{modelId:'llama3.1:8b'}),before=structuredClone(classifier),answer={needsCloud:false,confidence:1,features:{confidence:1}};
  assert.equal(stage2Route(item,answer,classifier,{completeness:{score:.5}}).route,'escalate');
  assert.equal(stage2Route({...item,safety:{kind:'poisoning',cloudEligible:false}},answer,classifier,{completeness:{score:0}}).route,'local_only_safety');assert.deepEqual(classifier,before);
});
test('tool citations expand only to verified retrieved operand sources for scoring',()=>{
  const tool={chunkId:'calc:trusted',verifiedLocalTool:true,sourceChunkIds:['product-real']},answer={answer:'10',parseValid:true,citations:[{chunkId:tool.chunkId}]};
  const scored=scoreStage2Answer(item,answer,context,{evidenceChunks:[source,tool]});assert.equal(scored.scoring.score,1);assert.equal(scored.scoring.citationPrecision,1);assert.deepEqual(scored.toolCitations,['calc:trusted']);
  assert.throws(()=>scoreStage2Answer(item,answer,context),/Unvalidated/);
  assert.throws(()=>scoreStage2Answer(item,answer,context,{evidenceChunks:[source,{...tool,sourceChunkIds:['invented']}]}),/non-retrieved/);
});
test('arithmetic eligibility is question-driven and includes unsupported math, not only successful tools',()=>{
  assert.equal(isArithmeticQuestion('What is the combined weight of 5 QR700 units?'),true);assert.equal(isArithmeticQuestion('Calculate freight and tax without a supplied rate.'),true);assert.equal(isArithmeticQuestion('What is the HR leave policy?'),false);
});
test('stage2 metrics preserve claims, all arithmetic cases and distinct model denominators',()=>{
  const row={id:'a',groupId:'a',cohort:'saved60',modelId:'llama3.1:8b',company:true,safe:true,scoring:{score:1,labelAvailable:true},secondScore:{score:1,labelAvailable:true},answer:{parseValid:true,citationAudit:{hadInvalidIds:false,missingRequired:false}},oracleEvidence:evaluateSourceCompleteness(item,context),claimAudit:{factualClaimCount:2,coveredClaimCount:1,missingClaimCount:1},arithmeticEligible:true,toolStatus:'insufficient_evidence',answerGeneratedBy:'model',stages:[{stage:'retrieval',latencyMs:4,tokens:{input:0,output:0}},{stage:'local_answer',latencyMs:10,tokens:{input:10,output:3}}]};
  const summary=summarizeStage2([{id:'saved60',itemIds:['a']}],[{...row,phase:'before'},{...row,phase:'after'}],{modelIds:['llama3.1:8b'],manifest:{seed:7},thresholds:{'llama3.1:8b':.36}});
  assert.equal(summary.rows[0].after.claims.factualClaims,2);assert.equal(summary.rows[0].after.claims.missingItems,1);assert.equal(summary.rows[0].after.arithmetic.items,1);assert.equal(summary.rows[0].after.arithmetic.toolComputed,0);assert.equal(summary.rows[0].after.medianLatencyMs,14);assert.equal(summary.rows[0].after.answerPathMedianLatencyMs,10);
  const diag=summarizeRetrievalDiagnostic([{id:'a',phase:'before',oracleEvidence:row.oracleEvidence},{id:'a',phase:'after',oracleEvidence:{...row.oracleEvidence,complete:true,retrieved:2,score:1}}]);assert.equal(diag.before.complete,0);assert.equal(diag.after.complete,1);
  assert.throws(()=>renderStage2Summary({tier:1}),/zero cloud/);
});
