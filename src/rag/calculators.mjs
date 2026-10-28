import {createHash} from 'node:crypto';
import {performance} from 'node:perf_hooks';

// This tool accepts task text and retrieved evidence only. It never evaluates
// code, imports benchmark answers, or obtains facts from product/item IDs.
const number='([0-9]+(?:[.,][0-9]+)*)';
const decimal=value=>Number(String(value).replaceAll(',',''));
const hash=value=>createHash('sha256').update(typeof value==='string'?value:JSON.stringify(value)).digest('hex');
const unique=values=>[...new Set(values)];
const esc=value=>String(value).replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
const fmt=value=>Number.isInteger(value)?String(value):String(Number(value.toFixed(6)));
const money=value=>`AUD ${(value/100).toFixed(2)}`;
const cents=value=>{const clean=String(value).replaceAll(',','');if(!/^\d+(?:\.\d+)?$/.test(clean))throw new Missing('Unsupported monetary literal');const [whole,fraction='']=clean.split('.'),padded=(fraction+'000').slice(0,3);return Number(BigInt(whole)*100n+BigInt(padded.slice(0,2))+BigInt(padded[2]>='5'));};
const discountCents=(price,quantity,basisPoints)=>Number((BigInt(price)*BigInt(quantity)*BigInt(10000-basisPoints)+5000n)/10000n);
const decimalMillionths=value=>{const whole=value/1000000n,fraction=String(value%1000000n).padStart(6,'0').replace(/0+$/,'');return String(whole)+(fraction?'.'+fraction:'');};
const words={one:1,two:2,three:3,four:4,five:5,six:6,single:1};
const id=value=>String(value).replaceAll('-','').toUpperCase();
class Missing extends Error{}
function evidenceFact(chunks,expression,{text=false,label='required source fact'}={}){
  const found=[];
  for(const chunk of chunks){const match=expression.exec(chunk.text);if(match)found.push({value:text?match[1].trim():decimal(match[1]),sourceChunkIds:[chunk.chunkId],sourceHashes:[chunk.hash??hash(chunk.text)]});}
  const values=unique(found.map(row=>JSON.stringify(row.value)));
  if(values.length!==1)throw new Missing(values.length?'Conflicting retrieved evidence for '+label:'Missing retrieved evidence for '+label);
  return{...found[0],sourceChunkIds:unique(found.flatMap(row=>row.sourceChunkIds)),sourceHashes:unique(found.flatMap(row=>row.sourceHashes))};
}
function questionNumber(question,expression,label){const match=expression.exec(question);if(!match)throw new Missing('Cannot unambiguously identify '+label+' in the question');const value=decimal(match[1]);if(!Number.isFinite(value)||Math.abs(value)>1e9)throw new Missing('Question number is outside supported bounds');return{value,sourceChunkIds:[],sourceHashes:[],origin:'question'};}
function productSources(question,chunks){
  const products=new Map();
  for(const chunk of chunks){const match=/^\s*#\s*([A-Za-z]+-?\d+)\s+product\s+specification/im.exec(chunk.text);if(match){const code=id(match[1]);if(!products.has(code))products.set(code,[]);products.get(code).push(chunk);}}
  // A later chunk in a split product document inherits the entity only from a
  // retrieved header in that same source, not from a benchmark ID or reference.
  for(const[code,known]of products){const files=new Set(known.map(chunk=>chunk.file));for(const chunk of chunks)if(files.has(chunk.file)&&!known.includes(chunk))known.push(chunk);}
  const codes=unique((question.match(/\b[A-Za-z]{1,8}-?\d{2,6}\b/g)??[]).map(id)).filter(code=>products.has(code));
  return{products,codes};
}
const fields={
  price:/List price:\s*(?:AUD\s*|\$\s*)([0-9]+(?:[.,][0-9]+)*)/i,
  flow:/Maximum flow:\s*([0-9]+(?:\.[0-9]+)*)\s*(?:litres?|liters?)\s*(?:per minute|\/\s*min)/i,
  pressure:/Maximum (?:operating )?pressure:\s*([0-9]+(?:\.[0-9]+)*)\s*kPa/i,
  weight:/Dry weight:\s*([0-9]+(?:\.[0-9]+)*)\s*kg/i,
  height:/Height:\s*([0-9]+(?:\.[0-9]+)*)\s*mm/i,
  warranty:/Warranty:\s*([0-9]+(?:\.[0-9]+)*)\s*months/i,
  interval:/Routine replacement interval:\s*([0-9]+(?:\.[0-9]+)*)\s*months/i,
  spare:/Replacement (?:cartridge|membrane) code:\s*([A-Za-z]+\d+)/i,
};
function productFact(sources,name){const fact=evidenceFact(sources,fields[name],{text:name==='spare',label:name});if(name==='price')return{...fact,value:cents(fact.value),unit:'AUD cents'};return fact;}
function installedCount(sources){
  const found=[];
  for(const chunk of sources){const match=/\bwith\s+(one|two|three|four|five|six|\d+)\s+(?:\d+(?:\.\d+)?\s+micron\s+)?(?:cartridges|membranes)\b/i.exec(chunk.text)??/\b(single)\s+(?:cartridge|membrane)\b/i.exec(chunk.text);if(match)found.push({value:words[match[1].toLowerCase()]??Number(match[1]),sourceChunkIds:[chunk.chunkId],sourceHashes:[chunk.hash??hash(chunk.text)]});}
  if(!found.length||unique(found.map(row=>row.value)).length!==1)throw new Missing('An explicit installed cartridge/membrane count is not present in retrieved evidence');return found[0];
}
function policy(chunks,kind){
  const patterns={threshold:/Free standard freight applies to orders of at least\s*(?:AUD\s*|\$\s*)([0-9]+(?:[.,][0-9]+)*)/i,freight:/Below that threshold,\s*standard freight is\s*(?:AUD\s*|\$\s*)([0-9]+(?:[.,][0-9]+)*)/i,
    quoteDays:/Quotes remain valid for\s*(\d+)\s*days/i,returnDays:/returned within\s*(\d+)\s*calendar days/i,dispatch:/In-stock parts dispatch within\s*(\d+)\s*business day/i,
    leadTime:/Supplier lead time is\s*(\d+)\s*business days/i,urgent:/Urgent tickets have a first-response target of\s*(\d+)\s*business hours/i,standard:/Standard tickets have a first-response target of\s*(\d+)\s*business hours/i,
    metro:/Western Australia metro delivery target:\s*(\d+)\s*business days/i,otherDelivery:/Other Australian destinations:\s*(\d+)\s*business days/i};
  const fact=evidenceFact(chunks,patterns[kind],{label:kind});return['threshold','freight'].includes(kind)?{...fact,value:cents(fact.value),unit:'AUD cents'}:fact;
}
function discountRate(chunks,quantity){
  const bands=[];
  for(const chunk of chunks){for(const match of chunk.text.matchAll(/quantities of\s*(\d+)\s*(?:to\s*(\d+)|or more)\s*receive\s*(?:a|an)\s*(\d+(?:\.\d+)?)\s*percent discount/gi))bands.push({min:Number(match[1]),max:match[2]?Number(match[2]):Infinity,rate:Number(match[3]),chunk});}
  if(!bands.length)throw new Missing('Missing retrieved standard volume-discount bands');
  const matching=bands.filter(b=>quantity>=b.min&&quantity<=b.max),rates=unique(matching.map(b=>b.rate));if(rates.length>1)throw new Missing('Conflicting retrieved discount bands');
  if(!matching.length&&quantity>=Math.min(...bands.map(b=>b.min)))throw new Missing('Question quantity is outside the retrieved standard discount bands');
  const value=matching[0]?.rate??0;if(value<0||value>100||String(value).split('.')[1]?.length>2)throw new Missing('Discount rate must be between 0 and 100 percent with at most two decimal places');
  return{value,sourceChunkIds:unique((matching.length?matching:bands).map(b=>b.chunk.chunkId)),sourceHashes:unique((matching.length?matching:bands).map(b=>b.chunk.hash??hash(b.chunk.text)))};
}
function inventoryFact(chunks,kind,code){
  const line=new RegExp(`${kind==='reorder'?'Reorder points':'Safety stock'}:\\s*([^\\n]+)`,'i');const matching=chunks.flatMap(chunk=>{const text=line.exec(chunk.text)?.[1];if(!text)return[];const match=new RegExp(`\\b${esc(code)}\\s+(\\d+)\\s*units?`,'i').exec(text);return match?[{value:Number(match[1]),sourceChunkIds:[chunk.chunkId],sourceHashes:[chunk.hash??hash(chunk.text)]}]:[];});
  if(!matching.length||unique(matching.map(f=>f.value)).length!==1)throw new Missing(`Missing or conflicting ${kind} policy for ${code}`);return matching[0];
}
function quantityFor(question,code){const expression=new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s+(?:identical\\s+|newly installed\\s+)?${esc(code).replace(/([A-Z]+)(\d+)/,'$1-?$2')}\\b`,'i');const value=expression.test(question)?questionNumber(question,expression,code+' quantity'):questionNumber(question,/order (?:for|of)\s*(\d+(?:\.\d+)?)\s*identical units/i,code+' order quantity');if(!Number.isInteger(value.value)||value.value<1)throw new Missing('Physical product quantity must be a positive whole number');return value;}
function has(question,pattern){return pattern.test(question);}

/** Deterministic, allowlisted business arithmetic. Sources remain local. */
export function calculateLocal(question,chunks=[],options={}){
  const started=performance.now(),q=String(question??''),calculations=[],parts=[],claims=[],used=new Set();let applicable=false,intent=null;
  const safeChunks=Array.isArray(chunks)?chunks.filter(chunk=>typeof chunk?.chunkId==='string'&&typeof chunk.text==='string'):[];
  const add=(expression,operands,result,unit,label)=>{
    if(!Number.isFinite(result)||Math.abs(result)>Number.MAX_SAFE_INTEGER)throw new Missing('Calculation exceeds safe deterministic numeric range');
    const sources=unique(operands.flatMap(f=>f.sourceChunkIds??[]));sources.forEach(source=>used.add(source));
    calculations.push({expression,operands:operands.map(f=>({value:f.value,unit:f.unit??null,sourceChunkIds:f.sourceChunkIds??[],origin:f.origin??'retrieved_evidence',...(f.calculationIndex!=null?{calculationIndex:f.calculationIndex}:{})})),result,unit,sourceChunkIds:sources});
    if(label){parts.push(label);claims.push({text:label,sourceChunkIds:sources});}return{value:result,unit,sourceChunkIds:sources,origin:'derived_calculation',calculationIndex:calculations.length-1};
  };
  const direct=(text,facts=[])=>{const sources=unique(facts.flatMap(f=>f.sourceChunkIds??[]));sources.forEach(source=>used.add(source));parts.push(text);claims.push({text,sourceChunkIds:sources});};
  let status='not_applicable',reason='No supported deterministic arithmetic intent';
  try{
    if(!q.trim())return finalize();
    // Closed scalar formats are supported without executing arbitrary code.
    let match=/^\s*(?:what is|calculate|compute)?\s*(\d+(?:\.\d+)?)\s*%\s*(?:of)\s*(\d+(?:\.\d+)?)\s*[?.]?\s*$/i.exec(q);
    if(match){applicable=true;intent='percentage';const a={value:Number(match[1]),origin:'question'},b={value:Number(match[2]),origin:'question'},result=a.value*b.value/100;add('percentage * amount / 100',[a,b],result,'scalar',`${fmt(a.value)}% of ${fmt(b.value)} is ${fmt(result)}.`);status='computed';return finalize();}
    match=/^\s*(?:what is|calculate|compute)?\s*(-?\d+(?:\.\d+)?)\s*([+*\/−-]|×)\s*(-?\d+(?:\.\d+)?)\s*[?.]?\s*$/i.exec(q);
    if(match){applicable=true;intent='scalar';const a={value:Number(match[1]),origin:'question'},b={value:Number(match[3]),origin:'question'},op=match[2];if(op==='/'&&b.value===0)throw new Missing('Division by zero is undefined');const result=op==='+'?a.value+b.value:['-','−'].includes(op)?a.value-b.value:op==='/'?a.value/b.value:a.value*b.value;add('left '+op+' right',[a,b],result,'scalar',`${fmt(a.value)} ${op} ${fmt(b.value)} = ${fmt(result)}.`);status='computed';return finalize();}
    match=/^\s*(?:convert\s+)?(\d+(?:\.\d+)?)\s*(kg|g|mm|cm|m|litres?|liters?)\s+(?:to|into)\s*(kg|g|mm|cm|m|litres?|liters?)\s*[?.]?\s*$/i.exec(q);
    if(match){applicable=true;intent='unit-conversion';const units={kg:['mass',1000],g:['mass',1],mm:['length',1],cm:['length',10],m:['length',1000],litre:['volume',1],litres:['volume',1],liter:['volume',1],liters:['volume',1]},from=match[2].toLowerCase(),to=match[3].toLowerCase();if(units[from][0]!==units[to][0])throw new Missing('Units have incompatible dimensions');const value={value:Number(match[1]),origin:'question'},result=value.value*units[from][1]/units[to][1];add('value * source scale / target scale',[value],result,to,`${fmt(value.value)} ${from} = ${fmt(result)} ${to}.`);status='computed';return finalize();}
    const arithmetic=/combined dry weight|combined rated maximum flow|subtotal|quote\s+\d|per-unit .*price|total vertical height|whole unit count|round unit count up|minimum .*unit|pressure margin|warranty months remain|replacement rounds|installed in total|quantity (?:should be )?ordered|spare quantity|stock after service|remaining stock|shortfall|shortage|routine replacement spares|business hours after Monday|first-response allowance|age is within|original list-price|budget.*flow|qualify for free freight/i.test(q);
    if(!arithmetic)return finalize();applicable=true;
    if(/causal|stochastic|statistical power|guarantee|optimisation|optimization|elasticity|Bayesian|correlated|forecast.*probability|execute|run code|private.*(?:email|phone)|\band\s+(?:also\s+)?(?:explain|describe|recommend|identify|tell|name|prove|forecast|predict)\b/i.test(q)){status='unsupported';reason='This request needs unsupported modelling, execution or an additional non-calculation request rather than a closed deterministic calculation';return finalize();}
    const {products,codes}=productSources(q,safeChunks);
    const mentioned=unique((q.match(/\b[A-Za-z]{1,8}-?\d{2,6}\b/g)??[]).map(id));
    const productPrefixes=unique([...products.keys()].map(code=>/^[A-Z]+/.exec(code)?.[0]));
    if(!codes.length||mentioned.some(code=>productPrefixes.includes(/^[A-Z]+/.exec(code)?.[0])&&!products.has(code)))throw new Missing('The question product specification was not retrieved');
    const code=codes[0],sources=products.get(code),pf=name=>productFact(sources,name);
    const amount=()=>quantityFor(q,code),wantFreight=has(q,/standard freight|free[- ]freight threshold|freight (?:applies|charged|amount)|total including.*freight|qualify for free freight/i),ignoreDiscounts=has(q,/(?:ignore|ignoring|exclude|excluding)\s+(?:standard\s+)?discounts?|discounts?\s+(?:explicitly\s+)?(?:excluded|ignored)|discounts?\s+(?:are\s+)?not\s+(?:applied|included)/i),useDiscount=has(q,/discount|per-unit.*order for|quote\s+\d/i)&&!ignoreDiscounts;
    const freight=(subtotal)=>{const threshold=policy(safeChunks,'threshold'),fee=policy(safeChunks,'freight'),result=subtotal.value>=threshold.value?0:fee.value;return add('subtotal >= free-freight threshold ? 0 : standard fee',[subtotal,threshold,fee],result,'AUD cents',`Standard freight is ${money(result)}; the free-freight threshold is ${money(threshold.value)} excluding GST.`);};
    const discounted=(quantity,productCode)=>{const price=productFact(products.get(productCode),'price'),rate=discountRate(safeChunks,quantity.value),result=discountCents(price.value,quantity.value,cents(rate.value));return add('round-half-up(unit price cents * quantity * (10000 - discount basis points) / 10000)',[price,quantity,rate],result,'AUD cents',`${productCode}: ${fmt(quantity.value)} units at a ${fmt(rate.value)} percent standard discount give a product subtotal of ${money(result)} excluding GST.`);};
    const listSubtotal=(quantity,productCode)=>{const price=productFact(products.get(productCode),'price');return add('list price cents * quantity',[price,quantity],price.value*quantity.value,'AUD cents',`${productCode} product subtotal is ${money(price.value*quantity.value)} excluding GST.`);};
    if(has(q,/combined dry weight/i)){intent='total-weight';const count=amount(),weight=pf('weight'),result=weight.value*count.value;add('dry weight kg * quantity',[weight,count],result,'kg',`Combined dry weight is ${fmt(result)} kg.`);}
    else if(has(q,/combined rated maximum flow/i)){intent='parallel-capacity';const count=amount(),flow=pf('flow'),result=flow.value*count.value;add('unit maximum flow * independent unit quantity',[flow,count],result,'litres/minute',`Combined rated maximum flow is ${fmt(result)} litres/minute for independent parallel lines.`);}
    else if(has(q,/total vertical height/i)){intent='vertical-clearance';const clearance=questionNumber(q,new RegExp(`${number}\\s*mm clearance`,'i'),'clearance'),height=pf('height'),result=height.value+clearance.value;add('height mm + reserved clearance mm',[height,clearance],result,'mm',`Reserve ${fmt(result)} mm total vertical height.`);}
    else if(has(q,/pressure margin/i)){intent='pressure-margin';const operating=questionNumber(q,new RegExp(`operates at\\s*${number}\\s*kPa`,'i'),'operating pressure'),maximum=pf('pressure'),result=maximum.value-operating.value;add('maximum pressure - operating pressure',[maximum,operating],result,'kPa',`The pressure margin is ${fmt(result)} kPa.`);}
    else if(has(q,/warranty months remain/i)){intent='warranty-remaining';const age=questionNumber(q,new RegExp(`${number}\\s*months old`,'i'),'age'),warranty=pf('warranty'),result=Math.max(0,warranty.value-age.value);add('max(0, warranty months - age months)',[warranty,age],result,'months',`${fmt(result)} whole warranty months remain.`);}
    else if(has(q,/replacement rounds/i)){intent='replacement-rounds';const horizon=questionNumber(q,new RegExp(`through month\\s*${number}`,'i'),'horizon'),interval=pf('interval'),result=Math.floor(horizon.value/interval.value);add('floor(horizon months / replacement interval months)',[horizon,interval],result,'rounds',`${fmt(result)} routine replacement rounds are due through month ${fmt(horizon.value)}.`);}
    else if(has(q,/business hours after Monday|first-response allowance/i)){intent='business-time';const elapsed=questionNumber(q,new RegExp(`logged\\s*${number}\\s*business hours`,'i'),'elapsed business time'),urgency=has(q,/\burgent\b/i)?'urgent':'standard',target=policy(safeChunks,urgency),hours=evidenceFact(safeChunks,/Support hours are Monday to Friday,\s*(\d{2}:\d{2}\s*to\s*\d{2}:\d{2})/i,{text:true,label:'business opening hours'}),m=/^(\d{2}):(\d{2})\s*to\s*(\d{2}):(\d{2})/.exec(hours.value),start=Number(m[1])*60+Number(m[2]),end=Number(m[3])*60+Number(m[4]),duration=(end-start)/60;if(duration<=0)throw new Missing('Unsupported overnight service hours');const total=elapsed.value+target.value,days=Math.floor(total/duration),clock=start+(total%duration)*60;const clockText=`${String(Math.floor(clock/60)).padStart(2,'0')}:${String(Math.round(clock%60)).padStart(2,'0')}`;add('elapsed business hours + response allowance',[elapsed,target,hours],total,'business hours',`The ${urgency} first-response allowance is ${fmt(target.value)} business hours. Deadline: ${days} business days after Monday at ${clockText}.`);const spare=pf('spare');direct(`Replacement spare code: ${spare.value}.`,[spare]);}
    else if(has(q,/age is within|purchased .* months ago.*warranty/i)){intent='warranty-check';const age=questionNumber(q,new RegExp(`purchased\\s*${number}\\s*months ago`,'i'),'age'),warranty=pf('warranty');add('age months <= warranty months',[age,warranty],Number(age.value<=warranty.value),'boolean',`${age.value<=warranty.value?'Yes, within':'No, outside'} the stated ${fmt(warranty.value)} month warranty${age.value===warranty.value?' (at the warranty limit)':''}; claim approval is not guaranteed.`);const claims=evidenceFact(safeChunks,/Warranty claims require\s*([^\.]+)/i,{text:true,label:'warranty claim requirements'});direct(`A warranty claim requires ${claims.value}.`,[claims]);const dispatch=policy(safeChunks,'dispatch');direct(`In-stock parts dispatch within ${fmt(dispatch.value)} business day.`,[dispatch]);}
    else if(has(q,/installed in total|quantity consumed|remaining stock|minimum spare quantity|shortfall|shortage|routine replacement spares|each required spare quantity/i)){
      intent='spare-inventory';const count=amount(),installed=installedCount(sources),spare=pf('spare');let demand=add('unit quantity * installed spare count',[count,installed,spare],count.value*installed.value,'spares',has(q,/routine replacement spares.*12 months/i)?null:`${spare.value}: ${fmt(count.value*installed.value)} spares are needed.`);
      if(has(q,/routine replacement spares.*12 months/i)){const interval=pf('interval'),rounds={value:Math.floor(12/interval.value),sourceChunkIds:interval.sourceChunkIds};demand=add('unit quantity * installed spare count * floor(12 / interval months)',[count,installed,interval],count.value*installed.value*rounds.value,'spares',`Annual replacement quantity is ${fmt(count.value*installed.value*rounds.value)} ${spare.value} spares, excluding installation and including month 12.`);}
      if(has(q,/on hand|currently hold|stock is/i)){const stock=questionNumber(q,new RegExp(`(?:with|hold|stock is)\\s*${number}\\s*(?:compatible\\s+)?spares?`,'i'),'spares on hand');if(has(q,/minimum spare quantity|quantity should be ordered/i)){const reorder=inventoryFact(safeChunks,'reorder',spare.value),order=Math.max(0,demand.value+reorder.value-stock.value);add('max(0, demand + reorder point - on-hand stock)',[demand,reorder,stock],order,'spares',`Order ${fmt(order)} ${spare.value} spares so the post-service stock reaches the ${fmt(reorder.value)} unit reorder point.`);}else if(has(q,/shortage/i)){add('max(0, demand - on-hand stock)',[demand,stock],Math.max(0,demand.value-stock.value),'spares',`The shortage is ${fmt(Math.max(0,demand.value-stock.value))} ${spare.value} spares.`);}else{add('on-hand stock - service demand',[stock,demand],stock.value-demand.value,'spares',`Remaining stock is ${fmt(stock.value-demand.value)} ${spare.value} spares.`);const reorder=inventoryFact(safeChunks,'reorder',spare.value);direct(`The reorder point is ${fmt(reorder.value)} units.`,[reorder]);}}
      if(has(q,/safety stock/i)){const safety=inventoryFact(safeChunks,'safety',spare.value);direct(`Policy safety stock is ${fmt(safety.value)} units.`,[safety]);if(has(q,/shortfall/i))add('max(0, demand - safety stock)',[demand,safety],Math.max(0,demand.value-safety.value),'spares',`The shortfall is ${fmt(Math.max(0,demand.value-safety.value))} units.`);}
      if(has(q,/supplier lead time/i)){const lead=policy(safeChunks,'leadTime');direct(`Supplier lead time is ${fmt(lead.value)} business days.`,[lead]);}
      if(has(q,/rush order/i)){const approval=evidenceFact(safeChunks,/Rush orders require\s*([^\.]+)/i,{text:true,label:'rush approval'});direct(`Rush orders require ${approval.value}.`,[approval]);const urgent=policy(safeChunks,'urgent');direct(`Urgent first response is ${fmt(urgent.value)} business hours.`,[urgent]);}
      if(codes.length>1)throw new Missing('Mixed-product spare plans are not yet supported by this calculator');
    }
    else{
      intent='price-or-flow';let subtotal;
      if(has(q,/litres?\s*\/\s*minute|liters?\s*\/\s*minute|litres? per minute/i)&&has(q,/minimum|whole unit|round unit count up/i)){
        const required=questionNumber(q,new RegExp(`(?:needs|at least|supply|demand of)\\s*${number}\\s*(?:litres?|liters?)`,'i'),'required flow'),flow=pf('flow'),units=add('ceil(required flow / unit maximum flow)',[required,flow],Math.ceil(required.value/flow.value),'units',`Minimum whole unit count: ${fmt(Math.ceil(required.value/flow.value))} ${code} units.`);
        if(has(q,/subtotal|price|product cost/i)||wantFreight||useDiscount)subtotal=useDiscount?discounted(units,code):listSubtotal(units,code);
      }else if(codes.length>1&&has(q,/quote/i)){
        if(codes.some(c=>!q.match(new RegExp(`\\d+\\s+${esc(c)}`,'i'))))throw new Missing('Every product needs an explicit quantity');
        const totals=codes.map(c=>useDiscount?discounted(quantityFor(q,c),c):listSubtotal(quantityFor(q,c),c));subtotal=add('sum(separate product subtotals)',totals,totals.reduce((s,f)=>s+f.value,0),'AUD cents',`Net product subtotal is ${money(totals.reduce((s,f)=>s+f.value,0))} excluding GST.`);
      }else{
        let quantity;
        if(has(q,/one\s+[A-Za-z]+-?\d+.*qualify for free freight/i))quantity={value:1,origin:'question',sourceChunkIds:[]};else quantity=amount();
        subtotal=useDiscount?discounted(quantity,code):listSubtotal(quantity,code);
        if(has(q,/per-unit/i)){const price=pf('price'),rate=useDiscount?discountRate(safeChunks,quantity.value):{value:0,sourceChunkIds:[],origin:'question'},numerator=BigInt(price.value)*BigInt(10000-cents(rate.value)),rounded=Number((numerator+5000n)/10000n);add('round-half-up(unit price cents * (10000 - discount basis points) / 10000)',[price,quantity,rate],rounded,'AUD cents',`Exact per-unit price before GST is AUD ${decimalMillionths(numerator)}; rounded half-up to currency cents, it is ${money(rounded)}.`);calculations.at(-1).exactResult={numerator:String(numerator),denominator:'10000',unit:'AUD cents'};}
      }
      if(subtotal&&wantFreight){const fee=freight(subtotal);if(has(q,/qualify for free freight/i)){const threshold=policy(safeChunks,'threshold');add('subtotal >= free-freight threshold',[subtotal,threshold],Number(subtotal.value>=threshold.value),'boolean',`${subtotal.value>=threshold.value?'Yes, it qualifies':'No, it does not qualify'} for free standard freight.`);}if(has(q,/total including/i))add('product subtotal cents + freight cents',[subtotal,fee],subtotal.value+fee.value,'AUD cents',`Total including standard freight is ${money(subtotal.value+fee.value)} excluding GST.`);}
      if(has(q,/return window|restocking|change-of-mind/i)){const days=policy(safeChunks,'returnDays'),fee=evidenceFact(safeChunks,/(no restocking fee)/i,{text:true,label:'restocking fee'}),payer=evidenceFact(safeChunks,/(?:The )?(customer pays change-of-mind return freight)/i,{text:true,label:'return freight payer'});direct(`The return window is ${fmt(days.value)} calendar days; the restocking fee is AUD 0.00. The ${payer.value}.`,[days,fee,payer]);}
      if(has(q,/quote validity|validity period|accepted .* days after/i)){const validity=policy(safeChunks,'quoteDays'),age=questionNumber(q,new RegExp(`accepted\\s*${number}\\s*calendar days`,'i'),'quote age');add('quote age days <= validity days',[age,validity],Number(age.value<=validity.value),'boolean',`Quote validity is ${fmt(validity.value)} days; ${age.value<=validity.value?'within validity, a valid quote':'expired, outside validity'}.`);const delivery=policy(safeChunks,has(q,/WA metro|Western Australia metro/i)?'metro':'otherDelivery');direct(`Standard delivery target is ${fmt(delivery.value)} business days.`,[delivery]);}
      if(has(q,/electrical supply|combined power draw/i)){
        if(has(q,/electrical supply/i)){const none=sources.filter(chunk=>/No electrical power is required/i.test(chunk.text)),voltage=sources.flatMap(chunk=>{const m=/requires a\s*(\d+)\s*volt\s*(DC)? supply/i.exec(chunk.text);return m?[{chunk,value:Number(m[1])}]:[];});if(none.length)direct('No electrical power is required.',none.map(chunk=>({sourceChunkIds:[chunk.chunkId]})));else if(voltage.length)direct(`The supply is ${voltage[0].value} volt DC.`,[{sourceChunkIds:[voltage[0].chunk.chunkId]}]);else throw new Missing('Electrical supply is absent from retrieved evidence');}
        if(has(q,/combined power draw/i)){const power=sources.flatMap(chunk=>{const m=/(?:power draw|power consumption|rated power)\s*:\s*(\d+(?:\.\d+)?)\s*(kW|W|watts?|kilowatts?)\b/i.exec(chunk.text);return m?[{value:Number(m[1])*(/^k/i.test(m[2])?1000:1),unit:'watts',sourceChunkIds:[chunk.chunkId]}]:[];});if(power.length&&unique(power.map(f=>f.value)).length===1){const quantity=amount();add('unit power watts * quantity',[power[0],quantity],power[0].value*quantity.value,'watts',`Combined power draw is ${fmt(power[0].value*quantity.value)} watts.`);}else if(power.length||sources.some(chunk=>/\bwatts?|\bkilowatts?|\bkW\b|(?:power draw|power consumption|rated power)\s*:/i.test(chunk.text)))throw new Missing('Power data is conflicting or uses an unsupported quantity/unit format');else direct('Combined power draw is not specified in the supplied evidence and cannot be calculated from it.',sources.map(chunk=>({sourceChunkIds:[chunk.chunkId]})));}
      }
    }
    const body=parts.join('\n');
    const requiredClauses=[[/\bweight\b/i,/\bweight\b/i,'weight'],[/vertical height/i,/vertical height/i,'height'],[/pressure margin/i,/pressure margin/i,'pressure margin'],[/maximum flow|flow rating/i,/maximum flow|flow rating/i,'maximum flow'],[/operating pressure|pressure limit|maximum pressure/i,/operating pressure|pressure limit|maximum pressure/i,'operating pressure'],[/warranty/i,/warranty/i,'warranty'],[/replacement rounds/i,/replacement rounds/i,'replacement rounds'],[/subtotal/i,/subtotal/i,'subtotal'],[/per-unit/i,/per-unit/i,'per-unit price'],[/reorder point/i,/reorder point/i,'reorder point'],[/safety stock/i,/safety stock/i,'safety stock'],[/supplier lead time/i,/supplier lead time/i,'supplier lead time'],[/first-response allowance|first-response target/i,/first.response/i,'response allowance'],[/deadline/i,/deadline/i,'deadline'],[/quote validity|validity period/i,/quote validity/i,'quote validity'],[/delivery target/i,/delivery target/i,'delivery target'],[/electrical supply/i,/electrical power|supply is/i,'electrical supply']];
    for(const[requested,covered,label]of requiredClauses)if(requested.test(q)&&!covered.test(body))throw new Missing('The calculator does not cover the requested '+label+' clause');
    if(/including GST|after GST|GST amount|GST rate/i.test(q))throw new Missing('GST calculation requires an explicit retrieved tax rate');
    if(/\bcolour\b|\bcolor\b|email|phone|\baddress\b|certification|future profit|future sales|manager(?:'s)? name|employee(?:'s)? name|customer(?:'s)? name|operating temperature|annual leave|probation|staff training|retention period|tell (?:me )?a joke/i.test(q))throw new Missing('The calculator does not cover an additional requested non-arithmetic clause');
    if(!calculations.length)throw new Missing('No supported arithmetic result was established');status='computed';reason='All requested supported calculation clauses were computed from question values and retrieved evidence';
  }catch(error){status=applicable?'insufficient_evidence':'not_applicable';reason=error instanceof Missing?error.message:'The calculator could not safely parse this task';}
  return finalize();

  function finalize(){
    const sourceChunkIds=[...used].sort(),trace={version:'local-business-calculators-v1',intent,questionHash:hash(q),calculations,sourceHashes:safeChunks.filter(c=>used.has(c.chunkId)).map(c=>({chunkId:c.chunkId,hash:c.hash??hash(c.text)})).sort((a,b)=>a.chunkId.localeCompare(b.chunkId))},toolId='calc:'+hash(trace).slice(0,32),answerText=parts.join('\n');
    const citedClaims=claims.map(claim=>({text:claim.text,citations:[toolId,...claim.sourceChunkIds],sourceChunkIds:claim.sourceChunkIds}));
    const toolText=`DETERMINISTIC LOCAL CALCULATOR. Status: ${status}.\n${answerText}\n${status==='computed'?'All supported requested clauses were computed.':`LIMIT: ${reason}`}\nCalculations: ${calculations.map(step=>`${step.expression} = ${fmt(step.result)} ${step.unit}`).join('; ')}`;
    const toolChunk=calculations.length?{chunkId:toolId,file:'local-calculator',location:'deterministic arithmetic',text:toolText,hash:hash(toolText),sourceChunkIds,score:1,isTool:true}:null;
    return{applicable,eligible:applicable,complete:status==='computed',status,toolId,arithmeticIntent:intent,calculations,answerText,claims:citedClaims,sourceChunkIds,citations:calculations.length?[toolId,...sourceChunkIds]:[],toolChunk,traceHash:hash(trace),latencyMs:performance.now()-started,reason};
  }
}
