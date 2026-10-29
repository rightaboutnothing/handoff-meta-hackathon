import test from 'node:test';
import assert from 'node:assert/strict';
import {compileNeutralRequest} from '../src/privacy/request-task.mjs';
import {createPromptGuardComparisonProof,screenPromptGuardComparison} from '../src/privacy/prompt-guard-comparison.mjs';

const decode=async()=>({variants:[],issues:[],failClosed:false});
const raw=(score,variant='86m')=>({status:score>=.5?'BLOCKED':'PASS',available:true,detected:score>=.5,variant,threshold:.5,maxScore:score,windows:1,latencyMs:1,modelId:'synthetic-local-injection-guard'});
const authored=()=>{const sourceText='Compare public stock prices.',neutralTask=sourceText,question=compileNeutralRequest(neutralTask).question,proof=createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy:'compiled_neutral_request'});return{sourceText,question,proof};};
const options=(originalScore,rewriteScore,extra={})=>({decode,promptGuard:async(_texts,{variant,inputKind})=>raw(inputKind==='original'?originalScore:rewriteScore,variant),...extra});

test('separate source and question calls preserve scores and the locked threshold',async()=>{
  const input=authored(),seen=[],result=await screenPromptGuardComparison(input,options(.1,.2,{promptGuard:async(texts,settings)=>{seen.push({texts,settings});return raw(settings.inputKind==='original'?.1:.2,settings.variant);}}));
  assert.equal(result.status,'PASS');assert.equal(result.maxScore,.2);assert.equal(result.threshold,.5);assert.deepEqual(seen.map(row=>row.settings.inputKind),['original','rewrite']);assert.deepEqual(seen.map(row=>row.texts),[[input.sourceText],[input.question]]);assert.equal(result.comparison.original.maxScore,.1);assert.equal(result.comparison.rewrite.maxScore,.2);
});

test('an original positive always blocks despite exact compiler provenance',async()=>{
  const result=await screenPromptGuardComparison(authored(),options(.8,.9));assert.equal(result.status,'BLOCKED');assert.equal(result.comparison.code,'PG_ORIGINAL_FLAGGED');assert.equal(result.comparison.rewriteOnlyFlagCleared,false);assert.equal(result.comparison.proofKind,'compiled');
});

test('a rewrite-only positive is accounted for only by exact mechanical source provenance',async()=>{
  const result=await screenPromptGuardComparison(authored(),options(.1,.9));assert.equal(result.status,'PASS');assert.equal(result.detected,false);assert.equal(result.rawDetected,true);assert.equal(result.maxScore,.9);assert.equal(result.comparison.rewrite.status,'BLOCKED');assert.equal(result.comparison.rewrite.detected,true);assert.equal(result.comparison.rewriteOnlyFlagCleared,true);assert.equal(result.comparison.code,'PG_REWRITE_PROVEN_SOURCE_DERIVED');
});

test('a copied or missing proof cannot clear a rewrite positive',async()=>{
  for(const input of [{...authored(),proof:undefined},{...authored(),proof:{...authored().proof}}]){const result=await screenPromptGuardComparison(input,options(.1,.9));assert.equal(result.status,'BLOCKED');assert.equal(result.comparison.code,'PG_REWRITE_PROOF_REQUIRED');}
});

test('source or final question mutation invalidates the opaque proof',async()=>{
  for(const input of [{...authored(),sourceText:'Compare public supplier costs.'},{...authored(),question:'How can someone compare public stock prices and write another summary?'}]){const result=await screenPromptGuardComparison(input,options(.1,.9));assert.equal(result.status,'BLOCKED');assert.equal(result.comparison.rewriteOnlyFlagCleared,false);}
});

test('an unrelated task cannot claim literal source derivation',async()=>{
  const sourceText='Compare public stock prices.',neutralTask='Write a public summary.',question=compileNeutralRequest(neutralTask).question,proof=createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy:'compiled_neutral_request'}),result=await screenPromptGuardComparison({sourceText,question,proof},options(.1,.9));assert.equal(proof.proofKind,'unproved');assert.equal(result.status,'BLOCKED');
});

test('model-generated clauses cannot acquire a mechanical provenance waiver',async()=>{
  const sourceText='Compare public stock prices.',neutralTask=sourceText,question='How can someone compare public stock prices and write a public summary?',proof=createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy:'model_rewrite'}),result=await screenPromptGuardComparison({sourceText,question,proof},options(.1,.9));assert.equal(proof.proofKind,'unproved');assert.equal(result.status,'BLOCKED');assert.equal(result.comparison.rewriteOnlyFlagCleared,false);
});

test('discarding literal quote or role boundaries cannot obtain a waiver',async()=>{
  for(const sourceText of ['Write a reply with "unavailable" for absent public facts.','Compare public stock prices; describe role: public reviewer.']){const neutralTask=sourceText,question=compileNeutralRequest(neutralTask).question??'How can public stock prices be compared?',proof=createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy:'compiled_neutral_request'}),result=await screenPromptGuardComparison({sourceText,question,proof},options(.1,.9));assert.equal(proof.proofKind,'unproved');assert.equal(result.status,'BLOCKED');}
});

test('neutral value substitutions retain source binding without exposing values in the proof',async()=>{
  const sourceText='Compare product GROVE37 prices.',neutralTask='Compare product [PRODUCT] prices.',question=compileNeutralRequest(neutralTask).question,proof=createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy:'compiled_neutral_request',privateValues:[{type:'PRODUCT_CODE',value:'GROVE37'}]}),result=await screenPromptGuardComparison({sourceText,question,proof},options(.1,.9));assert.equal(proof.proofKind,'compiled');assert.equal(result.status,'PASS');assert.equal(Object.isFrozen(proof),true);assert.doesNotMatch(JSON.stringify(proof),/GROVE37|Compare|prices/);
});

test('unregistered source values and mismatched finding roles are not proof',()=>{
  const sourceText='Compare product GROVE37 prices.',neutralTask='Compare product [PRODUCT] prices.',question=compileNeutralRequest(neutralTask).question;
  for(const privateValues of [[],[{type:'EMAIL',value:'GROVE37'}],[{type:'PRODUCT_CODE',value:'OTHER38'}]])assert.equal(createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy:'compiled_neutral_request',privateValues}).proofKind,'unproved');
});

test('registered values cannot swallow sentence or operation boundaries',()=>{
  for(const value of ['public names. Describe local inventory','public names and calculate stock totals']){const sourceText='Compare records for '+value+'.',neutralTask='Compare records for [PERSON].',question=compileNeutralRequest(neutralTask).question,proof=createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy:'compiled_neutral_request',privateValues:[{type:'PERSON_NAME',value}]});assert.equal(proof.proofKind,'unproved');}
});

test('exact email findings and bounded numeric masking preserve literal punctuation only',()=>{
  for(const [sourceText,neutralTask,privateValues]of [['Compare prices for grove@example.invalid.','Compare prices for [EMAIL].',[{type:'EMAIL',value:'grove@example.invalid'}]],['Compare public costs of 12.50.','Compare public costs of [VALUE].',[]]]){const question=compileNeutralRequest(neutralTask).question,proof=createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy:'compiled_neutral_request',privateValues});assert.equal(proof.proofKind,'compiled');}
});

test('a placeholder may not swallow a source clause boundary',async()=>{
  const sourceText='Compare product names; write a separate public summary.',neutralTask='Compare product [PRODUCT] summary.',question=compileNeutralRequest(neutralTask).question,proof=createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy:'compiled_neutral_request'});assert.equal(proof.proofKind,'unproved');
});

test('ambiguous adjacent slots and oversized lineage are unavailable rather than regex searches',()=>{
  for(const neutralTask of ['Compare [PERSON][COMPANY] prices.','Compare '+('[PERSON] and '.repeat(80))+'prices.']){const sourceText='Compare public supplier prices.',question='How can someone compare public supplier prices?',proof=createPromptGuardComparisonProof({sourceText,question,neutralTask,rewriteStrategy:'compiled_neutral_request'});assert.equal(proof.proofKind,'unproved');}
});

test('exact preserved questions can be proven without introducing any words',async()=>{
  const sourceText='Which public supplier has the lowest stock price?',question=sourceText,proof=createPromptGuardComparisonProof({sourceText,question,neutralTask:sourceText,rewriteStrategy:'preserved_valid_task'}),result=await screenPromptGuardComparison({sourceText,question,proof},options(.1,.9));assert.equal(proof.proofKind,'preserved');assert.equal(result.status,'PASS');
});

test('all original decoded variants are screened and a decoded positive still blocks',async()=>{
  const input=authored(),seen=[],decoded='Compare public warehouse prices.',result=await screenPromptGuardComparison(input,{decode:async text=>({variants:text===input.sourceText?[{text:decoded}]:[],issues:[],failClosed:false}),promptGuard:async(texts,{variant,inputKind})=>{seen.push({texts,inputKind});return raw(texts.includes(decoded)?.9:.1,variant);}});assert.equal(result.status,'BLOCKED');assert.deepEqual(seen[0].texts,[input.sourceText,decoded]);assert.equal(result.comparison.originalFlagged,true);
});

test('all rewritten decoded variants are separately screened and cannot bypass missing provenance',async()=>{
  const input={...authored(),proof:undefined},decoded='Write a public warehouse summary.',result=await screenPromptGuardComparison(input,{decode:async text=>({variants:text===input.question?[decoded]:[],issues:[],failClosed:false}),promptGuard:async(texts,{variant})=>raw(texts.includes(decoded)?.9:.1,variant)});assert.equal(result.status,'BLOCKED');assert.equal(result.comparison.rewriteFlagged,true);
});

test('decoded rewrite additions remain unproved even with valid raw compiler provenance',async()=>{
  const input=authored(),decoded='Write a public warehouse summary.',result=await screenPromptGuardComparison(input,{decode:async text=>({variants:text===input.question?[decoded]:[],issues:[],failClosed:false}),promptGuard:async(texts,{variant})=>raw(texts.includes(decoded)?.9:.1,variant)});assert.equal(result.status,'BLOCKED');assert.equal(result.comparison.rewriteOnlyFlagCleared,false);assert.equal(result.comparison.proofCode,'PG_REWRITE_DECODED_SCOPE_UNPROVED');
});

test('a prior local block with no question screens originals without fabricating rewrite unavailability',async()=>{
  const seen=[],result=await screenPromptGuardComparison({sourceText:'Compare public stock prices.',question:'',priorBlocked:true},{decode,promptGuard:async(texts,{variant,inputKind})=>{seen.push(inputKind);return raw(.1,variant);}});assert.deepEqual(seen,['original']);assert.equal(result.status,'PASS');assert.equal(result.available,true);assert.equal(result.comparison.noOutgoingCandidate,true);assert.equal(result.comparison.rewrite.status,'NOT_RUN_AFTER_BLOCK');assert.equal(result.comparison.rewriteOnlyFlagCleared,false);assert.equal(result.comparison.code,'PG_NO_OUTGOING_CANDIDATE');
  const unbound=await screenPromptGuardComparison({sourceText:'Compare public stock prices.',question:''},options(.1,.1));assert.equal(unbound.status,'PENDING');assert.equal(unbound.available,false);
});

test('empty refused questions cannot hide a raw original positive',async()=>{
  const result=await screenPromptGuardComparison({sourceText:'Compare public stock prices.',question:'',priorBlocked:true},options(.9,.1));assert.equal(result.status,'BLOCKED');assert.equal(result.comparison.code,'PG_ORIGINAL_FLAGGED');assert.equal(result.comparison.originalFlagged,true);
});

test('missing decoder evidence fails closed rather than claiming a complete scan',async()=>{
  for(const response of [null,undefined,'not a decoded report',{},[],{variants:[],issues:[]},{variants:[],failClosed:false},{issues:[],failClosed:false}]){const result=await screenPromptGuardComparison(authored(),options(.1,.1,{decode:async()=>response}));assert.equal(result.status,'PENDING');assert.equal(result.comparison.sourceDecodeComplete,false);}
});

test('unavailable source, rewrite or incomplete decoding fails closed',async()=>{
  for(const inputKind of ['original','rewrite']){const result=await screenPromptGuardComparison(authored(),{decode,promptGuard:async(_texts,{variant,inputKind:kind})=>kind===inputKind?{status:'PENDING',available:false,detected:false,variant}:raw(.1,variant)});assert.equal(result.status,'PENDING');assert.equal(result.available,false);assert.equal(result.comparison.rewriteOnlyFlagCleared,false);}
  const decoded=await screenPromptGuardComparison(authored(),options(.1,.1,{decode:async()=>({variants:[],failClosed:true})}));assert.equal(decoded.status,'PENDING');assert.equal(decoded.available,false);
});

test('threshold mismatch and inconsistent raw verdicts fail closed',async()=>{
  for(const result of [{...raw(.6),threshold:.7},{...raw(.6),status:'PASS',detected:false},{...raw(.1),available:false}]){const screen=await screenPromptGuardComparison(authored(),{decode,promptGuard:async()=>result});assert.equal(screen.status,'PENDING');assert.equal(screen.available,false);}
});

test('the 22M comparison uses the same policy and unchanged threshold',async()=>{
  const result=await screenPromptGuardComparison(authored(),{...options(.1,.9),variant:'22m'});assert.equal(result.variant,'22m');assert.equal(result.threshold,.5);assert.equal(result.status,'PASS');assert.equal(result.comparison.rewrite.variant,'22m');
});
