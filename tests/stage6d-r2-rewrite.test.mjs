import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {extractPrivateTask,buildQuestionIntentFrame,validateQuestionIntent,validateGeneralQuestion,neutralizePrivateTask,prepareQuestionOnly,screenQuestionOnly} from '../src/privacy/question-boundary.mjs';
import {createQuestionTokenVault} from '../src/privacy/token-vault.mjs';
import {privacyDependencies} from './helpers/question-boundary.mjs';

const item=prompt=>({id:'authored-r2',prompt,safety:{kind:'safe',cloudEligible:true}});
async function options(t,question){const dataDir=await mkdtemp(path.join(os.tmpdir(),'handoff-r2-intent-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));return{dataDir,dependencies:{...privacyDependencies({question}),keyDirectory:path.join(dataDir,'keys')}};}

test('plain request extraction separates record facts and keeps every requested clause and real operand',()=>{
  const source='The stock record belongs to fictional Marigold Works. The unit cost is synthetic. Calculate the average unit cost and round the amount. Compare suppliers in a table.\n\n{"records":[{"name":"Fictional Rowan","amount":27}]}';
  const task=extractPrivateTask(source);assert.equal(task,'Calculate the average unit cost and round the amount. Compare suppliers in a table.');const frame=buildQuestionIntentFrame(source);assert.deepEqual(frame.actions,['compare','calculate']);assert.ok(frame.constraints.includes('average'));assert.ok(frame.constraints.includes('rounding'));assert.ok(frame.constraints.includes('tabular'));assert.equal(task.includes('records'),false);assert.equal(extractPrivateTask('Calculate 27 times 3.'),'Calculate 27 times 3.');
});

test('declarative evidence about totals and tables does not become a requested calculation',()=>{
  const frame=buildQuestionIntentFrame('The manual mentions a table of totals. Explain how the software indicator works.');assert.deepEqual(frame.actions,['explain']);assert.equal(frame.constraints.includes('tabular'),false);assert.equal(frame.task.includes('totals'),false);
});

test('narrow written-artifact aliases preserve writing but cannot waive its artifact or a calculation',()=>{
  assert.equal(validateQuestionIntent('How can a reply about a delayed parcel be created?','Write a reply about a delayed parcel.').valid,true);
  assert.equal(validateQuestionIntent('How can a delayed parcel be created?','Write a reply about a delayed parcel.').valid,false);
  assert.equal(validateQuestionIntent('How can a supplier report be generated?','Write a supplier report.').valid,true);
  assert.equal(validateQuestionIntent('How can supplier status be assessed?','Write a supplier report.').valid,false);
  assert.equal(validateQuestionIntent('How can a stock price be determined?','Calculate the discounted stock subtotal and round the amount.').valid,false);
});

test('canonical neutral markers are protected from repeated source-word redaction',()=>{
  const values=[{type:'ENTITY_VALUE',value:'email'},{type:'ENTITY_VALUE',value:'value'},{type:'ENTITY_VALUE',value:'amount'}],text='How can [EMAIL] and [VALUE] use the invoice [AMOUNT]?';assert.equal(neutralizePrivateTask(text,values).text,text);
  assert.equal(validateGeneralQuestion('How can [VALUE] prices be calculated?',{privateValues:[{type:'PRIVATE',value:'value'}]}).valid,true);
  assert.equal(validateGeneralQuestion('How can value prices be calculated?',{privateValues:[{type:'PRIVATE',value:'value'}]}).valid,false);
  for(const marker of ['[VALUE_7]','[named_person]'])assert.equal(validateGeneralQuestion('How can '+marker+' prices be calculated?').valid,false);
});

test('AES value tokenization protects canonical and prior opaque tokens while real values still restore',async t=>{
  const o=await options(t),vault=await createQuestionTokenVault(o.dataDir,{keyDirectory:o.dependencies.keyDirectory}),values=[{type:'PRIVATE',value:'value'},{type:'EMAIL',value:'willow-dev@example.invalid'}],source='[VALUE] value willow-dev@example.invalid',first=vault.tokenizeValues(source,values),second=vault.tokenizeValues(first.text,[{type:'PRIVATE',value:'LOCAL'}]);assert.equal(first.replacements,2);assert.equal(second.text,first.text);assert.equal(vault.restore(first.text),source);assert.equal(first.text.startsWith('[VALUE] '),true);
});

test('ordinary instruction functions never become identities, while labeled real names remain protected',async t=>{
  const source='Keep every record local. Return only a supported answer. Calculate average stock costs.\n\n{"records":[{"name":"Fictional Rowan","company_name":"Fictional Willow Works"}]}',o=await options(t,'How can average stock costs be calculated?'),prep=await prepareQuestionOnly(item(source),o);assert.equal(prep.baseBlocked,false);assert.equal(prep.privateValues.some(r=>r.value==='Keep'||r.value==='Return'),false);assert.equal(prep.privateValues.some(r=>r.value==='Fictional Rowan'),true);assert.equal(prep.privateValues.some(r=>r.value==='Fictional Willow Works'),true);
});

test('a dropped real operation is repaired against the immutable source frame before Guard',async t=>{
  const o=await options(t),call=o.dependencies.localCall;let rewrites=0,guards=0;
  o.dependencies.localCall=async(...args)=>{const result=await call(...args);if(args[2].schema.properties.generalizable){rewrites++;result.text=JSON.stringify({question:rewrites===1?'How can stock prices be described?':'How can average stock prices be calculated and rounded?',generalizable:true});}return result;};o.dependencies.harmfulGuard=async()=>{guards++;return{safe:true,classification:'safe',latencyMs:1};};const prep=await prepareQuestionOnly(item('Calculate average stock prices and round the amount.'),o);assert.equal(prep.baseBlocked,false);assert.equal(guards,0);const rewrite=prep.stages.find(s=>s.layerId==='rewrite');assert.equal(rewrite.attempts.length,2);assert.equal(rewrite.attempts[0].status,'BLOCKED');assert.equal(rewrite.attempts[0].code,'QUESTION_INTENT_LOST');assert.equal(rewrite.attempts[0].recovered,true);assert.deepEqual(prep.intentFrame.actions,['calculate']);assert.equal(prep.intent.valid,true);const screened=await screenQuestionOnly(prep,{dependencies:o.dependencies});assert.equal(screened.hypotheticalBlocked,false);assert.equal(guards,1);
});

test('unrepaired semantic loss stays blocked after at most three repairs and is not a schema execution error',async t=>{
  const o=await options(t,'How can stock status be described?'),prep=await prepareQuestionOnly(item('Calculate average stock prices.'),o),stage=prep.stages.find(s=>s.layerId==='rewrite');assert.equal(prep.baseBlocked,true);assert.equal(stage.status,'BLOCKED');assert.equal(stage.attempts.length,4);assert.ok(stage.attempts.every(a=>a.status==='BLOCKED'&&a.code==='QUESTION_INTENT_LOST'));assert.equal(stage.attempts.some(a=>a.status==='ERROR'),false);
});

test('a valid non-generalizable refusal accepts an empty question and never mints a permit',async t=>{
  const o=await options(t),call=o.dependencies.localCall;o.dependencies.localCall=async(...args)=>{const result=await call(...args);if(args[2].schema.properties.generalizable)result.text=JSON.stringify({question:'',generalizable:false});return result;};const prep=await prepareQuestionOnly(item('Explain an unsupported task.'),o),screen=await screenQuestionOnly(prep,{dependencies:o.dependencies});assert.ok(prep.reasons.includes('REWRITE_NOT_GENERALIZABLE'));assert.equal(prep.stages.some(s=>s.status==='ERROR'),false);assert.equal(screen.liveEligible,false);assert.equal(screen.releasePermit,null);
});

test('the model grammar permits only empty or exactly one trailing question mark',async t=>{
  const o=await options(t),call=o.dependencies.localCall;let inspected=false;o.dependencies.localCall=async(...args)=>{if(args[2].schema.properties.generalizable){const grammar=new RegExp(args[2].schema.properties.question.pattern);assert.equal(grammar.test(''),true);assert.equal(grammar.test('How can average costs be calculated?'),true);assert.equal(grammar.test('A refusal without a question mark.'),false);assert.equal(grammar.test('How can costs be calculated? Which amount applies?'),false);assert.equal(grammar.test('How can [VALUE] costs be calculated?'),true);assert.equal(grammar.test('How can [VALUE_7] costs be calculated?'),false);inspected=true;}return call(...args);};await prepareQuestionOnly(item('Calculate average stock costs.'),o);assert.equal(inspected,true);
});

test('intent frame and its hash are bound by the preparation proof',async t=>{
  const o=await options(t),prep=await prepareQuestionOnly(item('How can average stock costs be calculated?'),o);prep.intentFrame.actions=[];const screen=await screenQuestionOnly(prep,{dependencies:o.dependencies});assert.ok(screen.blockedByLayer.includes('PREPARATION_PROOF_REQUIRED'));assert.equal(screen.liveEligible,false);
});
