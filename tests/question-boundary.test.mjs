import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir,rm} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createQuestionTokenVault} from '../src/privacy/token-vault.mjs';
import {prepareQuestionOnly,screenQuestionOnly,buildQuestionOnlyPayload,assertQuestionOnlyRelease,rehydratePrepared,rehydrateIncomingAnswer,validateGeneralQuestion,makeInboundContext,prepareIncomingAnswer,finishIncomingAnswer,applyAnswerLocally} from '../src/privacy/question-boundary.mjs';
import {runPromptGuard,createPromptGuardMailbox} from '../src/privacy/prompt-guard.mjs';
import {callMuse,screenForCloud} from '../src/server/gateway-models.mjs';
import {createCloudPolicyRegistry} from '../src/comparison/policy.mjs';
import {readLiveMuseConfig} from '../src/server/live-muse.mjs';
import {privacyDependencies,GENERAL_TEST_QUESTION} from './helpers/question-boundary.mjs';
import {sha256} from '../src/rag/receipts.mjs';

const safeItem={id:'synthetic-private-task',suite:'company-rag',category:'company-data single-doc',safety:{kind:'safe',cloudEligible:true},prompt:'Analyze a fictional private sales report.'};
async function directory(t){const folder=await mkdtemp(path.join(os.tmpdir(),'handoff-question-boundary-'));t.after(async()=>{assert.equal(path.dirname(path.resolve(folder)),path.resolve(os.tmpdir()));assert.ok(path.basename(folder).startsWith('handoff-question-boundary-'));await rm(folder,{recursive:true,force:true});});return folder;}
async function prepared(t,options={}){const dataDir=await directory(t);return prepareQuestionOnly(safeItem,{dataDir,...options,dependencies:{...(options.dependencies??privacyDependencies()),keyDirectory:path.join(dataDir,'machine-local-test-keys')}});}

test('local vault uses opaque random tokens and AES-GCM encrypted storage with local-only restoration',async t=>{
  const folder=await directory(t),keyDirectory=path.join(folder,'test-machine-keys'),vault=await createQuestionTokenVault(folder,{keyDirectory}),text='Contact: synthetic-person@example.invalid',start=text.indexOf('synthetic-person');
  const redacted=vault.tokenize(text,[{start,end:text.length,type:'EMAIL'}]);assert.match(redacted.text,/\[\[LOCAL_[a-f0-9]{32}\]\]/);assert.equal(redacted.text.includes('example.invalid'),false);assert.equal(vault.restore(redacted.text),text);assert.equal(vault.abstract(redacted.text),'Contact: a private entity');
  await vault.save();const stored=await readFile(path.join(folder,'question-map.enc.json'),'utf8');assert.equal(stored.includes('example.invalid'),false);assert.equal(JSON.parse(stored).algorithm,'aes-256-gcm');assert.equal((await createQuestionTokenVault(folder,{keyDirectory})).restore(redacted.text),text);assert.equal(JSON.stringify(vault).includes('key'),false);assert.throws(()=>vault.restore('[[LOCAL_ffffffffffffffffffffffffffffffff]]'),/Unknown local privacy token/);
});

test('question preparation orders layers and records only safe metadata',async t=>{
  const result=await prepared(t);assert.deepEqual(result.stages.map(row=>row.layerId),['decode','patterns','rewrite','llm_check','tokenize']);assert.equal(result.question,GENERAL_TEST_QUESTION);assert.equal(result.baseBlocked,false);
  assert.equal(JSON.stringify(result.stages).includes(safeItem.prompt),false);assert.equal(JSON.stringify(result.stages).includes(GENERAL_TEST_QUESTION),false);assert.equal(result.questionHash,sha256(result.question));assert.equal(result.vault.stats().encryptedAtRest,true);
});

test('missing local Prompt Guard blocks both lenses while later local shadow checks remain clearly separated',async t=>{
  for(const lens of ['meta','google']){
    const dependencies=privacyDependencies();let harmful=0;dependencies.promptGuard=async(_,{variant})=>({status:'PENDING',available:false,detected:false,variant,latencyMs:0});dependencies.harmfulGuard=async()=>{harmful++;return{safe:true,classification:'safe',latencyMs:0};};
    const prep=await prepared(t,{lens,dependencies,shadowEvaluation:true}),result=await screenQuestionOnly(prep,{setup:lens,shadowEvaluation:true,dependencies});assert.equal(result.injectionPending,true);assert.equal(result.hypotheticalBlocked,true);assert.equal(result.liveEligible,false);assert.equal(result.releasePermit,null);assert.equal(result.shadowDetection.injection,false);assert.equal(harmful,1);
  }
});

test('Google native-only omits the injection layer and can never be live eligible',async t=>{
  const dependencies=privacyDependencies(),prep=await prepared(t,{lens:'google',dependencies}),result=await screenQuestionOnly(prep,{setup:'google-native-only',dependencies});assert.equal(result.hypotheticalBlocked,false);assert.equal(result.liveEligible,false);assert.equal(result.releasePermit,null);assert.equal(result.stages.find(row=>row.layerId==='prompt_guard_86m').status,'OMITTED_CONTROL');
});

test('all prior layers must be genuinely prepared; fabricated or mutated state cannot authorize a release',async t=>{
  const dependencies=privacyDependencies(),prep=await prepared(t),fabricated={...prep};const fake=await screenQuestionOnly(fabricated,{dependencies});assert.equal(fake.liveEligible,false);assert.ok(fake.blockedByLayer.includes('PREPARATION_PROOF_REQUIRED'));
  prep.question='How can a different private method be used?';const changed=await screenQuestionOnly(prep,{dependencies});assert.equal(changed.liveEligible,false);assert.ok(changed.blockedByLayer.includes('PREPARATION_PROOF_REQUIRED'));
});

test('outgoing proof binds original and decoded scan texts, private values and restoration context',async t=>{
  for(const mutate of [prep=>{prep.injectionScanTexts=['A different harmless inspection input.'];},prep=>{prep.privateValues.push({type:'PRIVATE',value:'a different local value'});},prep=>{prep.tokenizedLocalSource+=' changed';}]){
    const dependencies=privacyDependencies(),prep=await prepared(t);mutate(prep);const result=await screenQuestionOnly(prep,{dependencies});assert.equal(result.liveEligible,false);assert.equal(result.releasePermit,null);assert.ok(result.blockedByLayer.includes('PREPARATION_PROOF_REQUIRED'));
  }
  const dependencies=privacyDependencies(),prep=await prepared(t),predict=dependencies.promptGuard;dependencies.promptGuard=async(...args)=>{prep.injectionScanTexts.push('Another harmless input.');return predict(...args);};const result=await screenQuestionOnly(prep,{dependencies});assert.equal(result.liveEligible,false);assert.ok(result.blockedByLayer.includes('PREPARATION_PROOF_REQUIRED'));
});

test('fresh question release binds the exact minimal body, expires and is consumed once',async t=>{
  let now=1000;t.mock.method(Date,'now',()=>now);const dependencies=privacyDependencies(),prep=await prepared(t),result=await screenQuestionOnly(prep,{dependencies});const input=buildQuestionOnlyPayload(result.question);
  assert.deepEqual(Object.keys(JSON.parse(input)).sort(),['question','system']);assert.equal(input.includes(safeItem.prompt),false);assert.equal(assertQuestionOnlyRelease(input,result.releasePermit),true);assert.throws(()=>assertQuestionOnlyRelease(input,result.releasePermit),{code:'QUESTION_ONLY_FRESH_RELEASE_REQUIRED'});
  const next=await screenQuestionOnly(prep,{dependencies});now+=30001;assert.throws(()=>assertQuestionOnlyRelease(input,next.releasePermit),{code:'QUESTION_ONLY_FRESH_RELEASE_REQUIRED'});
  const other=await screenQuestionOnly(prep,{dependencies});assert.throws(()=>assertQuestionOnlyRelease(input+' ',other.releasePermit),{code:'QUESTION_ONLY_FRESH_RELEASE_REQUIRED'});
});

test('evaluation and rehydrated checkpoints cannot mint production permits',async t=>{
  const dependencies=privacyDependencies(),prep=await prepared(t,{shadowEvaluation:true}),result=await screenQuestionOnly(prep,{dependencies});assert.equal(result.liveEligible,false);
  const replay=await rehydratePrepared(JSON.parse(JSON.stringify(prep)),{keyDirectory:path.join(prep.vaultDirectory,'machine-local-test-keys')}),replayed=await screenQuestionOnly(replay,{dependencies});assert.equal(replayed.liveEligible,false);assert.equal(replayed.releasePermit,null);
});

test('decoder errors, scanner failures, invalid JSON and truncated local output fail closed',async t=>{
  for(const change of [
    dependencies=>{dependencies.decode=()=>({failClosed:true,limitsExceeded:true,variants:[]});},
    dependencies=>{dependencies.scan=async()=>({status:'error',failClosed:true,findings:[]});},
    dependencies=>{dependencies.localCall=async()=>({text:'invalid JSON',doneReason:'stop',tokens:{output:1}});},
    dependencies=>{dependencies.localCall=async()=>({text:'{}',doneReason:'length',tokens:{output:192}});},
  ]){const dependencies=privacyDependencies();change(dependencies);const prep=await prepared(t,{dependencies}),result=await screenQuestionOnly(prep,{dependencies});assert.equal(prep.baseBlocked,true);assert.equal(result.liveEligible,false);assert.ok(prep.stages.some(row=>row.status==='ERROR'));}
});

test('the final question rejects digits, local tokens, source references, named entities and multiline data',()=>{
  for(const question of ['How should records for Exampleperson be analyzed?','How should five records numbered 123 be analyzed?','How should [[LOCAL_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa]] be analyzed?','How should a source file be analyzed?','How should records\nbe analyzed?'])assert.equal(validateGeneralQuestion(question).valid,false);
  assert.equal(validateGeneralQuestion(GENERAL_TEST_QUESTION).valid,true);
});

test('encoded incoming answers are inspected in decoded form by injection and harmful-content checks',async()=>{
  const context=makeInboundContext(safeItem),dependencies=privacyDependencies(),seen={};dependencies.decode=()=>({variants:[{text:'A harmless decoded explanation.',encoding:'base64'}],failClosed:false});dependencies.promptGuard=async(texts,{variant})=>{seen.injection=texts;return{status:'PASS',available:true,detected:false,variant,latencyMs:0};};dependencies.harmfulGuard=async(_lens,_question,answer)=>{seen.harmful=answer;return{safe:true,classification:'safe',latencyMs:0};};
  const checked=await finishIncomingAnswer(await prepareIncomingAnswer(context,'A harmless encoded answer.',{dependencies}),{dependencies});assert.equal(checked.operationalPassed,true);assert.ok(seen.injection.includes('A harmless decoded explanation.'));assert.equal(seen.harmful.includes('A harmless decoded explanation.'),true);
});

test('incoming inspections require the exact prior object and authenticated inspection state',async()=>{
  const mutations=[
    checked=>({...checked}),
    checked=>{checked.blocked=!checked.blocked;},
    checked=>{checked.code='CHANGED';},
    checked=>{checked.stages[0].status='BLOCKED';},
    checked=>{checked.text+=' changed';checked.answerHash=sha256(checked.text);},
    checked=>{checked.injectionScanTexts=['A different harmless answer.'];},
    checked=>{checked.prepared.privateValues.push({type:'PRIVATE',value:'a different local value'});},
    checked=>{checked.prepared.sourceText+=' changed';checked.prepared.sourceHash=sha256(checked.prepared.sourceText);},
    checked=>{checked.prepared.question='How should another general task be approached?';checked.prepared.questionHash=sha256(checked.prepared.question);},
    checked=>{checked.prepared.tokenizedLocalSource='changed';},
    checked=>{checked.prepared.vault={restore:text=>text};},
    checked=>{checked.prepared={...checked.prepared};},
  ];
  for(const mutate of mutations){
    const dependencies=privacyDependencies();let laterChecks=0;dependencies.promptGuard=async()=>{laterChecks++;throw Error('Must not run');};dependencies.harmfulGuard=async()=>{laterChecks++;throw Error('Must not run');};const checked=await prepareIncomingAnswer(makeInboundContext(safeItem),'A general explanation.',{dependencies}),changed=mutate(checked)??checked;
    await assert.rejects(finishIncomingAnswer(changed,{dependencies}),{code:'INCOMING_CHECK_PROOF_REQUIRED'});assert.equal(laterChecks,0);
  }
});

test('incoming provenance remains bound across asynchronous inspection steps',async()=>{
  const dependencies=privacyDependencies(),context=makeInboundContext(safeItem),checked=await prepareIncomingAnswer(context,'A general explanation.',{dependencies}),predict=dependencies.promptGuard;dependencies.promptGuard=async(...args)=>{checked.injectionScanTexts.push('Another harmless explanation.');return predict(...args);};await assert.rejects(finishIncomingAnswer(checked,{dependencies}),{code:'INCOMING_CHECK_PROOF_REQUIRED'});
  const other=privacyDependencies(),source=makeInboundContext(safeItem),inspect=other.localCall;other.localCall=async(...args)=>{source.privateValues.push({type:'PRIVATE',value:'a changed local value'});return inspect(...args);};await assert.rejects(prepareIncomingAnswer(source,'A general explanation.',{dependencies:other}),{code:'INCOMING_CONTEXT_CHANGED'});
});

test('cached incoming snapshots can regain shadow provenance but never production authorization',async t=>{
  const dependencies=privacyDependencies(),prep=await prepared(t),original=await prepareIncomingAnswer(prep,'A general explanation.',{dependencies}),snapshot=JSON.parse(JSON.stringify(original));await assert.rejects(finishIncomingAnswer(snapshot,{dependencies}),{code:'INCOMING_CHECK_PROOF_REQUIRED'});
  const replay=await rehydrateIncomingAnswer(snapshot,{prepared:prep}),production=await finishIncomingAnswer(replay,{dependencies});assert.equal(production.operationalPassed,false);assert.equal(production.shadowOnly,true);assert.equal(production.checkPermit,null);
  const shadow=await finishIncomingAnswer(replay,{shadowEvaluation:true,dependencies});assert.equal(shadow.operationalPassed,false);assert.equal(shadow.shadowOnly,true);assert.ok(shadow.checkPermit);await assert.rejects(applyAnswerLocally(prep,shadow,{dependencies}),{code:'CHECKED_LOCAL_APPLICATION_REQUIRED'});
  const next=await finishIncomingAnswer(replay,{shadowEvaluation:true,dependencies});assert.equal((await applyAnswerLocally(prep,next,{shadowEvaluation:true,dependencies})).tokenRoundTripVerified,true);
  const inbound=await prepareIncomingAnswer(makeInboundContext(safeItem),'A general explanation.',{dependencies}),minimal=await rehydrateIncomingAnswer(JSON.parse(JSON.stringify(inbound)));assert.equal((await finishIncomingAnswer(minimal,{dependencies})).operationalPassed,false);
  const corrupt=JSON.parse(JSON.stringify(original));corrupt.answerHash='changed';await assert.rejects(rehydrateIncomingAnswer(corrupt,{prepared:prep}),{code:'PRIVATE_INCOMING_SNAPSHOT_CHANGED'});
  const other={...prep,privateValues:[{type:'PRIVATE',value:'a different local value'}]};await assert.rejects(rehydrateIncomingAnswer(snapshot,{prepared:other}),{code:'PRIVATE_INCOMING_CONTEXT_CHANGED'});
});

test('pending output screening grants only an explicitly local-surrogate apply permit, never a live one',async t=>{
  const prep=await prepared(t),dependencies=privacyDependencies({answer:'A fictional local answer.'});dependencies.promptGuard=async()=>({status:'PENDING',available:false,detected:false,latencyMs:0});
  const checked=await finishIncomingAnswer(await prepareIncomingAnswer(prep,'A general explanation.',{dependencies}),{shadowEvaluation:true,dependencies});assert.equal(checked.operationalPassed,false);assert.equal(checked.availableChecksPassed,true);
  await assert.rejects(applyAnswerLocally(prep,checked,{dependencies}),{code:'CHECKED_LOCAL_APPLICATION_REQUIRED'});
  const repeated=await finishIncomingAnswer(await prepareIncomingAnswer(prep,'A general explanation.',{dependencies}),{shadowEvaluation:true,dependencies});const applied=await applyAnswerLocally(prep,repeated,{shadowEvaluation:true,dependencies});assert.equal(applied.answer,'A fictional local answer.');assert.equal(applied.tokenRoundTripVerified,true);assert.equal(applied.cloudQuality,'DEFERRED_LOCAL_SURROGATE_ONLY');await assert.rejects(applyAnswerLocally(prep,repeated,{shadowEvaluation:true,dependencies}),{code:'CHECKED_LOCAL_APPLICATION_REQUIRED'});
});

test('positive output injection blocks even experimental local application',async t=>{
  const prep=await prepared(t),dependencies=privacyDependencies();dependencies.promptGuard=async()=>({status:'BLOCKED',available:true,detected:true,latencyMs:0});const checked=await finishIncomingAnswer(await prepareIncomingAnswer(prep,'A general explanation.',{dependencies}),{shadowEvaluation:true,dependencies});assert.equal(checked.availableChecksPassed,false);assert.equal(checked.checkPermit,null);await assert.rejects(applyAnswerLocally(prep,checked,{shadowEvaluation:true,dependencies}),{code:'CHECKED_LOCAL_APPLICATION_REQUIRED'});
});

test('application refuses a changed answer or private source after output checking',async t=>{
  const dependencies=privacyDependencies(),prep=await prepared(t),checked=await finishIncomingAnswer(await prepareIncomingAnswer(prep,'A general explanation.',{dependencies}),{dependencies});checked.text+=' modified';await assert.rejects(applyAnswerLocally(prep,checked,{dependencies}),{code:'CHECKED_LOCAL_APPLICATION_REQUIRED'});
  const next=await finishIncomingAnswer(await prepareIncomingAnswer(prep,'A general explanation.',{dependencies}),{dependencies});prep.sourceText+=' changed';await assert.rejects(applyAnswerLocally(prep,next,{dependencies}),{code:'CHECKED_LOCAL_APPLICATION_REQUIRED'});
});

test('local application verifies restored tokenized source before any model can use private data',async t=>{
  let modelCalls=0;const dependencies=privacyDependencies(),original=dependencies.localCall;dependencies.localCall=async(...args)=>{modelCalls++;return original(...args);};
  const prep=await prepared(t),checked=await finishIncomingAnswer(await prepareIncomingAnswer(prep,'A general explanation.',{dependencies}),{dependencies});const before=modelCalls;prep.tokenizedLocalSource+=' modified';await assert.rejects(applyAnswerLocally(prep,checked,{dependencies}),{code:'CHECKED_LOCAL_APPLICATION_REQUIRED'});assert.equal(modelCalls,before);
});

test('application permits bind private mappings and the exact local restoration function',async t=>{
  for(const mutate of [prep=>{prep.privateValues.push({type:'PRIVATE',value:'a changed local value'});},prep=>{prep.vault.restore=text=>text;}]){const dependencies=privacyDependencies(),prep=await prepared(t),checked=await finishIncomingAnswer(await prepareIncomingAnswer(prep,'A general explanation.',{dependencies}),{dependencies});mutate(prep);await assert.rejects(applyAnswerLocally(prep,checked,{dependencies}),{code:'CHECKED_LOCAL_APPLICATION_REQUIRED'});}
});

test('Prompt Guard adapters remain pending without local weights and reject ambiguous/malformed model results',async()=>{
  const missing=await runPromptGuard(['A harmless test.']);assert.equal(missing.status,'PENDING');assert.equal(missing.available,false);assert.equal(missing.detected,false);
  const malformed=await runPromptGuard(['A harmless test.'],{predict:async()=>({status:'READY',localOnly:true,windows:1,maxScore:NaN})});assert.equal(malformed.status,'PENDING');
  const blocked=await runPromptGuard(['A harmless test.'],{variant:'22m',predict:async()=>({status:'READY',localOnly:true,windows:1,maxScore:.5})});assert.equal(blocked.status,'BLOCKED');assert.equal(blocked.detected,true);
});

test('Prompt Guard request IDs ignore late replies after cancellation instead of attaching them to another input',async()=>{
  const mailbox=createPromptGuardMailbox(),first=mailbox.register(),second=mailbox.register();const rejected=assert.rejects(first.promise,/expired/);mailbox.cancel(first.id);await rejected;assert.equal(mailbox.deliver({id:first.id,maxScore:0}),false);assert.equal(mailbox.size,1);assert.equal(mailbox.deliver({id:second.id,maxScore:1}),true);assert.equal((await second.promise).maxScore,1);assert.equal(mailbox.size,0);
});

test('the machine-local keystore is separate from a synchronized data directory',async t=>{
  const folder=await directory(t),previous=process.env.LOCALAPPDATA;process.env.LOCALAPPDATA=path.join(folder,'machine-profile');t.after(()=>{if(previous===undefined)delete process.env.LOCALAPPDATA;else process.env.LOCALAPPDATA=previous;});
  const data=path.join(folder,'synchronized-data'),vault=await createQuestionTokenVault(data);vault.register('synthetic local private detail');await vault.save();assert.equal((await readdir(data)).some(name=>name.endsWith('.key')),false);assert.equal((await readdir(path.join(folder,'machine-profile/Handoff/privacy-keys'))).length,1);assert.equal(vault.stats().machineLocalKeyStore,true);
});

test('Stage 6b dispatch remains disabled even with an otherwise valid complete boundary and mock client',async t=>{
  const previous={};for(const[key,value]of Object.entries({META_ACCESS_STATUS:'live',HANDOFF_META_ACCESS_CONFIRMED:'true',CLOUD_BUDGET_USD:'1',HANDOFF_LIVE_RUN_ID:'blocked-stage'})){previous[key]=process.env[key];process.env[key]=value;}t.after(()=>{for(const[key,value]of Object.entries(previous))if(value===undefined)delete process.env[key];else process.env[key]=value;});
  const dataDir=await directory(t),dependencies=privacyDependencies(),prep=await prepared(t),boundary=await screenQuestionOnly(prep,{dependencies}),input=buildQuestionOnlyPayload(boundary.question),guard=await screenForCloud(input,{guard:dependencies.harmfulGuard});const configFile=path.join(dataDir,'live.json');await writeFile(configFile,JSON.stringify({...await readLiveMuseConfig(),killSwitch:false}));let calls=0;
  await assert.rejects(callMuse(input,{offlineMeta:false,releasePermit:guard.releasePermit,questionReleasePermit:boundary.releasePermit,item:safeItem,registry:createCloudPolicyRegistry([safeItem]),dataDir,dependencies:{configFile,client:{responses:{create:async()=>{calls++;throw Error('No network');}}}}}),{code:'PRIVACY_STAGE_DISPATCH_DISABLED'});assert.equal(calls,0);
});
