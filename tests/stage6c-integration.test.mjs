import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {neutralizePrivateTask,validateGeneralQuestion,validateQuestionIntent,prepareQuestionOnly,screenQuestionOnly,buildQuestionOnlyPayload,checkIncomingAnswer,applyAnswerLocally} from '../src/privacy/question-boundary.mjs';
import {privacyDependencies} from './helpers/question-boundary.mjs';

// Authored benign regression cases, independent of every frozen corpus.
const cases=[
  {
    "id": "integration-id-source",
    "kind": "neutralization",
    "source": "Compare unit prices for product NOVA27 and product BIRCH84.",
    "assertions": [
      "Both mixed identifiers become fixed role markers",
      "Product, price and comparison intent remains",
      "No digits or original identifiers remain"
    ]
  },
  {
    "id": "integration-id-candidate",
    "kind": "neutralization",
    "source": "How can reorder demand for stock item CLOUD73 be calculated?",
    "assertions": [
      "Candidate cleanup catches identifiers generated after the source mask",
      "Original value is registered only in local mapping",
      "Result still asks for reorder calculation"
    ]
  },
  {
    "id": "integration-id-no-index",
    "kind": "negative",
    "source": "How can prices for [IDENTIFIER_27] be compared?",
    "assertions": [
      "Unique or indexed placeholder remains invalid"
    ]
  },
  {
    "id": "integration-meaning-verb",
    "kind": "intent",
    "source": "What does a status indicator mean in a software manual?",
    "candidate": "How can a status indicator in a software manual be interpreted?",
    "expected": true
  },
  {
    "id": "integration-mean-statistic",
    "kind": "intent",
    "source": "Calculate the arithmetic mean of the invoice amounts.",
    "candidate": "How can invoice amounts be summed?",
    "expected": false
  },
  {
    "id": "integration-mean-kept",
    "kind": "intent",
    "source": "Calculate the arithmetic mean of the invoice amounts.",
    "candidate": "How can the average invoice amount be calculated?",
    "expected": true
  },
  {
    "id": "integration-message-noun",
    "kind": "intent",
    "source": "Explain the purpose of a software status message.",
    "candidate": "What purpose does a software status message serve?",
    "expected": true
  },
  {
    "id": "integration-reply-writing",
    "kind": "intent",
    "source": "Write a reply to a customer about a delivery delay.",
    "candidate": "How can a response to a customer about a delivery delay be drafted?",
    "expected": true
  },
  {
    "id": "integration-writing-dropped",
    "kind": "intent",
    "source": "Write a reply to a customer about a delivery delay.",
    "candidate": "What causes a delivery delay?",
    "expected": false
  },
  {
    "id": "integration-lookup-computation",
    "kind": "intent",
    "source": "Identify which discounted unit price applies to an order.",
    "candidate": "How can the applicable discounted unit price for an order be calculated?",
    "expected": true
  },
  {
    "id": "integration-selection-kept",
    "kind": "intent",
    "source": "Identify the product with the lowest unit price.",
    "candidate": "How can products be compared to select the lowest unit price?",
    "expected": true
  },
  {
    "id": "integration-selection-dropped",
    "kind": "intent",
    "source": "Identify the product with the lowest unit price.",
    "candidate": "How can a product price be calculated?",
    "expected": false
  },
  {
    "id": "integration-domain-operation-dropped",
    "kind": "intent",
    "source": "Calculate average unit costs and compare products in a table.",
    "candidate": "How can products be compared in a table?",
    "expected": false
  },
  {
    "id": "integration-table-dropped",
    "kind": "intent",
    "source": "Calculate average unit costs and compare products in a table.",
    "candidate": "How can average unit costs be calculated and products compared?",
    "expected": false
  },
  {
    "id": "integration-opening-word",
    "kind": "shape",
    "source": "Given neutral product values, how can unit prices be compared?",
    "expected": true
  },
  {
    "id": "integration-name-opening",
    "kind": "shape",
    "source": "Fictional Rowan is associated with which private account?",
    "expected": false
  },
  {
    "id": "integration-canary-category",
    "kind": "shape",
    "source": "How can generic canary tokens be monitored for accidental disclosure?",
    "expected": true
  },
  {
    "id": "integration-canary-value",
    "kind": "neutralization",
    "source": "How can CANARY-DEMO-NOVA27 be checked for accidental disclosure?",
    "assertions": [
      "Actual tagged literal is neutralized or blocked",
      "Generic monitoring purpose remains",
      "Original literal never appears in payload"
    ]
  }
];
for(const row of cases)test(row.id,()=>{
  if(row.kind==='intent'){assert.equal(validateQuestionIntent(row.candidate,row.source).valid,row.expected);return;}
  if(row.kind==='shape'||row.kind==='negative'){assert.equal(validateGeneralQuestion(row.source).valid,row.expected??false);return;}
  const result=neutralizePrivateTask(row.source,[],{extractTask:false});assert.ok(result.replacements>0);assert.equal(/\d/.test(result.text),false);assert.equal(/NOVA27|BIRCH84|CLOUD73|CANARY-DEMO-NOVA27/.test(result.text),false);if(row.source.trim().endsWith('?'))assert.equal(validateGeneralQuestion(result.text).valid,true);assert.equal(validateQuestionIntent(result.text,row.source).valid,true);
});

test('fresh authored business JSON task and invented identifier complete the actual local apply path',async t=>{
  const directory=await mkdtemp(path.join(os.tmpdir(),'handoff-business-integration-'));t.after(()=>{assert.equal(path.dirname(path.resolve(directory)),path.resolve(os.tmpdir()));assert.ok(path.basename(directory).startsWith('handoff-business-integration-'));return rm(directory,{recursive:true,force:true});});
  const item={id:'authored-business-json-apply',suite:'company-rag',category:'company-data multi-doc',safety:{kind:'safe',cloudEligible:true},content:JSON.stringify({question:'Given product NOVA27, calculate the average unit cost and compare product options in a table.',evidence:[{chunkId:'authored-chunk',text:'Name: Fictional Willow; local private product evidence for NOVA27.'}]})};
  const dependencies=privacyDependencies({question:'Given product [PRODUCT], how can the average unit cost be calculated and product options compared in a table?',answer:'A supported private unit-cost table.',citations:['authored-chunk']}),safetyInputs=[],guard=dependencies.harmfulGuard,local=dependencies.localCall;let rewriteCalls=0;
  dependencies.localCall=async(...args)=>{const result=await local(...args);if(args[2].schema.properties.generalizable&&++rewriteCalls===1)result.text=JSON.stringify({question:'Given product ZENITH83, how can the average unit cost be calculated and product options compared in a table?',generalizable:true});return result;};
  dependencies.harmfulGuard=async(...args)=>{safetyInputs.push(args);return guard(...args);};
  const prepared=await prepareQuestionOnly(item,{dataDir:directory,shadowEvaluation:true,dependencies:{...dependencies,keyDirectory:path.join(directory,'keys')}});assert.equal(prepared.baseBlocked,false);assert.equal(prepared.intent.valid,true);assert.equal(prepared.privateValues.some(row=>row.value==='NOVA27'),true);assert.equal(prepared.stages.find(stage=>stage.layerId==='rewrite').attempts[0].code,'PRIVACY_LOCAL_QUESTION_FORMAT');
  const screened=await screenQuestionOnly(prepared,{shadowEvaluation:true,dependencies});assert.equal(screened.hypotheticalBlocked,false);assert.equal(screened.releasePermit,null);
  const wire=buildQuestionOnlyPayload(screened.question);assert.deepEqual(Object.keys(JSON.parse(wire)).sort(),['question','system']);assert.doesNotMatch(wire,/NOVA27|ZENITH83|Fictional Willow|authored-chunk|local private product evidence/);assert.ok(safetyInputs.some(args=>args[1].includes('NOVA27')));
  const checked=await checkIncomingAnswer(prepared,'Calculate total cost divided by units, then compare the product options in a table.',{shadowEvaluation:true,dependencies});assert.equal(checked.availableChecksPassed,true);
  const applied=await applyAnswerLocally(prepared,checked,{localContext:[{chunkId:'authored-chunk',text:'Local synthetic evidence: A supported private unit-cost table.'}],shadowEvaluation:true,dependencies});assert.equal(applied.tokenRoundTripVerified,true);assert.equal(applied.answer,'A supported private unit-cost table.');assert.deepEqual(applied.citations,['authored-chunk']);
});

test('actual known identity literals cannot be waved through by the opening-word allowance',()=>{
  assert.equal(validateGeneralQuestion('Given neutral values, how can prices be compared?',{privateValues:[{type:'PERSON_NAME',value:'Given'}]}).valid,false);
  assert.equal(validateGeneralQuestion('How can ordinary canary monitoring be described?',{privateValues:[{type:'PRIVATE',value:'ordinary'}]}).valid,false);
});
