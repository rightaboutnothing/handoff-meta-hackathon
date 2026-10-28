import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {prepareQuestionOnly,validateGeneralQuestion,validateQuestionIntent,extractPrivateTask,neutralizePrivateTask} from '../src/privacy/question-boundary.mjs';
import {privacyDependencies} from './helpers/question-boundary.mjs';

async function folder(t){const directory=await mkdtemp(path.join(os.tmpdir(),'handoff-intent-dev-'));t.after(()=>rm(directory,{recursive:true,force:true}));return directory;}
const privateTask={id:'authored-placeholder-dev',content:'Name: Fictional Cedar; Email: cedar@example.invalid; Task: calculate the average invoice amount for the customer.',safety:{kind:'safe',cloudEligible:true}};

test('fixed neutral role markers preserve context without allowing unique or freeform identifiers',()=>{
  assert.equal(validateGeneralQuestion('How can the average invoice amount for [PERSON] be calculated?').valid,true);
  for(const marker of ['[PERSON_A]','[PERSON_123]','[cedar]','[[LOCAL_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]]'])assert.equal(validateGeneralQuestion('How can the average invoice for '+marker+' be calculated?').valid,false);
  assert.equal(validateGeneralQuestion('How can the average invoice for Fictional Cedar be calculated?').valid,false);
});

test('rewrite input keeps task intent but drops evidence and replaces private details with role markers',()=>{
  const source=JSON.stringify({question:'Calculate the invoice amount for Fictional Cedar.',evidence:[{text:'A fictional company document.'}]});
  const clean=neutralizePrivateTask(source,[{value:'Fictional Cedar',type:'PERSON_NAME'}]);
  assert.equal(extractPrivateTask(source),'Calculate the invoice amount for Fictional Cedar.');assert.equal(clean.text,'Calculate the invoice amount for [PERSON].');assert.equal(clean.replacements,1);assert.equal(clean.text.includes('document'),false);
});

test('intent checks reject vague and privacy-only answers and preserve multiple operations and constraints',()=>{
  const source='Calculate average campaign costs and compare conversions in a table.';
  assert.equal(validateQuestionIntent('How can average campaign costs be calculated and conversions compared in a table?',source).valid,true);
  for(const question of ['What general method should be used for this task?','How can private data be analyzed?','How can personal information be kept safe?','How can average campaign costs be calculated?'])assert.equal(validateQuestionIntent(question,source).valid,false);
  assert.equal(validateQuestionIntent('How can a stuck application be terminated?','How can a stuck process be stopped?').valid,true);
  assert.equal(validateQuestionIntent('How can medication dosage instructions on a label be interpreted?','Explain medication dosage instructions on a label.').valid,true);
  assert.equal(validateQuestionIntent('Which campaign performs best when conversion rates are compared?','Compare campaign conversion rates and identify the best campaign.').valid,true);
  assert.equal(validateQuestionIntent('How can a sales campaign strategy be written?','Write a sales campaign plan, meaning a business strategy.').valid,true);
  assert.equal(validateQuestionIntent('How can invoice amounts be calculated?','Calculate the average invoice amount.').valid,false);
  assert.equal(validateQuestionIntent('How can revenue change be calculated?','Calculate percentage revenue change.').valid,false);
});

test('residual privacy check sees only the proposed question, never the original private source',async t=>{
  const directory=await folder(t),dependencies=privacyDependencies({question:'How can the average invoice amount for [PERSON] be calculated?'}),original=dependencies.localCall;let inspected=false,masked=false;
  dependencies.localCall=async(lens,messages,options)=>{const body=JSON.parse(messages.at(-1).content);if(options.schema.properties.generalizable){masked=!JSON.stringify(body).includes('cedar@example.invalid')&&!JSON.stringify(body).includes('Fictional Cedar');}if(options.schema.properties.private_values){assert.deepEqual(Object.keys(body),['proposedQuestion']);assert.equal(JSON.stringify(body).includes('cedar@example.invalid'),false);assert.equal(body.proposedQuestion.includes('[PERSON]'),false);inspected=true;}return original(lens,messages,options);};
  const result=await prepareQuestionOnly(privateTask,{dataDir:directory,dependencies:{...dependencies,keyDirectory:path.join(directory,'keys')}});
  assert.equal(result.baseBlocked,false);assert.equal(result.intent.valid,true);assert.equal(result.neutralPlaceholders.question,1);assert.equal(masked,true);assert.equal(inspected,true);assert.equal(result.question.includes('Cedar'),false);
});

test('implicit explanation preserves a wrapper but cannot replace domain operations or constraints',()=>{
  const source='Explain how to calculate average campaign costs and compare conversions in a table.';
  assert.equal(validateQuestionIntent('How can average campaign costs be calculated and conversions compared in a table?',source).valid,true);
  assert.equal(validateQuestionIntent('What calculations provide average campaign costs and compare conversions in a table?',source).valid,true);
  assert.equal(validateQuestionIntent('Why can average campaign costs be calculated and conversions compared in a table?',source).valid,true);
  for(const question of ['How can private campaign data be handled safely?','How can average campaign costs be calculated in a table?','How can average campaign costs be calculated and conversions compared?','What general method should be used for this task?'])assert.equal(validateQuestionIntent(question,source).valid,false);
});

test('a privacy-safe boolean cannot override known values or a rewrite that loses the task',async t=>{
  for(const question of ['How should cedar@example.invalid be contacted?','What general method should be used for this task?']){
    const directory=await folder(t),dependencies=privacyDependencies({question}),result=await prepareQuestionOnly(privateTask,{dataDir:directory,dependencies:{...dependencies,keyDirectory:path.join(directory,'keys')}});
    assert.equal(result.baseBlocked,true);assert.ok(result.reasons.some(code=>['PII_RESIDUAL','QUESTION_INTENT_LOST','PRIVATE_VALUE_SURVIVED','QUESTION_CONTAINS_DATA_REFERENCE'].includes(code)));
  }
});

test('invented entity spans and invalid local results continue to fail closed',async t=>{
  const directory=await folder(t),dependencies=privacyDependencies({question:'How can an invoice amount be calculated?'}),original=dependencies.localCall;
  dependencies.localCall=async(...args)=>{const result=await original(...args);if(args[2].schema.properties.private_values)result.text=JSON.stringify({private_values:[{type:'person',value:'Invented Person'}]});return result;};
  const result=await prepareQuestionOnly(privateTask,{dataDir:directory,dependencies:{...dependencies,keyDirectory:path.join(directory,'keys')}});assert.equal(result.baseBlocked,true);assert.ok(result.reasons.includes('PRIVACY_LOCAL_INVALID_SPAN'));
});

test('literal extraction replaces only actual spans and preserves the requested calculation',async t=>{
  const directory=await folder(t),dependencies=privacyDependencies({question:'How can the average invoice amount for cedar@example.invalid be calculated?'}),original=dependencies.localCall;
  dependencies.localCall=async(...args)=>{const result=await original(...args);if(args[2].schema.properties.private_values)result.text=JSON.stringify({private_values:[{type:'email',value:'cedar@example.invalid'}]});return result;};
  const result=await prepareQuestionOnly(privateTask,{dataDir:directory,dependencies:{...dependencies,keyDirectory:path.join(directory,'keys')}});assert.equal(result.baseBlocked,false);assert.equal(result.question.includes('cedar@example.invalid'),false);assert.equal(result.question.includes('[EMAIL]'),true);assert.equal(result.intent.valid,true);
});
