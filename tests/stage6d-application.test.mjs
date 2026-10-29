import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {sha256} from '../src/rag/receipts.mjs';
import {createQuestionTokenVault} from '../src/privacy/token-vault.mjs';
import {checkIncomingAnswer,applyAnswerLocally} from '../src/privacy/question-boundary.mjs';
import {privacyDependencies} from './helpers/question-boundary.mjs';
import {buildLocalApplicationContext,computeLocalApplication,localApplicationSchema,validateLocalApplication,localApplicationMessages,assertLocalApplicationInputBudget,rankLocalApplicationSpans} from '../src/privacy/local-application.mjs';

const campaigns=[{campaign:'North',spend_usd:120,conversions:20,cpa_usd:6},{campaign:'South',spend_usd:90,conversions:10,cpa_usd:9},{campaign:'East',spend_usd:180,conversions:30,cpa_usd:6}];
const source=question=>question+'\n'+JSON.stringify({campaigns,private_customer_fields_not_needed_for_task:[{email:'fictional-contact@example.invalid'}]});
const evidence=[{chunkId:'authored-warranty',file:'authored-policy.md',text:'The synthetic pump warranty is 60 months.'}];

test('local source records have content hashes and exclude unrelated private fields from citable campaign evidence',()=>{
  const context=buildLocalApplicationContext(source('Which campaign has the highest CPA?'));
  assert.equal(context.sourceHash,sha256(context.source));assert.ok(context.sourceRecordId.startsWith('local-task:'));assert.equal(context.citable.length,3);assert.ok(context.citable.every(row=>row.chunkId.startsWith('local-record:')));assert.doesNotMatch(JSON.stringify(context.citable),/fictional-contact/);
});
test('campaign extrema use the requested metric rather than spend or record order',()=>{
  const result=computeLocalApplication(buildLocalApplicationContext(source('Which campaign has the highest CPA?')));assert.equal(result.method,'deterministic_campaign_analytics');assert.deepEqual(JSON.parse(result.answer),campaigns[1]);assert.equal(result.calculator.operation,'maximum:cpa_usd');assert.ok(result.calculator.sourceHashes.every(row=>/^[a-f0-9]{64}$/.test(row.hash)));assert.ok(result.citations[0].startsWith('calc:'));
});
test('campaign minimum spend is independently supported',()=>{
  const result=computeLocalApplication(buildLocalApplicationContext(source('Which campaign has the lowest spend?')));assert.equal(JSON.parse(result.answer).campaign,'South');assert.equal(result.calculator.operation,'minimum:spend_usd');
});
test('ties, unsupported extra filters and missing metric intent are not silently guessed',()=>{
  for(const question of ['Which campaign has the lowest CPA?','Which campaign has the highest CPA below a spend limit?','Please summarize these records.'])assert.equal(computeLocalApplication(buildLocalApplicationContext(source(question))),null);
});
test('invalid numeric records fail closed before they can establish a calculation',()=>{
  const body='Which campaign has the highest CPA? '+JSON.stringify({campaigns:[{...campaigns[0],conversions:-1}]});assert.throws(()=>computeLocalApplication(buildLocalApplicationContext(body)),{code:'LOCAL_ANALYTICS_DATA_INVALID'});
});
test('duplicate IDs with conflicting evidence cannot establish a citation contract',()=>{
  assert.throws(()=>buildLocalApplicationContext('What is the warranty?', [...evidence,{...evidence[0],text:'Conflicting evidence.'}]),{code:'LOCAL_APPLICATION_EVIDENCE_CONFLICT'});
});
test('application schema enumerates only actual local IDs and bounded source-span pointers',()=>{
  const context=buildLocalApplicationContext('What is the warranty?',evidence),schema=localApplicationSchema(context);assert.deepEqual(schema.properties.citations.items.enum,['authored-warranty']);assert.equal(schema.properties.citations.minItems,1);assert.equal(schema.properties.answer.type,'array');assert.ok(schema.properties.answer.maxItems<=8);assert.deepEqual(schema.properties.answer.items.enum,context.spans.map(row=>row.spanId));assert.equal(JSON.parse(localApplicationMessages(context,{guidance:'A general method.'})[1].content).applicationMode,'extractive');
});
test('valid-looking invented citation IDs are rejected instead of filtered away',()=>{
  const context=buildLocalApplicationContext('What is the warranty?',evidence);assert.throws(()=>validateLocalApplication({answer:'60 months.',citations:['invented-source']},context),{code:'LOCAL_APPLICATION_CITATION_INVALID'});
});
test('a real citation ID cannot validate unsupported facts or changed units',()=>{
  const context=buildLocalApplicationContext('What is the warranty?',evidence);for(const answer of ['The warranty is 99 months.','60 years.','The policy guarantees approval.'])assert.throws(()=>validateLocalApplication({answer,citations:['authored-warranty']},context),{code:'LOCAL_APPLICATION_SUPPORT_INVALID'});
  assert.equal(validateLocalApplication({answer:'60 months.',citations:['authored-warranty']},context).audit.supported,true);
});
test('every returned excerpt and every listed citation must have matching source support',()=>{
  const context=buildLocalApplicationContext('Give the two policy facts.',[...evidence,{chunkId:'hours',text:'Support opens at nine.'}]);const checked=validateLocalApplication({answer:'60 months.\nSupport opens at nine.',citations:['authored-warranty','hours']},context);assert.equal(checked.audit.claims,2);assert.equal(checked.audit.claimHashes.length,2);assert.throws(()=>validateLocalApplication({answer:'60 months.',citations:['authored-warranty','hours']},context),{code:'LOCAL_APPLICATION_SUPPORT_INVALID'});
});
test('multiple source spans can answer multiple claims and documents without model-generated factual text',()=>{
  const context=buildLocalApplicationContext('Give both policy facts.',[...evidence,{chunkId:'hours',text:'Support opens at nine.'}]),answer=context.spans.map(row=>row.spanId),checked=validateLocalApplication({answer,citations:['authored-warranty','hours']},context);assert.equal(checked.audit.claims,2);assert.match(checked.answer,/60 months/);assert.match(checked.answer,/Support opens at nine/);assert.throws(()=>validateLocalApplication({answer,citations:['hours']},context),{code:'LOCAL_APPLICATION_CITATION_INVALID'});assert.throws(()=>validateLocalApplication({answer:[answer[0],answer[0]],citations:['authored-warranty']},context),{code:'LOCAL_APPLICATION_INVALID'});
});
test('long local passages split into bounded actual spans and can be selected across the entire passage',()=>{
  const text='The fictional local policy applies to this supplied record. '.repeat(30).trim(),context=buildLocalApplicationContext('Quote the supplied passage.',[{chunkId:'passage',text}]);assert.ok(context.spans.length>1&&context.spans.length<=8);assert.ok(context.spans.every(row=>row.text.length<=400));const selected=validateLocalApplication({answer:context.spans.map(row=>row.spanId),citations:['passage']},context);assert.equal(selected.answer.replace(/\s+/g,' ').trim(),text);assert.equal(selected.audit.selectedSpanIds.length,context.spans.length);
});
test('a long supported excerpt remains valid within the compact structured answer contract',()=>{
  const text='The fictional retention policy is stated here. '.repeat(40).trim(),context=buildLocalApplicationContext('Quote the supplied policy.',[{chunkId:'long-policy',text}]);assert.ok(text.length<2400);assert.equal(validateLocalApplication({answer:text,citations:['long-policy']},context).audit.supported,true);
});

test('gateway source envelopes are unwrapped instead of duplicating retrieved evidence in model input',()=>{
  const task='What is the warranty?',source=JSON.stringify({question:task,evidence});const context=buildLocalApplicationContext(source,evidence),body=JSON.parse(localApplicationMessages(context)[1].content);assert.equal(body.task,task);assert.equal(body.evidence.length,1);assert.equal(JSON.stringify(body).split(evidence[0].text).length-1,1);assert.equal(context.sourceHash,sha256(source));
});
test('oversized local evidence fails closed without silently dropping a required source',()=>{
  const context=buildLocalApplicationContext('Quote the supplied text.',[{chunkId:'large-source',text:'A long but authored development policy. '.repeat(1000)}]);assert.throws(()=>assertLocalApplicationInputBudget(localApplicationMessages(context)),{code:'LOCAL_APPLICATION_CONTEXT_BUDGET'});assert.equal(context.citable.length,1);
});
test('actual request extraction preserves operands while keeping record totals out of calculator task text',()=>{
  const task='This is a fictional record export containing 9999 rows.\nCalculate the price for 2 units.\n'+JSON.stringify({campaigns});const context=buildLocalApplicationContext(task);assert.equal(context.question,'Calculate the price for 2 units.');assert.equal(context.source,task);assert.equal(context.sourceHash,sha256(task));assert.equal(context.records.length,3);
});
test('nested task envelopes retain their real campaign records after request-clause extraction',()=>{
  const task=JSON.stringify({question:source('Which campaign has the highest CPA?'),evidence:[]}),context=buildLocalApplicationContext(task);assert.equal(context.records.length,3);assert.equal(JSON.parse(computeLocalApplication(context).answer).campaign,'South');
});
test('actual-question relevance ranks relevant hash-bound evidence before an unrelated span without dropping sources',()=>{
  const context=buildLocalApplicationContext('What is the warranty?',[{chunkId:'inventory',text:'Inventory stock is counted daily.'},...evidence]),plan=rankLocalApplicationSpans(context),body=JSON.parse(localApplicationMessages(context)[1].content);assert.equal(plan.ranked[0].chunkId,'authored-warranty');assert.equal(body.evidence[0].chunkId,'authored-warranty');assert.equal(context.spans.length,2);assert.equal(context.citable.length,2);assert.throws(()=>validateLocalApplication({answer:[context.spans[0].spanId],citations:['inventory']},context),{code:'LOCAL_APPLICATION_RELEVANCE_INVALID'});
});
test('query facets require relevant facts across multiple supplied documents',()=>{
  const context=buildLocalApplicationContext('What are the warranty and support hours?',[...evidence,{chunkId:'support-hours',text:'Support hours are nine to five.'}]);assert.throws(()=>validateLocalApplication({answer:[context.spans[0].spanId],citations:['authored-warranty']},context),{code:'LOCAL_APPLICATION_RELEVANCE_INVALID'});const result=validateLocalApplication({answer:context.spans.map(row=>row.spanId),citations:context.allowedIds},context);assert.equal(result.audit.relevance.requiredFacets,2);assert.equal(result.audit.relevance.selectedFacets,2);assert.equal(result.audit.claims,2);
});
test('absent source entities are diagnosed honestly and never injected from a reference',()=>{
  const context=buildLocalApplicationContext('What is the warranty for PX700?',[{chunkId:'unrelated',text:'Support hours are nine to five.'}]),plan=rankLocalApplicationSpans(context);assert.equal(plan.audit.missingEntityAnchors,1);assert.equal(plan.audit.queryTermsAvailable,0);assert.equal(context.citable.length,1);assert.match(plan.audit.method,/not a semantic fact-coverage certificate/);assert.equal(context.citable[0].text,'Support hours are nine to five.');
});

async function checkedFixture(t,{task='What is the warranty?',localCall}={}){
  const directory=await mkdtemp(path.join(os.tmpdir(),'handoff-application-'));t.after(()=>rm(directory,{recursive:true,force:true}));
  const vault=await createQuestionTokenVault(directory,{keyDirectory:path.join(directory,'keys')}),question='How can the private task be answered using local evidence?';
  const prepared={id:'authored-application',lens:'meta',item:{id:'authored-application',safety:{kind:'safe',cloudEligible:true}},sourceText:task,sourceHash:sha256(task),question,questionHash:sha256(question),privateValues:[],stages:[],baseBlocked:false,vault,tokenizedLocalSource:vault.tokenizeValues(task,[]).text};await vault.save();
  const dependencies=privacyDependencies(),checked=await checkIncomingAnswer(prepared,'Use only the actual local evidence.',{dependencies});if(localCall)dependencies.localCall=localCall;return{prepared,checked,dependencies};
}
const response=(value,extra={})=>({modelId:'authored-mocked-local',text:JSON.stringify(value),tokens:{input:20,output:20,total:40},settings:{maxTokens:1024,contextTokens:4096},doneReason:'stop',...extra});

test('after Guard and AES proof, the campaign tool applies actual records with no answer-generation call',async t=>{
  let calls=0;const fixture=await checkedFixture(t,{task:source('Which campaign has the highest CPA?'),localCall:async()=>{calls++;throw Error('Must not generate an invented record');}});const result=await applyAnswerLocally(fixture.prepared,fixture.checked,{dependencies:fixture.dependencies});assert.equal(calls,0);assert.equal(result.completionKnown,true);assert.equal(result.tokenRoundTripVerified,true);assert.equal(JSON.parse(result.answer).campaign,'South');assert.equal(result.application.method,'deterministic_campaign_analytics');assert.equal(result.application.attempts.length,0);assert.equal(result.application.calculator.status,'computed');
});
test('citation-only repair is bounded and retains the first failed attempt and its tokens',async t=>{
  let calls=0;const fixture=await checkedFixture(t,{localCall:async()=>response({answer:'60 months.',citations:++calls===1?['unknown']:['authored-warranty']})});const result=await applyAnswerLocally(fixture.prepared,fixture.checked,{localContext:evidence,dependencies:fixture.dependencies});assert.equal(calls,2);assert.equal(result.application.attempts[0].code,'LOCAL_APPLICATION_CITATION_INVALID');assert.equal(result.application.attempts[0].recovered,true);assert.equal(result.application.executionErrorsAttempted,1);assert.equal(result.application.executionErrorsRecovered,1);assert.equal(result.stage.tokens.total,80);assert.equal(result.application.citationRepairUsed,true);
});
test('repeated invalid citations fail closed with both attempts retained',async t=>{
  let calls=0;const fixture=await checkedFixture(t,{localCall:async()=>{calls++;return response({answer:'60 months.',citations:['unknown']});}});await assert.rejects(applyAnswerLocally(fixture.prepared,fixture.checked,{localContext:evidence,dependencies:fixture.dependencies}),error=>error.code==='LOCAL_APPLICATION_CITATION_INVALID'&&error.attemptStages.length===2&&error.attemptStages.every(row=>row.status==='ERROR'&&!row.recovered));assert.equal(calls,2);
});
test('truncation repairs use the configured 1024 cap and preserve the truncation event',async t=>{
  let calls=0;const caps=[];const fixture=await checkedFixture(t,{localCall:async(_lens,_messages,options)=>{caps.push(options.maxTokens);return response({answer:'60 months.',citations:['authored-warranty']},++calls===1?{doneReason:'length',tokens:{input:20,output:1024,total:1044}}:{});}});const result=await applyAnswerLocally(fixture.prepared,fixture.checked,{localContext:evidence,dependencies:fixture.dependencies});assert.deepEqual(caps,[1024,1024]);assert.equal(result.application.attempts[0].code,'PRIVACY_LOCAL_TRUNCATED');assert.equal(result.application.attempts[0].recovered,true);assert.equal(result.stage.tokens.output,1044);
});
test('unsupported facts cannot pass by merely repeating a valid source ID',async t=>{
  const fixture=await checkedFixture(t,{localCall:async()=>response({answer:'The warranty is 99 months.',citations:['authored-warranty']})});await assert.rejects(applyAnswerLocally(fixture.prepared,fixture.checked,{localContext:evidence,dependencies:fixture.dependencies}),error=>error.code==='LOCAL_APPLICATION_SUPPORT_INVALID'&&error.attemptStages.length===2);
});
test('a missing application permit cannot invoke even the deterministic tool',async t=>{
  const fixture=await checkedFixture(t,{task:source('Which campaign has the highest CPA?')});await assert.rejects(applyAnswerLocally(fixture.prepared,{...fixture.checked,checkPermit:{}},{dependencies:fixture.dependencies}),{code:'CHECKED_LOCAL_APPLICATION_REQUIRED'});
});
test('source mutations during an answer attempt are detected before returning any answer',async t=>{
  const fixture=await checkedFixture(t);fixture.dependencies.localCall=async()=>{fixture.prepared.sourceText+=' changed';return response({answer:'60 months.',citations:['authored-warranty']});};await assert.rejects(applyAnswerLocally(fixture.prepared,fixture.checked,{localContext:evidence,dependencies:fixture.dependencies}),{code:'CHECKED_LOCAL_APPLICATION_REQUIRED'});
});
test('a transport failure is not an answer-protocol retry and retains only safe HTTP metadata',async t=>{
  let calls=0;const fixture=await checkedFixture(t,{localCall:async()=>{calls++;throw Object.assign(Error('Do not publish this backend body'),{code:'LOCAL_HTTP_ERROR',status:503,modelId:'authored-local',requestHash:'c'.repeat(64)});}});await assert.rejects(applyAnswerLocally(fixture.prepared,fixture.checked,{localContext:evidence,dependencies:fixture.dependencies}),error=>error.code==='LOCAL_HTTP_ERROR'&&error.attemptStages.length===1&&error.attemptStages[0].httpStatus===503&&error.attemptStages[0].requestHash==='c'.repeat(64));assert.equal(calls,1);
});
