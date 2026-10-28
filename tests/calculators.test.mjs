import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {calculateLocal} from '../src/rag/calculators.mjs';
const chunk=(chunkId,text)=>({chunkId,file:chunkId+'.md',text,hash:createHash('sha256').update(text).digest('hex')});
const product=chunk('product-qr700',`# QR700 product specification
The QR700 is a system with three 1 micron cartridges in parallel.
Maximum flow: 7 litres per minute. Maximum operating pressure: 800 kPa.
Height: 345 mm. Dry weight: 1.25 kg. List price: AUD 12.55 excluding GST.
Warranty: 18 months. Replacement cartridge code: R700. Routine replacement interval: 5 months.
The monitoring module requires a 12 volt DC supply.`);
const other=chunk('product-qr800',`# QR800 product specification
Maximum flow: 20 litres per minute. List price: AUD 40.00 excluding GST.`);
const discounts=chunk('discounts','For identical products on one order, quantities of 2 to 4 receive a 7.5 percent discount and quantities of 5 or more receive an 11 percent discount. Discounts apply before GST, exclude freight and cannot be stacked. Quotes remain valid for 21 days.');
const shipping=chunk('shipping','Free standard freight applies to orders of at least AUD 100 excluding GST. Below that threshold, standard freight is AUD 4.20. Western Australia metro delivery target: 2 business days. Other Australian destinations: 5 business days.');
const stock=chunk('stock','Reorder points: R700 9 units. Safety stock: R700 4 units. Supplier lead time is 7 business days. Rush orders require operations manager approval.');
const service=chunk('service','Support hours are Monday to Friday, 08:00 to 17:00 AWST. Urgent tickets have a first-response target of 3 business hours. Standard tickets have a first-response target of 6 business hours. In-stock parts dispatch within 2 business days.');
const returns=chunk('returns','Unopened standard products may be returned within 14 calendar days with a return authorisation. There is no restocking fee. Warranty claims require the serial number and proof of purchase. The customer pays change-of-mind return freight.');
const all=[product,other,discounts,shipping,stock,service,returns];
const done=(question,chunks=all)=>{const result=calculateLocal(question,chunks);assert.equal(result.status,'computed',result.reason);assert.equal(result.complete,true);return result;};

test('sourced weight, height and pressure arithmetic uses retrieved values',()=>{
  assert.equal(done('What is the combined dry weight of 8 QR700 units?').calculations[0].result,10);
  assert.equal(done('An equipment drawing reserves 55 mm clearance above a QR700. What total vertical height in mm must it reserve?').calculations[0].result,400);
  assert.equal(done('A QR700 operates at 900 kPa. What is its pressure margin in kPa relative to the rated maximum?').calculations[0].result,-100);
});
test('flow calculations distinguish total capacity from required unit rounding',()=>{
  assert.equal(done('What is the combined rated maximum flow of 4 QR700 units in independent parallel lines?').calculations[0].result,28);
  assert.equal(done('How many independent QR700 units are required to meet a rated aggregate demand of 22 litres/minute? Round unit count up.').calculations[0].result,4);
  const result=done('An independent parallel-line installation needs 22 litres/minute using only QR700. Give the minimum whole unit count and its product subtotal after standard identical-product volume discount, excluding GST and freight.',[product,discounts]);
  assert.equal(result.calculations[0].result,4);assert.match(result.answerText,/46\.44/);assert.ok(!result.sourceChunkIds.includes('shipping'));
});
test('integer-cent discount and freight results use exact half-up rounding',()=>{
  const result=done('Quote 2 identical QR700 units. Calculate product subtotal after the standard volume discount, excluding GST, then standard freight and total including that freight.');
  assert.deepEqual(result.calculations.map(row=>row.result),[2322,420,2742]);assert.match(result.answerText,/27\.42/);
  assert.equal(done('At list price, ignoring discounts, freight and GST, what is the subtotal for 3 QR700 units?',[product]).calculations[0].result,3765);
});
test('per-unit discounted pricing can read order quantity after the product identifier',()=>{
  const result=done('What is the per-unit QR700 price before GST on an order for 5 identical units?');
  assert.match(result.answerText,/11\.17/);assert.equal(result.calculations[0].result,5585);
});
test('multiple products are discounted independently before summing and applying freight',()=>{
  const result=done('Quote 2 QR700 and 5 QR800 units. Apply each identical-product discount separately. Give net product subtotal excluding GST, standard freight, and total including standard freight.');
  assert.equal(result.calculations[2].result,20122);assert.equal(result.calculations.at(-1).result,20122);
});
test('warranty and replacement intervals use endpoint-inclusive deterministic calculations',()=>{
  assert.equal(done('A QR700 is 22 months old. How many whole warranty months remain, with zero if the warranty has ended?').calculations[0].result,0);
  assert.equal(done('Starting with new QR700 cartridges at month zero, how many routine replacement rounds are due through month 20, including a round exactly at that endpoint?').calculations[0].result,4);
  const result=done('A QR700 was purchased 18 months ago. State whether that age is within the stated warranty, its duration, the two documents/identifiers needed for a warranty claim, and the dispatch target for in-stock parts.');
  assert.match(result.answerText,/Yes, within/);assert.match(result.answerText,/serial number and proof of purchase/);assert.match(result.answerText,/2 business day/);
});
test('inventory demand and reorder calculations require explicit installed count evidence',()=>{
  const result=done('Prepare a scheduled full-cartridge service for 4 QR700 units with 3 compatible spares on hand. What minimum spare quantity should be ordered so stock after service reaches the reorder point? Give the reorder point too.');
  assert.equal(result.calculations[0].result,12);assert.equal(result.calculations[1].result,18);assert.match(result.answerText,/9 unit reorder/);
  const uncounted=chunk('product-qr900','# QR900 product specification\nThe QR900 is a 1 micron carbon cartridge system. Replacement cartridge code: R900.');
  const missing=calculateLocal('How many cartridges are installed in total across 4 QR900 units? Also give the replacement cartridge code.',[uncounted]);
  assert.equal(missing.applicable,true);assert.equal(missing.status,'insufficient_evidence');assert.match(missing.reason,/explicit installed/);
});
test('business-hour deadlines roll exact closing time to the next opening',()=>{
  const result=done('An urgent QR700 ticket is logged 6 business hours after Monday 08:00. Count only Monday-Friday 08:00-17:00. Give the first-response allowance, deadline, and replacement spare code.');
  assert.match(result.answerText,/1 business days after Monday at 08:00/);assert.match(result.answerText,/R700/);
});
test('missing or conflicting policy evidence cannot produce a complete answer',()=>{
  const noShipping=calculateLocal('Quote 2 identical QR700 units. Give discounted product subtotal and standard freight.',[product,discounts]);
  assert.equal(noShipping.status,'insufficient_evidence');assert.equal(noShipping.complete,false);assert.ok(noShipping.calculations.length);
  const conflicting=chunk('conflict','# QR700 product specification\nList price: AUD 99.00 excluding GST.');
  assert.equal(calculateLocal('At list price, ignoring discounts, freight and GST, what is the subtotal for 3 QR700 units?',[product,conflicting]).status,'insufficient_evidence');
  assert.equal(calculateLocal('Quote 2 QR700 and 5 QR800 units. Give product subtotal and standard freight.',[product,discounts,shipping]).status,'insufficient_evidence');
});
test('additional unsupported clauses and tax assumptions prevent full-answer bypass',()=>{
  assert.equal(calculateLocal('What is the combined dry weight of 3 QR700 units and its warranty duration?',all).status,'insufficient_evidence');
  assert.equal(calculateLocal('Quote 3 QR700 units and give its subtotal including GST.',all).status,'insufficient_evidence');
  assert.equal(calculateLocal('Quote 3 QR700 units and guarantee future profit.',all).status,'unsupported');
  assert.notEqual(calculateLocal('Quote 3 QR700 units and tell me the sales manager name.',all).status,'computed');
});
test('additional source lookup demands cannot be silently skipped by a complete calculator answer',()=>{
  for(const extra of ['its maximum flow','its operating pressure','its annual leave allowance']){
    const result=calculateLocal(`What is the combined dry weight of 3 QR700 units and ${extra}?`,all);
    assert.equal(result.status,'insufficient_evidence');assert.equal(result.complete,false);
  }
  assert.equal(calculateLocal('What is the combined dry weight of 3 QR700 units and also explain its expected reliability?',all).status,'unsupported');
});
test('every price branch respects explicit discount exclusions',()=>{
  for(const phrase of ['Ignore discounts.','Discounts are not applied.','Discounts explicitly excluded.','Ignoring discounts.']){
    const flow=done(`Use only QR700 independent units to supply at least 22 litres/minute. ${phrase} Give the minimum unit count and list-price subtotal.`,[product]);
    assert.equal(flow.calculations.at(-1).result,5020);
    const mixed=done(`Quote 2 QR700 and 5 QR800 units. ${phrase} Give product subtotal and standard freight.`,[product,other,shipping]);
    assert.equal(mixed.calculations[2].result,22510);
  }
});
test('power is computed when supplied and never falsely declared absent for unsupported power data',()=>{
  const powered=chunk('product-powered',product.text+'\nRated power: 50 W.');
  const question='For a list-price order of 3 QR700 units with discounts excluded, give the product subtotal, standard freight, and the required electrical supply type. If combined power draw cannot be calculated from the specification, say it is not specified.';
  const result=done(question,[powered,shipping]);assert.match(result.answerText,/150 watts/);assert.doesNotMatch(result.answerText,/not specified/);
  const unsupported=chunk('product-unsupported',product.text+'\nPower consumption: fifty watts.');
  assert.equal(calculateLocal(question,[unsupported,shipping]).status,'insufficient_evidence');
  const absent=done(question,[product,shipping]);assert.match(absent.answerText,/not specified in the supplied evidence/);
});
test('fractional-cent unit prices preserve the exact rational and round half-up without binary toFixed bias',()=>{
  const tiny=chunk('product-tiny',product.text.replace('AUD 12.55','AUD 0.03')),
    half=chunk('discount-half','For identical products on one order, quantities of 2 to 4 receive a 50 percent discount and quantities of 5 or more receive a 50 percent discount.');
  const result=done('What is the per-unit QR700 price before GST on an order for 2 identical units?',[tiny,half]);
  assert.equal(result.calculations.at(-1).result,2);assert.deepEqual(result.calculations.at(-1).exactResult,{numerator:'15000',denominator:'10000',unit:'AUD cents'});
  assert.match(result.answerText,/AUD 0\.015/);assert.match(result.answerText,/AUD 0\.02/);
});
test('untrusted code and unsupported dimensions never execute',()=>{
  assert.equal(done('15% of 80').calculations[0].result,12);
  assert.equal(done('Calculate 12 * 7').calculations[0].result,84);
  assert.equal(done('Convert 2.5 kg to g').calculations[0].result,2500);
  assert.equal(calculateLocal('Convert 2 kg to mm').status,'insufficient_evidence');
  assert.equal(calculateLocal('Compute process.exit(1) + 2').status,'not_applicable');
  assert.equal(calculateLocal('Calculate 1 / 0').status,'insufficient_evidence');
});
test('calculation IDs and hashes are stable and source-specific',()=>{
  const first=done('What is the combined dry weight of 3 QR700 units?'),second=done('What is the combined dry weight of 3 QR700 units?');
  assert.equal(first.toolId,second.toolId);assert.match(first.toolId,/^calc:[a-f0-9]{32}$/);assert.deepEqual(first.sourceChunkIds,['product-qr700']);
  assert.equal(first.toolChunk.hash,createHash('sha256').update(first.toolChunk.text).digest('hex'));
  assert.ok(first.claims.every(claim=>claim.citations.includes(first.toolId)&&claim.sourceChunkIds.length));
  const changed=calculateLocal('What is the combined dry weight of 3 QR700 units?',[chunk('different',product.text)]);assert.notEqual(first.toolId,changed.toolId);
  assert.equal(calculateLocal('What is the combined dry weight of 3 QR700 units?',all,{reference:{answer:'999'},expectedSourceFiles:['invented']}).toolId,first.toolId);
});
