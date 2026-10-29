import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {prepareQuestionOnly,screenQuestionOnly,validateQuestionIntent,validateGeneralQuestion,neutralizePrivateTask,prepareIncomingAnswer,makeInboundContext} from '../src/privacy/question-boundary.mjs';
import {privacyDependencies} from './helpers/question-boundary.mjs';

// Authored benign fixtures, not copied from the frozen evaluation frame.
async function setup(t,question){const dir=await mkdtemp(path.join(os.tmpdir(),'handoff-stage6d-dev-'));t.after(()=>rm(dir,{recursive:true,force:true}));return{dataDir:dir,dependencies:{...privacyDependencies({question}),keyDirectory:path.join(dir,'keys')}};}
const item=prompt=>({id:'authored-stage6d',prompt,safety:{kind:'safe',cloudEligible:true}});
const reply=(value,options,extra={})=>({text:JSON.stringify(value),modelId:'authored-local-model',doneReason:'stop',tokens:{input:5,output:5,total:10},settings:{maxTokens:options.maxTokens,contextTokens:4096},...extra});

test('conditional explanation clauses preserve the wrapper and every domain operation',()=>{
  const source='Explain how to calculate average stock costs and compare suppliers in a table.';
  for(const lead of ['Given the stock costs,','Assuming the stock costs,','Considering the stock costs,','Based on the stock costs,'])assert.equal(validateQuestionIntent(lead+' how can average stock costs be calculated and suppliers compared in a table?',source).valid,true);
  for(const candidate of ['Given stock costs, how can suppliers be compared in a table?','Given stock costs, how can average stock costs be calculated in a table?','Given stock costs, how can average stock costs be calculated and suppliers compared?'])assert.equal(validateQuestionIntent(candidate,source).valid,false);
});

test('only finite generic role spellings normalize; freeform or indexed markers remain invalid',()=>{
  assert.equal(neutralizePrivateTask('How can a reply to [customer_name] about [product] be drafted?').text,'How can a reply to [PERSON] about [PRODUCT] be drafted?');
  for(const marker of ['[customer_A]','[customer_45]','[unknown_role]'])assert.equal(validateGeneralQuestion(neutralizePrivateTask('How can a reply to '+marker+' be drafted?').text).valid,false);
});

test('placeholder-only swaps do not invent a new requested identity topic',()=>{
  assert.equal(validateQuestionIntent('How can unit prices for [PRODUCT] be compared?','How can unit prices for [IDENTIFIER] be compared?').valid,true);
  assert.equal(validateQuestionIntent('How can [PRODUCT] be compared?','Calculate average unit prices for [IDENTIFIER] in a table.').valid,false);
});

test('valid source questions are preserved before screening; evidence and private organization names stay local',async t=>{
  const options=await setup(t),real=options.dependencies.localCall;let rewrites=0,checks=0;
  options.dependencies.localCall=async(...args)=>{if(args[2].schema.properties.generalizable)rewrites++;else if(args[2].schema.properties.private_values)checks++;return real(...args);};
  const source=JSON.stringify({company_name:'Fictional Alder Labs',question:'How can average stock costs for Fictional Alder Labs be calculated?',evidence:[{text:'AUTHORED EVIDENCE REMAINS LOCAL'}]});
  const prepared=await prepareQuestionOnly(item(source),options);assert.equal(prepared.baseBlocked,false);assert.equal(prepared.rewriteStrategy,'preserved_valid_task');assert.equal(rewrites,0);assert.equal(checks,1);assert.match(prepared.question,/\[COMPANY\]/);assert.equal(prepared.question.includes('Alder'),false);assert.equal(prepared.question.includes('EVIDENCE'),false);assert.ok(prepared.injectionScanTexts.includes(source));
});

test('unknown proper names are replaced, never accepted through an expanded name allowlist',async t=>{
  const prepared=await prepareQuestionOnly(item('How can stock costs for Imaginary Birch be calculated?'),await setup(t));assert.equal(prepared.baseBlocked,false);assert.equal(prepared.question.includes('Imaginary'),false);assert.match(prepared.question,/\[VALUE\]/);assert.equal(validateGeneralQuestion('How can stock costs for Imaginary Birch be calculated?').valid,false);
});

test('only a single actual question can be preserved; short record prefixes use local abstraction',async t=>{
  for(const source of ['How can average stock costs be calculated?','Given the stock costs, how can average stock prices be calculated?']){const options=await setup(t),prep=await prepareQuestionOnly(item(source),options);assert.equal(prep.baseBlocked,false);assert.equal(prep.rewriteStrategy,'preserved_valid_task');}
  for(const source of ['stock status: a confidential internal note; how can average stock costs be calculated?','How can costs be calculated? Which supplier is best?']){
    const options=await setup(t,'How can average stock costs be calculated?'),real=options.dependencies.localCall;let calls=0;options.dependencies.localCall=async(...args)=>{if(args[2].schema.properties.generalizable)calls++;return real(...args);};const prep=await prepareQuestionOnly(item(source),options);assert.equal(calls,1);assert.equal(prep.rewriteStrategy,'model_rewrite');assert.equal(prep.question.includes('confidential'),false);assert.equal(prep.question.includes('internal evidence'),false);
  }
  const extracted=await prepareQuestionOnly(item('internal evidence. How can average stock costs be calculated?'),await setup(t));assert.equal(extracted.rewriteStrategy,'preserved_valid_task');assert.equal(extracted.question.includes('internal evidence'),false);
});

test('preservation does not skip candidate privacy inspection or any original/decoded/candidate screen',async t=>{
  const options=await setup(t),seen={};options.dependencies.decode=text=>({variants:text.includes('encoded')?[{text:'A separate harmless decoded task.'}]:[],failClosed:false});
  options.dependencies.promptGuard=async(texts,{variant})=>{seen.texts=texts;return{status:'BLOCKED',detected:true,available:true,variant,latencyMs:1};};let checks=0;const real=options.dependencies.localCall;options.dependencies.localCall=async(...args)=>{if(args[2].schema.properties.private_values)checks++;return real(...args);};
  const source='How can an encoded software process be explained?',prep=await prepareQuestionOnly(item(source),options),screen=await screenQuestionOnly(prep,{shadowEvaluation:true,dependencies:options.dependencies});assert.equal(checks,1);assert.equal(screen.hypotheticalBlocked,true);assert.ok(seen.texts.includes(source));assert.ok(seen.texts.includes(prep.question));assert.equal(screen.liveEligible,false);
});

test('a harmful-content verdict cannot trigger alternate rewrites or source fallback',async t=>{
  const options=await setup(t),prep=await prepareQuestionOnly(item('How can software process status be explained?'),options),hash=prep.questionHash;let calls=0;
  options.dependencies.harmfulGuard=async()=>{calls++;return{safe:false,classification:'unsafe',latencyMs:1};};const screen=await screenQuestionOnly(prep,{dependencies:options.dependencies});assert.equal(calls,1);assert.equal(screen.questionHash,hash);assert.ok(screen.blockedByLayer.includes('HARMFUL_CONTENT'));assert.equal(screen.liveEligible,false);
});

test('rewrite truncation is repaired with all attempts and tokens retained',async t=>{
  const options=await setup(t);let rewriteCalls=0;const real=options.dependencies.localCall;
  options.dependencies.localCall=async(lens,messages,args)=>{if(!args.schema.properties.generalizable)return real(lens,messages,args);rewriteCalls++;return rewriteCalls===1?reply({},args,{doneReason:'length',tokens:{input:7,output:192,total:199},evaluationCallHash:'a'.repeat(64),evaluationReused:false}):reply({question:'How can average stock costs be calculated?',generalizable:true},args,{evaluationCallHash:'b'.repeat(64),evaluationReused:true});};
  const prep=await prepareQuestionOnly(item('Calculate average stock costs.'),options),stage=prep.stages.find(x=>x.layerId==='rewrite');assert.equal(prep.baseBlocked,false);assert.equal(rewriteCalls,2);assert.equal(stage.recovered,true);assert.equal(stage.attempts[0].code,'PRIVACY_LOCAL_TRUNCATED');assert.equal(stage.attempts[0].recovered,true);assert.equal(stage.tokens.total,209);assert.equal(stage.status,'PASS');assert.equal(stage.attempts[0].callHash,'a'.repeat(64));assert.equal(stage.attempts[0].reused,false);assert.equal(stage.attempts[1].reused,true);
});

test('unresolved protocol errors fail closed after exactly three repair retries',async t=>{
  const options=await setup(t);let calls=0;options.dependencies.localCall=async(_lens,_messages,args)=>{calls++;return reply({},args,{doneReason:'length'});};const prep=await prepareQuestionOnly(item('Calculate average stock costs.'),options),stage=prep.stages.find(x=>x.layerId==='rewrite');assert.equal(calls,4);assert.equal(prep.baseBlocked,true);assert.equal(stage.status,'ERROR');assert.equal(stage.attempts.length,4);assert.equal(stage.recovered,false);assert.ok(prep.reasons.includes('PRIVACY_LOCAL_TRUNCATED'));
});

test('invalid marker grammar is a visible schema repair and cannot create freeform outbound placeholders',async t=>{
  const options=await setup(t);let calls=0;const real=options.dependencies.localCall;
  options.dependencies.localCall=async(lens,messages,args)=>{if(!args.schema.properties.generalizable)return real(lens,messages,args);calls++;return reply({question:calls===1?'How can stock costs for [unknown_role] be calculated?':'How can stock costs for [VALUE] be calculated?',generalizable:true},args);};const prep=await prepareQuestionOnly(item('Calculate stock costs.'),options),stage=prep.stages.find(x=>x.layerId==='rewrite');assert.equal(prep.baseBlocked,false);assert.equal(calls,2);assert.equal(stage.attempts[0].code,'PRIVACY_LOCAL_QUESTION_FORMAT');assert.equal(stage.attempts[0].recovered,true);assert.equal(prep.question.includes('unknown_role'),false);
});

test('invalid literal spans repair against the exact candidate, not source or example content',async t=>{
  const options=await setup(t);let checks=0;const real=options.dependencies.localCall;
  options.dependencies.localCall=async(lens,messages,args)=>{if(args.schema.properties.private_spans){checks++;return reply({private_spans:[]},args);}if(!args.schema.properties.private_values)return real(lens,messages,args);checks++;return reply({private_values:[{type:'person',value:'An Invented Span'}]},args,{evaluationCallHash:'invalid'});};const prep=await prepareQuestionOnly(item('How can average stock costs be calculated?'),options),stage=prep.stages.find(x=>x.layerId==='llm_check');assert.equal(prep.baseBlocked,false);assert.equal(checks,2);assert.equal(stage.attempts[0].code,'PRIVACY_LOCAL_INVALID_SPAN');assert.equal(stage.recovered,true);assert.equal('callHash' in stage.attempts[0],false);
});

test('valid private findings are never retried away on the inbound path',async()=>{
  const dependencies=privacyDependencies();let checks=0;dependencies.localCall=async(_lens,_messages,args)=>{checks++;return reply({private_values:[{type:'person',value:'Imaginary Birch'}]},args);};const checked=await prepareIncomingAnswer(makeInboundContext(item('Explain stock cost trends.')),'Ask Imaginary Birch for the stock report.',{dependencies});assert.equal(checks,1);assert.equal(checked.blocked,true);assert.equal(checked.privacyDetected,true);assert.equal(checked.code,'OUTPUT_PRIVATE_DETAILS');assert.equal(checked.stages[0].tokens.total,10);
});

test('inbound invalid spans use the same bounded repairs without changing incoming content',async()=>{
  const dependencies=privacyDependencies();let checks=0;dependencies.localCall=async(_lens,_messages,args)=>{checks++;return reply(args.schema.properties.private_spans?{private_spans:[]}:{private_values:[{type:'person',value:'An Invented Span'}]},args);};const text='Compare stock costs across the available local records.',checked=await prepareIncomingAnswer(makeInboundContext(item('Explain stock cost trends.')),text,{dependencies});assert.equal(checked.blocked,false);assert.equal(checks,2);assert.equal(checked.text,text);assert.equal(checked.stages[0].recovered,true);assert.equal(checked.stages[0].tokens.total,20);
});
