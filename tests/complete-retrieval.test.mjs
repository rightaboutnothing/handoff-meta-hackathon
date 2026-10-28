import test from 'node:test';
import assert from 'node:assert/strict';
import {planEvidenceQueries,selectCompleteEvidence,retrieveComplete}from'../src/rag/complete-retrieval.mjs';

const chunk=(chunkId,file,text,score=.5)=>({chunkId,file,text,score,hash:`hash-${chunkId}`,location:'document'});
const catalogue=[
  chunk('p100','products/af100.md','# AF100 product specification\nList price: AUD 1290 excluding GST. Maximum flow: 12 litres per minute. Replacement cartridge code: C100.',.4),
  chunk('p200','products/af200.md','# AF200 product specification\nList price: AUD 2490 excluding GST. Maximum flow: 24 litres per minute. Replacement cartridge code: C200.',.99),
  chunk('discount','policies/discounts.md','# Volume discounts\nQuantities of 10 to 24 receive a 5 percent discount. Quotes remain valid for 30 days.',.3),
  chunk('shipping','policies/shipping.md','# Shipping policy\nFree standard freight applies to orders of at least AUD 1500 excluding GST. Below that threshold, standard freight is AUD 35.',.2),
  chunk('returns','policies/returns.md','# Returns and warranty policy\nWarranty claims require the serial number and proof of purchase. There is no restocking fee.',.3),
  chunk('service','policies/service.md','# Support service policy\nSupport hours are Monday to Friday. In-stock parts dispatch within 1 business day.',.3),
  chunk('stock','operations/stock.md','# Spare-part inventory policy\nReorder points: C100 20 units; C200 16 units. Safety stock: C100 10 units; C200 8 units.',.2),
  chunk('unrelated','policies/security.md','# Data handling policy\nReview access permissions every 90 days.',.98),
];
const countTokens=text=>(text.match(/\S+/g)??[]).length;

test('query decomposition derives product, discount and shipping requirements without references',()=>{
  const plan=planEvidenceQueries('Quote 12 AF-100 units after the standard volume discount. Include freight.',catalogue);
  assert.deepEqual(plan.entities,['AF100']);assert.deepEqual(plan.requiredFacets.map(facet=>facet.id),['product:AF100','discount-policy','shipping-policy']);assert.equal(plan.referenceInputsUsed,false);assert.equal(plan.queries.length,4);
  const poisoned=catalogue.map(source=>({...source,reference:{expectedSourceFiles:['secret-gold.md']}}));
  assert.deepEqual(planEvidenceQueries(plan.question,poisoned),plan);assert.doesNotMatch(JSON.stringify(plan),/secret-gold/);
});
test('explicitly excluded discounts do not add an unnecessary discount source',()=>{
  const plan=planEvidenceQueries('Give the subtotal and standard freight for 3 AF100 units, with discounts explicitly excluded.',catalogue);
  assert.deepEqual(plan.requiredFacets.map(facet=>facet.id),['product:AF100','shipping-policy']);
});
test('source-diverse hybrid selection recovers low-cosine necessary sources and filters wrong products',()=>{
  const selected=selectCompleteEvidence('Quote 12 AF100 units after the volume discount and include freight.',catalogue,{countTokens});
  assert.equal(selected.completeness.score,1);assert.deepEqual(new Set(selected.chunks.map(chunk=>chunk.chunkId)),new Set(['p100','discount','shipping']));
  assert.ok(!selected.chunks.some(chunk=>chunk.chunkId==='p200'||chunk.chunkId==='unrelated'));assert.ok(selected.tokenCount<=1800);
});
test('mixed-product questions retain both named products and three/four-source needs',()=>{
  const selected=selectCompleteEvidence('Quote AF100 and AF200 after identical-product discounts, including freight.',catalogue,{countTokens});
  assert.equal(selected.completeness.score,1);assert.deepEqual(new Set(selected.chunks.map(chunk=>chunk.file)),new Set(['products/af100.md','products/af200.md','policies/discounts.md','policies/shipping.md']));
});
test('completeness does not mistake a high cosine score for missing evidence',()=>{
  const sources=catalogue.filter(chunk=>chunk.chunkId!=='shipping');
  const plan=planEvidenceQueries('What is the price and freight for AF100?',catalogue);
  const selected=selectCompleteEvidence(plan.question,sources,{catalogue,plan,countTokens});
  assert.equal(selected.completeness.score,.5);assert.deepEqual(selected.completeness.missingFacets,['shipping-policy']);
});
test('unknown product keeps an unsatisfied source requirement instead of using a different product',()=>{
  const result=selectCompleteEvidence('What is the price for AF900?',catalogue,{countTokens});
  assert.deepEqual(result.queryPlan.entities,['AF900']);assert.equal(result.completeness.score,0);assert.ok(!result.chunks.some(product=>product.file.startsWith('products/')));
});
test('replacement-part entities are resolved only from a local indexed product association',()=>{
  const plan=planEvidenceQueries('Which product uses C100 and what safety stock applies?',catalogue);
  assert.deepEqual(plan.entities,['AF100']);assert.deepEqual(plan.requiredFacets.map(facet=>facet.id),['product:AF100','inventory-policy']);
});
test('token budgeting preserves whole factual spans, PII placeholders and source provenance',()=>{
  const sources=[chunk('private','products/af100.md','# AF100 product specification\nContact: [[PII_EMAIL_abcdef123456]].\nMaximum flow: 12 litres per minute.\nAn irrelevant sentence has many extra words that do not answer the requested flow question.')];
  const result=selectCompleteEvidence('Give AF100 maximum flow.',sources,{countTokens,tokenBudget:18});
  assert.ok(result.tokenCount<=18);assert.equal(result.chunks.length,1);assert.equal(result.chunks[0].sourceHash,'hash-private');assert.ok(result.chunks[0].selectedSpans.length);assert.match(result.chunks[0].text,/12 litres per minute/);
  assert.ok(!/\[\[PII_[^\]]*$/.test(result.chunks[0].text));
  const tiny=selectCompleteEvidence('AF100 flow',sources,{countTokens,tokenBudget:1});assert.equal(tiny.chunks.length,0);assert.equal(tiny.completeness.score,0);
});
test('retrieveComplete batches local queries and preserves original best-match score alongside completeness',async()=>{
  const requests=[],vault={redact:text=>({text:text.replace('fake@example.test','[[PII_EMAIL_token]]'),count:1}),save:async()=>{}},store={listChunks:()=>catalogue,search:(vector,embedding,topK)=>{assert.equal(topK,12);return vector[0]===0?[catalogue[7]]:[catalogue[1]];}};
  const result=await retrieveComplete('Quote AF100 with discount and freight; fake@example.test',{vault,countTokens,dependencies:{store,getIndexStatus:()=>({ready:true,embeddingModel:{provider:'ollama',model:'nomic-embed-text:v1.5',dimensions:1}}),embedTexts:async(texts,options)=>{requests.push({texts,options});return{vectors:texts.map((_,index)=>[index]),provider:'ollama',model:options.model,dimensions:1};}}});
  assert.equal(requests.length,1);assert.equal(requests[0].options.provider,'ollama');assert.equal(result.bestMatchScore,.98);assert.equal(result.quality,.98);assert.equal(result.completeness.score,1);assert.equal(result.localOnly,true);assert.doesNotMatch(JSON.stringify(requests),/fake@example/);assert.match(JSON.stringify(requests),/PII_EMAIL_token/);
});
test('missing index fails before embedding, and invalid budgets are rejected',async()=>{
  let called=false;await assert.rejects(retrieveComplete('Question',{dependencies:{getIndexStatus:()=>({ready:false}),embedTexts:()=>{called=true;}}}),/indexed/);assert.equal(called,false);
  assert.throws(()=>selectCompleteEvidence('Question',catalogue,{tokenBudget:0}),/budget/);assert.throws(()=>selectCompleteEvidence('Question',catalogue,{topK:30}),/budget/);
});
