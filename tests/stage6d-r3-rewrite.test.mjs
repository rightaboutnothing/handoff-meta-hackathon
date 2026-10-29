import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {compileNeutralRequest,prepareQuestionOnly,screenQuestionOnly,prepareIncomingAnswer,makeInboundContext,validateQuestionIntent,validateGeneralQuestion} from '../src/privacy/question-boundary.mjs';
import {privacyDependencies} from './helpers/question-boundary.mjs';
const item=prompt=>({id:'authored-r3',prompt,safety:{kind:'safe',cloudEligible:true}});
async function options(t,question){const dataDir=await mkdtemp(path.join(os.tmpdir(),'handoff-r3-compiler-'));t.after(()=>rm(dataDir,{recursive:true,force:true}));return{dataDir,dependencies:{...privacyDependencies({question}),keyDirectory:path.join(dataDir,'keys')}};}

const compiledCases=[
  ['Calculate average stock costs and round the amount.','How can someone calculate average stock costs and round the amount?'],
  ['Calculate average unit costs. Compare suppliers in a table.','How can someone calculate average unit costs and compare suppliers in a table?'],
  ['Write a reply about a delayed parcel.','How can someone write a reply about a delayed parcel?'],
  ['Calculate average invoice costs and return JSON.','How can someone calculate average invoice costs and return JSON?'],
  ['Please summarize ticket trends by product and compare response times in a table.','How can someone summarize ticket trends by product and compare response times in a table?'],
];
for(const [source,question]of compiledCases)test('source-bound compiler retains actual request: '+source,()=>{const compiled=compileNeutralRequest(source);assert.equal(compiled.question,question);assert.equal(compiled.eligible,true);assert.equal(validateQuestionIntent(question,source).valid,true);assert.equal(validateGeneralQuestion(question).valid,true);});

test('compiler never copies record facts, prefixes or inline exports',()=>{
  assert.equal(compileNeutralRequest('The record belongs to fictional Maple Works. Calculate average unit costs.').question,'How can someone calculate average unit costs?');
  assert.equal(compileNeutralRequest('Calculate average stock costs.\n\n{"records":[{"name":"Fictional Cedar","amount":27}]}').question,'How can someone calculate average stock costs?');
  for(const source of ['Analyze data: {"record":"synthetic"}.','Given the record, calculate average unit costs.','For the record, calculate average unit costs.','Consider this private situation in context.'])assert.equal(compileNeutralRequest(source).eligible,false);
});

test('compiled overflow is rejected intact and never silently trimmed',()=>{
  const source='Compare '+Array.from({length:80},()=> 'supplier prices').join(' and ')+'.',compiled=compileNeutralRequest(source);assert.equal(compiled.eligible,false);assert.equal(compiled.code,'COMPILER_OVER_CHARACTER_LIMIT');assert.equal(compiled.question,undefined);
});

test('valid original questions are preserved before compiler and imperative paths avoid rewriting',async t=>{
  for(const [source,strategy]of [['How can average costs be calculated?','preserved_valid_task'],['Calculate average stock costs.','compiled_neutral_request']]){const o=await options(t),call=o.dependencies.localCall;let rewrites=0,privacy=0;o.dependencies.localCall=async(...args)=>{if(args[2].schema.properties.generalizable)rewrites++;if(args[2].schema.properties.private_values)privacy++;return call(...args);};const prep=await prepareQuestionOnly(item(source),o);assert.equal(prep.baseBlocked,false);assert.equal(prep.rewriteStrategy,strategy);assert.equal(rewrites,0);assert.equal(privacy,1);assert.equal(prep.stages.find(s=>s.layerId==='rewrite').tokens.total,0);}
});

test('compiled private-source roles still traverse strict privacy and every original safety input',async t=>{
  const source='Name: Fictional Rowan; Email: rowan-r3@example.invalid; Task: Write a reply to Fictional Rowan about product MAPLE28.',o=await options(t);let inputs;o.dependencies.promptGuard=async(texts,{variant})=>{inputs=texts;return{status:'PASS',available:true,detected:false,variant,latencyMs:1};};const prep=await prepareQuestionOnly(item(source),o),screen=await screenQuestionOnly(prep,{dependencies:o.dependencies});assert.equal(prep.rewriteStrategy,'compiled_neutral_request');assert.equal(prep.baseBlocked,false);assert.doesNotMatch(prep.question,/Rowan|example.invalid|MAPLE28/);assert.ok(inputs.includes(source));assert.ok(inputs.includes(prep.question));assert.equal(screen.hypotheticalBlocked,false);
});

test('an unsafe Guard verdict never chooses a different candidate after compilation',async t=>{
  const o=await options(t),call=o.dependencies.localCall;let rewrites=0;o.dependencies.localCall=async(...args)=>{if(args[2].schema.properties.generalizable)rewrites++;return call(...args);};o.dependencies.harmfulGuard=async()=>({safe:false,classification:'unsafe',latencyMs:1});const prep=await prepareQuestionOnly(item('Explain software status messages.'),o),hash=prep.questionHash,screen=await screenQuestionOnly(prep,{dependencies:o.dependencies});assert.equal(screen.hypotheticalBlocked,true);assert.equal(screen.questionHash,hash);assert.equal(rewrites,0);assert.equal(screen.liveEligible,false);
});

test('a parsed valid refusal with prose is blocked without formatting it as a question or inspecting empty text',async t=>{
  const o=await options(t),call=o.dependencies.localCall;let privacy=0;o.dependencies.localCall=async(...args)=>{const reply=await call(...args);if(args[2].schema.properties.generalizable)reply.text=JSON.stringify({question:'A local refusal without a question mark.',generalizable:false});if(args[2].schema.properties.private_values)privacy++;return reply;};const prep=await prepareQuestionOnly(item('Given a private record, explain an unsupported task.'),{...o,shadowEvaluation:true});assert.equal(prep.baseBlocked,true);assert.equal(prep.validatedLocalRefusal,true);assert.equal(prep.question,'');assert.equal(privacy,0);assert.equal(prep.stages.find(s=>s.layerId==='llm_check').status,'NOT_RUN_AFTER_BLOCK');assert.equal(prep.stages.find(s=>s.layerId==='tokenize').status,'NOT_RUN_AFTER_BLOCK');assert.equal(prep.stages.some(s=>s.status==='ERROR'),false);
});

test('true empty or overlong model replies remain bounded errors despite maxLength-only schema',async t=>{
  for(const question of ['', 'How can '+ 'ordinary '.repeat(40)+'costs be calculated?']){const o=await options(t),call=o.dependencies.localCall;o.dependencies.localCall=async(...args)=>{assert.equal(args[2].schema.properties.question?.pattern,undefined);const reply=await call(...args);if(args[2].schema.properties.generalizable)reply.text=JSON.stringify({question,generalizable:true});return reply;};const prep=await prepareQuestionOnly(item('Given a private record, calculate average costs.'),o),stage=prep.stages.find(s=>s.layerId==='rewrite');assert.equal(prep.baseBlocked,true);assert.equal(stage.status,'ERROR');assert.equal(stage.attempts.length,4);assert.equal(stage.code,'PRIVACY_LOCAL_QUESTION_FORMAT');}
});

test('unresolved literal execution failures retain both privacy-positive and availability flags',async()=>{
  const dependencies=privacyDependencies();dependencies.localCall=async(_lens,_messages,{maxTokens})=>({modelId:'authored-local',doneReason:'stop',settings:{maxTokens,contextTokens:4096},tokens:{input:5,output:5,total:10},text:JSON.stringify({private_values:[{value:'Fictional Rowan',type:'person'},{value:'Absent Sibling',type:'person'}]})});const checked=await prepareIncomingAnswer(makeInboundContext(item('Explain stock costs.')),'Contact Fictional Rowan for the report.',{dependencies});assert.equal(checked.blocked,true);assert.equal(checked.privacyDetected,true);assert.equal(checked.availabilityError,true);assert.equal(checked.stages[0].status,'ERROR');
});

test('compiler strategy remains proof-bound',async t=>{
  const o=await options(t),prep=await prepareQuestionOnly(item('Calculate average stock costs.'),o);prep.rewriteStrategy='preserved_valid_task';const screen=await screenQuestionOnly(prep,{dependencies:o.dependencies});assert.ok(screen.blockedByLayer.includes('PREPARATION_PROOF_REQUIRED'));assert.equal(screen.liveEligible,false);
});
