import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compileNeutralRequest,buildQuestionIntentFrame,validateQuestionIntent,validateGeneralQuestion,prepareQuestionOnly} from '../src/privacy/question-boundary.mjs';
import {privacyDependencies} from './helpers/question-boundary.mjs';
const item=prompt=>({id:'authored-r4',prompt,safety:{kind:'safe',cloudEligible:true}});
async function options(t,question){const dataDir=await mkdtemp(path.join(os.tmpdir(),'handoff-r4-contract-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));return{dataDir,dependencies:{...privacyDependencies({question}),keyDirectory:path.join(dataDir,'keys')}};}

test('compound compiler preserves imperative requirements and the actual WH question',()=>{
  const source='Use the local pricing rules to calculate derived amounts. Which stock price applies?',compiled=compileNeutralRequest(source);assert.equal(compiled.eligible,true);assert.equal(compiled.question,'How can someone use the local pricing rules to calculate derived amounts and determine which stock price applies?');assert.equal(validateQuestionIntent(compiled.question,source).valid,true);assert.equal(validateGeneralQuestion(compiled.question).valid,true);
});

test('compound compiler preserves quoted instruction words without copying quote delimiters or dropping calculation',()=>{
  const source='Use supporting records to calculate the amount or state "unknown" if unavailable. What unit price applies?',compiled=compileNeutralRequest(source);assert.equal(compiled.eligible,true);assert.equal(compiled.question.includes('calculate'),true);assert.equal(compiled.question.includes('unknown'),true);assert.equal(compiled.question.includes('"'),false);assert.equal(validateQuestionIntent(compiled.question,source).valid,true);
});

test('tie breaking compiles after a semicolon while preserving key and direction',()=>{
  const source='Find the lowest stock price per product; break ties alphabetically by product code.',compiled=compileNeutralRequest(source),frame=buildQuestionIntentFrame(source);assert.equal(compiled.eligible,true);assert.equal(compiled.question.includes('and break ties alphabetically by product code'),true);assert.ok(frame.constraints.includes('tie_break'));assert.ok(frame.constraints.includes('tie_key'));assert.ok(frame.constraints.includes('tie_direction'));assert.equal(validateQuestionIntent(compiled.question,source).valid,true);
});

test('dropping or changing the tie key or direction cannot pass the source frame',()=>{
  const source='Find the lowest stock price per product; break ties alphabetically by product code.';
  for(const candidate of ['How can someone find the lowest stock price per product?','How can someone find the lowest stock price per product and break ties alphabetically by supplier cost?','How can someone find the lowest stock price per product and break ties numerically by product code?','How can someone find the lowest stock price per product and break ties alphabetically and numerically by product code?'])assert.equal(validateQuestionIntent(candidate,source).valid,false);
  assert.equal(validateQuestionIntent('How can someone find the lowest stock price per product and break ties alphabetically by product code?',source).valid,true);
});

test('an unclassified factual semicolon continuation remains local model fallback',()=>{
  assert.equal(compileNeutralRequest('Compare stock prices; the fictional depot has a confidential rule.').eligible,false);assert.equal(compileNeutralRequest('Find supplier prices; name: fictional person.').eligible,false);
});

test('source and compiler canonical roles remain accepted by code independently of model plain-role grammar',()=>{
  const source='Write a reply to [PERSON] about [PRODUCT].',compiled=compileNeutralRequest(source);assert.equal(compiled.eligible,true);assert.equal(validateGeneralQuestion(compiled.question).valid,true);assert.equal(compiled.question.includes('[PERSON]'),true);
});

test('model-only finite pattern enforces exact lengths, one question mark and plain ASCII role words',async t=>{
  const o=await options(t,'How can an individual compare stock prices?'),call=o.dependencies.localCall;let inspected=false;o.dependencies.localCall=async(...args)=>{if(args[2].schema.properties.generalizable){const property=args[2].schema.properties.question,p=new RegExp(property.pattern);assert.equal(property.maxLength,undefined);assert.equal(p.test('a'.repeat(11)+'?'),true);assert.equal(p.test('a'.repeat(10)+'?'),false);assert.equal(p.test('a'.repeat(319)+'?'),true);assert.equal(p.test('a'.repeat(320)+'?'),false);for(const invalid of ['How can [PERSON] compare stock prices?','How can value7 compare stock prices?','How can a value compare? Which value?','How can a value compare stock prices','How can an individual’s price compare?','How can a value\\price compare?'])assert.equal(p.test(invalid),false);assert.equal(p.test('How can an individual compare stock prices?'),true);assert.equal(args[2].maxTokens,512);const body=JSON.parse(args[1].at(-1).content);assert.equal(body.task.includes('[PERSON]'),false);inspected=true;}return call(...args);};await prepareQuestionOnly(item('Given [PERSON], compare stock prices.'),o);assert.equal(inspected,true);
});

test('valid false model contract is a harmless short question then a proof-bound empty local block',async t=>{
  const o=await options(t),call=o.dependencies.localCall;let calls=0;o.dependencies.localCall=async(...args)=>{const r=await call(...args);if(args[2].schema.properties.generalizable){const question='How can this local request be assessed?';assert.equal(question.length,39);assert.equal(new RegExp(args[2].schema.properties.question.pattern).test(question),true);r.text=JSON.stringify({question,generalizable:false});calls++;}return r;};const prep=await prepareQuestionOnly(item('Given a private record, explain the unsupported task.'),o);assert.equal(calls,1);assert.equal(prep.validatedLocalRefusal,true);assert.equal(prep.question,'');assert.equal(prep.baseBlocked,true);assert.equal(prep.stages.find(s=>s.layerId==='llm_check').status,'NOT_RUN_AFTER_BLOCK');assert.equal(prep.stages.some(s=>s.status==='ERROR'),false);
});

test('malformed false replies remain protocol errors instead of becoming validated local refusals',async t=>{
  for(const question of ['','A malformed false reply without a question mark.','How can [PERSON] be assessed?']){const o=await options(t),call=o.dependencies.localCall;o.dependencies.localCall=async(...args)=>{const r=await call(...args);if(args[2].schema.properties.generalizable)r.text=JSON.stringify({question,generalizable:false});return r;};const prep=await prepareQuestionOnly(item('Given a private record, explain the unsupported task.'),o),rewrite=prep.stages.find(s=>s.layerId==='rewrite');assert.notEqual(prep.validatedLocalRefusal,true);assert.equal(prep.baseBlocked,true);assert.equal(rewrite.status,'ERROR');assert.equal(rewrite.attempts.length,4);assert.ok(rewrite.attempts.every(a=>a.code==='PRIVACY_LOCAL_QUESTION_FORMAT'&&!a.recovered));}
});

test('compound private roles stay local and compilation never introduces source export values',async t=>{
  const source='Name: Fictional Larch; Email: larch-r4@example.invalid; Task: Use local rules to calculate the amount. Which product GROVE37 applies?',prep=await prepareQuestionOnly(item(source),await options(t));assert.equal(prep.baseBlocked,false);assert.equal(prep.rewriteStrategy,'compiled_neutral_request');assert.doesNotMatch(prep.question,/Larch|example.invalid|GROVE37/);assert.equal(prep.question.includes('calculate'),true);
});

test('compound compiler keeps all existing arithmetic, table and grouping requirements',()=>{
  const source='Calculate average stock prices by product. Compare supplier costs in a table. Which supplier is preferable?',compiled=compileNeutralRequest(source);assert.equal(compiled.eligible,true);assert.equal(validateQuestionIntent(compiled.question,source).valid,true);const missing=compiled.question.replace('calculate average stock prices by product and ','');assert.equal(validateQuestionIntent(missing,source).valid,false);
});
