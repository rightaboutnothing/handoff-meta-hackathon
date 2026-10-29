import test from 'node:test';
import assert from 'node:assert/strict';
import {literalCoordinates,literalPointerContract,buildLiteralSpanWindows,parseLiteralValues,parseLiteralSpanPointers,inspectLiteralValues} from '../src/privacy/literal-spans.mjs';
import {makeInboundContext,prepareIncomingAnswer} from '../src/privacy/question-boundary.mjs';
import {privacyDependencies} from './helpers/question-boundary.mjs';

const response=(value,extra={})=>({text:JSON.stringify(value),doneReason:'stop',modelId:'authored-local',tokens:{input:20,output:15,total:35},settings:{maxTokens:256,contextTokens:4096},...extra});
const pointer=(contract,value,type='person')=>{const start=contract.coordinates.text.indexOf(value),end=start+value.length;return{start:contract.coordinates.boundaries.indexOf(start),end:contract.coordinates.boundaries.indexOf(end),type};};
const invalidLiteral=response({private_values:[{value:'A fabricated value absent from the candidate',type:'person'}]});

test('normal literal positives return actual candidate capitalization and never trigger repair',async()=>{
  let calls=0;const result=await inspectLiteralValues('Contact Invented Exampleperson.',{call:async()=>{calls++;return response({private_values:[{value:'invented exampleperson',type:'person'}]});}});assert.equal(calls,1);assert.equal(result.value[0].value,'Invented Exampleperson');assert.equal(result.result.attempts.length,1);
});
test('normal no-finding results do not change the first literal schema or call count',async()=>{
  let calls=0;const result=await inspectLiteralValues('How can unit prices be compared?',{call:async(messages,options)=>{calls++;assert.ok(options.schema.properties.private_values);assert.equal(JSON.parse(messages.at(-1).content).proposedQuestion,'How can unit prices be compared?');return response({private_values:[]});}});assert.deepEqual(result.value,[]);assert.equal(calls,1);
});
test('a valid positive sibling is retained and a malformed sibling cannot retry it into empty',async()=>{
  let calls=0;await assert.rejects(inspectLiteralValues('Contact Invented Exampleperson.',{call:async()=>{calls++;return response({private_values:[{value:'Invented Exampleperson',type:'person'},{value:'Absent imaginary name',type:'person'}]});}}),error=>error.code==='PRIVACY_LOCAL_INVALID_SPAN'&&error.positiveFindings[0].value==='Invented Exampleperson'&&error.localProtocol.attempts.length===1);assert.equal(calls,1);
});
test('positive findings remain irrevocable even when the enclosing literal schema is invalid',async()=>{
  let calls=0;await assert.rejects(inspectLiteralValues('Contact Invented Exampleperson.',{call:async()=>{calls++;return response({private_values:[{value:'Invented Exampleperson',type:'person'}],unexpected:true});}}),error=>error.code==='PRIVACY_LOCAL_INVALID_SCHEMA'&&error.positiveFindings.length===1);assert.equal(calls,1);
});
test('the strict full boundary catches the authored email before any NER or pointer repair call',async()=>{
  const text='How can a reply be sent to invented.author@example.invalid?',prepared=makeInboundContext({id:'authored-strict-email-boundary',prompt:'A harmless authored task.'}),dependencies=privacyDependencies();let calls=0;dependencies.localCall=async()=>{calls++;throw Error('No model call may inspect this pattern-positive output');};const checked=await prepareIncomingAnswer(prepared,text,{dependencies});assert.equal(checked.blocked,true);assert.equal(checked.privacyDetected,true);assert.equal(checked.code,'OUTPUT_PRIVATE_PATTERNS');assert.equal(calls,0);
});
test('literal matching handles regex punctuation as literal data',()=>{
  const result=parseLiteralValues(response({private_values:[{value:'fictional+tag@example.invalid',type:'email'}]}),'Contact fictional+tag@example.invalid.');assert.equal(result[0].value,'fictional+tag@example.invalid');
});
test('all original word and punctuation boundaries remain selectable without a six-word limit',()=>{
  const text='Imaginary One Two Three Four Five Six Seven Holdings',coordinates=literalCoordinates(text),contract=literalPointerContract(coordinates),row=pointer(contract,text,'organization');assert.deepEqual(parseLiteralSpanPointers(response({private_spans:[row]}),contract).map(x=>x.value),[text]);assert.equal(contract.schema.properties.private_spans.items.properties.start.type,'integer');
});
test('Unicode boundaries never bisect surrogate pairs and cover Japanese without spaces',()=>{
  const text='仮の組織名🙂について説明してください',coordinates=literalCoordinates(text);assert.equal(coordinates.boundaries.at(-1),text.length);for(const at of coordinates.boundaries)assert.ok(!(at>0&&at<text.length&&/[\uD800-\uDBFF]/.test(text[at-1])&&/[\uDC00-\uDFFF]/.test(text[at])));const contract=literalPointerContract(coordinates);assert.equal(parseLiteralSpanPointers(response({private_spans:[{start:0,end:coordinates.boundaries.length-1,type:'organization'}]}),contract)[0].value,text);
});
test('out-of-range, reversed and non-integer pointer IDs fail closed',()=>{
  const contract=literalPointerContract(literalCoordinates('An imaginary source.'));
  for(const row of [{start:-1,end:1,type:'person'},{start:2,end:1,type:'person'},{start:0,end:999,type:'person'},{start:0.5,end:1,type:'person'}])assert.throws(()=>parseLiteralSpanPointers(response({private_spans:[row]}),contract),{code:'PRIVACY_LOCAL_INVALID_SPAN'});
});
test('source mutation cannot authorize previously enumerated pointers',()=>{
  const contract=literalPointerContract(literalCoordinates('An authored candidate.'));contract.coordinates={...contract.coordinates,text:'A changed candidate.'};assert.throws(()=>parseLiteralSpanPointers(response({private_spans:[]}),contract),{code:'PRIVACY_LOCAL_SPAN_SOURCE_CHANGED'});
});
test('whitespace-only coordinates are invalid instead of an empty no-finding result',()=>{
  const contract=literalPointerContract(literalCoordinates('   '));assert.throws(()=>parseLiteralSpanPointers(response({private_spans:[{start:0,end:1,type:'person'}]}),contract),{code:'PRIVACY_LOCAL_INVALID_SPAN'});
});
test('a proven long source span is segmented for validation and never truncated at 256 characters',()=>{
  const text='Imaginary '+('Longword '.repeat(60)).trim(),contract=literalPointerContract(literalCoordinates(text)),result=parseLiteralSpanPointers(response({private_spans:[{start:0,end:contract.last,type:'organization'}]}),contract);assert.ok(text.length>256);assert.equal(result[0].value,text);assert.equal(result[0].end,text.length);
});
test('invalid literal output activates only a candidate-bound pointer repair',async()=>{
  const text='Contact Invented Exampleperson.',windows=buildLiteralSpanWindows(text);let calls=0;
  const result=await inspectLiteralValues(text,{call:async(messages,options)=>{calls++;if(options.schema.properties.private_values)return invalidLiteral;assert.ok(options.schema.properties.private_spans);assert.deepEqual(JSON.parse(messages.at(-1).content).pieces,JSON.parse(windows[0].messages.at(-1).content).pieces);return response({private_spans:[pointer(windows[0],'Invented Exampleperson')]});}});
  assert.equal(calls,2);assert.equal(result.value[0].value,'Invented Exampleperson');assert.equal(result.result.spanRepair,true);assert.equal(result.result.attempts[0].recovered,true);assert.equal(result.result.tokens.total,70);
});
test('all required windows are covered, budgeted and inspected including the final entity',async()=>{
  const text='General guidance remains local. '.repeat(50)+'Invented Exampleperson',windows=buildLiteralSpanWindows(text);assert.ok(windows.length>1);assert.equal(windows[0].first,0);assert.equal(windows.at(-1).last,windows[0].coordinates.boundaries.length-1);assert.ok(windows.every((w,i)=>w.requestBytes<=w.maximumBytes&&(!i||w.first<=windows[i-1].last)));
  let index=0;const result=await inspectLiteralValues(text,{call:async(_messages,options)=>{if(options.schema.properties.private_values)return invalidLiteral;const window=windows[index++],from=window.coordinates.boundaries[window.first],to=window.coordinates.boundaries[window.last],start=text.indexOf('Invented Exampleperson');return response({private_spans:start>=from&&text.length<=to?[pointer(window,'Invented Exampleperson')]:[]});}});assert.equal(index,windows.length);assert.equal(result.value[0].value,'Invented Exampleperson');
});
test('a reversed pointer receives only a bounded protocol repair before a valid exact mapping',async()=>{
  const text='Contact Invented Exampleperson.',window=buildLiteralSpanWindows(text)[0];let calls=0;const result=await inspectLiteralValues(text,{call:async(_messages,options)=>{calls++;if(options.schema.properties.private_values)return invalidLiteral;if(calls===2)return response({private_spans:[{start:window.last,end:0,type:'person'}]});return response({private_spans:[pointer(window,'Invented Exampleperson')]});}});assert.equal(calls,3);assert.equal(result.value[0].value,'Invented Exampleperson');assert.equal(result.result.attempts[1].code,'PRIVACY_LOCAL_INVALID_SPAN');assert.equal(result.result.attempts[1].recovered,true);
});
test('any unavailable window fails closed and keeps every positive already found',async()=>{
  const text='Invented Exampleperson '+('General local guidance. '.repeat(50)),windows=buildLiteralSpanWindows(text);let calls=0;await assert.rejects(inspectLiteralValues(text,{call:async(_messages,options)=>{calls++;if(options.schema.properties.private_values)return invalidLiteral;if(calls===2)return response({private_spans:[pointer(windows[0],'Invented Exampleperson')]});throw Object.assign(Error('A private backend detail'),{code:'LOCAL_HTTP_ERROR',status:503,modelId:'authored-local',requestHash:'a'.repeat(64)});}}),error=>error.code==='LOCAL_HTTP_ERROR'&&error.positiveFindings[0].value==='Invented Exampleperson'&&error.localProtocol.attempts.at(-1).httpStatus===503&&error.localProtocol.attempts.at(-1).requestHash==='a'.repeat(64));assert.equal(calls,3);
});
test('window and context limits block rather than silently truncate the candidate',()=>{
  assert.throws(()=>buildLiteralSpanWindows('An authored question.',{contextTokens:900,maxTokens:256}),{code:'PRIVACY_LOCAL_SPAN_BUDGET'});assert.throws(()=>buildLiteralSpanWindows('Local prose. '.repeat(1000),{maxWindows:1}),{code:'PRIVACY_LOCAL_SPAN_WINDOW_LIMIT'});
});
test('bounded malformed JSON repairs retain failure provenance and do not change to pointers',async()=>{
  let calls=0;const result=await inspectLiteralValues('How can a method be described?',{call:async(_messages,options)=>{calls++;assert.ok(options.schema.properties.private_values);return calls===1?response(null,{text:'{'}):response({private_values:[]});}});assert.equal(calls,2);assert.equal(result.result.attempts[0].code,'PRIVACY_LOCAL_INVALID_JSON');assert.equal(result.result.attempts[0].recovered,true);
});
test('unresolved protocol failures are bounded to four requests and retain all attempts',async()=>{
  let calls=0;await assert.rejects(inspectLiteralValues('How can a method be described?',{call:async()=>{calls++;return response(null,{text:'{'});}}),error=>error.code==='PRIVACY_LOCAL_INVALID_JSON'&&error.localProtocol.attempts.length===4&&error.localProtocol.attempts.every(row=>!row.recovered));assert.equal(calls,4);
});
test('truncation and context overflow cannot silently produce a no-finding pass',async()=>{
  for(const extra of [{doneReason:'length'},{tokens:{input:4090,output:10,total:4100}}])await assert.rejects(inspectLiteralValues('How can a method be described?',{call:async()=>response({private_values:[]},extra)}),error=>['PRIVACY_LOCAL_TRUNCATED','PRIVACY_LOCAL_CONTEXT_LIMIT'].includes(error.code)&&error.localProtocol.attempts.length===4);
});
test('attempts retain only validated hashes/reuse metadata for honest cached-call accounting',async()=>{
  const result=await inspectLiteralValues('How can a method be described?',{call:async()=>response({private_values:[]},{evaluationCallHash:'b'.repeat(64),evaluationReused:true})});assert.equal(result.result.attempts[0].callHash,'b'.repeat(64));assert.equal(result.result.evaluationReused,true);const noHash=await inspectLiteralValues('How can a method be described?',{call:async()=>response({private_values:[]},{evaluationCallHash:'not-a-hash',evaluationReused:false})});assert.ok(!('callHash'in noHash.result.attempts[0]));assert.equal(noHash.result.evaluationReused,false);
});
