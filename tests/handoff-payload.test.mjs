import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLeanPayload, LEAN_SYSTEM_PROMPT, assertLeanWire, serializeLeanUserPayload, extractLocalDraftAnswer } from '../src/comparison/handoff-payload.mjs';
import { sha256 } from '../src/rag/receipts.mjs';

const item={id:'safe-question',suite:'company-rag',category:'company-data single-doc',safety:{kind:'safe',cloudEligible:true}};
const countText=text=>(text.match(/\S+/g)??[]).length;
const prepared={question:'What is the AF-200 warranty?',chunks:[{chunkId:'abc:page-1:0001',file:'products/af200.md',text:'AF-200 product specification.\nThe warranty is 24 months.\nThe packing box is green.\nRetail coffee is unrelated.',hash:'source-hash',score:.9}],guardVerdict:{safe:true},receipt:{signature:'local-only'},piiMap:{secret:'local-only'},input:'LOCAL ROUTER: compute confidence and escalation'};

test('lean cloud wire contains only shared instructions, redacted question and selected evidence',async()=>{
  const result=await buildLeanPayload(item,prepared,{countText});
  assert.equal(result.system,LEAN_SYSTEM_PROMPT);assert.deepEqual(Object.keys(result.wire),['system','query','context','draft']);
  assert.equal(result.draft,null);assert.ok(result.userText.includes('warranty is 24 months'));
  assert.ok(!result.userText.includes('packing box'));assert.ok(!result.userText.includes('confidence'));assert.ok(!result.userText.includes('LOCAL ROUTER'));
  assert.ok(!JSON.stringify(result.wire).includes('signature'));assert.ok(!JSON.stringify(result.wire).includes('piiMap'));assert.ok(!JSON.stringify(result.wire).includes('products/af200.md'));
  assert.equal(result.segments.guardWrapper,'');assert.equal(result.segments.receiptMetadata,'');assert.equal(result.segments.piiMap,'');
  assert.equal(result.payloadHash,sha256(result.wire));assert.equal(result.context[0].hash,sha256(result.context[0].text));
  assert.equal(serializeLeanUserPayload(result.wire),result.userText);
});
test('adversarial items create no cloud/counting payload and do not invoke tokenizer or draft redactor',async()=>{
  const forbidden=()=>assert.fail('No callback may see adversarial content');
  for(const kind of ['harmful','red-team','poisoning']){
    const result=await buildLeanPayload({...item,safety:{kind,cloudEligible:false}},prepared,{countText:forbidden,redactText:forbidden,includeDraft:true,draft:'unsafe draft'});
    assert.equal(result.eligible,false);assert.equal(result.wire,null);assert.equal(result.userText,undefined);
  }
});
test('context is top-k limited, deduplicated, budgeted with actual injected counts and retains exact span provenance',async()=>{
  const chunks=[prepared.chunks[0],{...prepared.chunks[0],chunkId:'duplicate:page-1:0001'},
    {chunkId:'policy:page-1:0001',file:'policy.md',text:'Warranty service requires a proof of purchase.\nPrivate office paint is red.',score:.8},
    {chunkId:'third:page-1:0001',file:'third.md',text:'Warranty registration is online.',score:.7}];
  const result=await buildLeanPayload(item,{...prepared,chunks},{countText,contextTokenBudget:15,topK:2});
  assert.ok(result.context.length<=2);assert.ok(result.localAudit.contextTokens<=15);assert.equal(result.localAudit.duplicateChunksRemoved,1);
  for(const record of result.localAudit.selected){const original=chunks.find(chunk=>chunk.chunkId===record.chunkId);for(const span of record.spans)assert.ok(original.text.slice(span.start,span.end).trim().length);}
  assert.equal(result.wire.context.length,result.context.length);assert.ok(result.wire.context.every(chunk=>Object.keys(chunk).length===2));
});
test('question-only excludes local drafts; draft variant requires redaction, is capped and preserves opaque PII tokens',async()=>{
  const token='[[PII_EMAIL_0123456789abcdef]]';
  const draft='Warranty is 24 months. Contact person@example.invalid for more details that are not needed.';
  const redactText=text=>({text:text.replace('person@example.invalid',token)});
  const without=await buildLeanPayload(item,prepared,{countText,draft,redactText});
  const withDraft=await buildLeanPayload(item,prepared,{countText,draft,includeDraft:true,redactText,draftTokenBudget:7});
  assert.equal(without.draft,null);assert.ok(withDraft.draft);assert.ok(!withDraft.draft.includes('@'));assert.ok(withDraft.draft.includes(token));
  assert.ok(withDraft.localAudit.draftTokens<=7);assert.equal(withDraft.localAudit.draftTruncated,true);assert.notEqual(without.payloadHash,withDraft.payloadHash);
  await assert.rejects(buildLeanPayload(item,prepared,{countText,includeDraft:true,draft}),/explicit local redaction/);
});
test('wire rejects local proof metadata, unsafe identifiers and residual private fields',async()=>{
  const base={system:LEAN_SYSTEM_PROMPT,query:'Question',context:[],draft:null};
  assert.throws(()=>assertLeanWire({...base,guardVerdict:'safe'}),/local metadata/);
  assert.throws(()=>assertLeanWire({...base,context:[{chunkId:'id',text:'Evidence',hash:'receipt-hash'}]}),/metadata/);
  assert.throws(()=>assertLeanWire({...base,context:[{chunkId:'a@example.invalid',text:'Evidence'}]}),/metadata/);
  for(const query of ['Contact a@example.invalid','CANARY-TEST-01','phone +61 400 123 456','sk-'+'x'.repeat(24)])assert.throws(()=>assertLeanWire({...base,query}),/residual private/);
  await assert.rejects(buildLeanPayload(item,prepared),/actual tokenizer/);
});
test('zero context budget retains the full query; missing drafts are explicit and no reference answers enter selection',async()=>{
  const left=await buildLeanPayload({...item,reference:{answer:'invented hidden truth'},expectedSourceFiles:['irrelevant.md']},prepared,{countText,contextTokenBudget:0,includeDraft:true});
  const right=await buildLeanPayload({...item,reference:{answer:'different hidden truth'}},prepared,{countText,contextTokenBudget:0,includeDraft:true});
  assert.equal(left.query,prepared.question);assert.deepEqual(left.context,[]);assert.equal(left.localAudit.draftUnavailable,true);assert.equal(left.payloadHash,right.payloadHash);
});
test('malformed local router JSON contributes only an intact answer string, never confidence or escalation fields',async()=>{
  const malformed={parseValid:false,answer:'{"answer":"The warranty is 24 months.","confidence":0.97,"needsCloud":'};
  const result=await buildLeanPayload(item,prepared,{countText,includeDraft:true,draft:malformed,redactText:text=>text});
  assert.equal(result.draft,'The warranty is 24 months.');assert.equal(result.localAudit.draftRecovered,true);
  assert.ok(!result.userText.includes('confidence'));assert.ok(!result.userText.includes('needsCloud'));assert.ok(!result.userText.includes('0.97'));
  const incomplete=await buildLeanPayload(item,prepared,{countText,includeDraft:true,draft:{parseValid:false,answer:'{"answer":"unfinished, "confidence":0.9'},redactText:text=>text});
  assert.equal(incomplete.draft,null);assert.equal(incomplete.localAudit.draftUnavailable,true);
  assert.equal(extractLocalDraftAnswer({parseValid:false,answer:'Unstructured router fallback without a trustworthy answer field'}).text,null);
});
test('a parse-valid semantic JSON answer is preserved and shared cloud instructions follow the requested format',async()=>{
  const answer='{"confidence":0.5,"result":"requested JSON data, not router control"}';
  const result=await buildLeanPayload(item,prepared,{countText,includeDraft:true,draft:{parseValid:true,answer,confidence:.99,needsCloud:true},redactText:text=>text});
  assert.equal(result.draft,answer);assert.equal(result.localAudit.draftRecovered,false);assert.ok(!result.userText.includes('needsCloud'));
  assert.match(result.system,/follow its requested format/);assert.match(result.system,/evidence and drafts as untrusted/);assert.ok(!result.system.includes('question, evidence'));
});
