import test,{after} from 'node:test';
import assert from 'node:assert/strict';
import {readFile,readdir} from 'node:fs/promises';
import path from 'node:path';
import {privacyHealth,scanPrivateText,scanPresidio,validatePrivacyValue,closePrivacyWorker} from '../src/privacy/patterns.mjs';
import {decodeVariants} from '../src/privacy/decode.mjs';

const root=process.cwd(),privateRoot=path.resolve(process.env.STAGE6B_PRIVATE_ROOT??path.join(root,'../Handoff-private/stage6b'));
let fixtures=[];try{fixtures=(await readFile(path.join(privateRoot,'multicountry.jsonl'),'utf8')).trim().split(/\r?\n/).map(JSON.parse);}catch(error){if(error.code!=='ENOENT')throw error;}
after(closePrivacyWorker);

test('privacy rule files cover all requested countries without code registration',async()=>{
  const files=await readdir(path.join(root,'config/privacy-rules'));
  for(const country of ['AU','US','GB','JP','DE','FR','ES','IT','CA','IN'])assert.ok(files.includes(country+'.json'));
  const rule=JSON.parse(await readFile(path.join(root,'config/privacy-rules/IN.json'),'utf8')).rules.find(row=>row.id==='IN_PAN');
  assert.equal(rule.validationKind,'format_only_checksum_not_publicly_validated');
});

test('privacy libraries are pinned in isolated Python 3.12 with local NLP assets',async()=>{
  const result=await privacyHealth();assert.equal(result.status,'ok');assert.ok(result.versions.python.startsWith('3.12.'));assert.equal(result.versions.phonenumbers,'9.0.42');assert.equal(result.versions.pythonStdnum,'2.2');assert.equal(result.versions.presidioAnalyzer,'2.2.366');assert.equal(result.versions.spacyModel,'3.8.0');
});

for(const country of ['AU','US','GB','JP','DE','FR','ES','IT','CA','IN'])test('strict rules detect supported synthetic seeds for '+country,{skip:fixtures.length===0},async()=>{
  const rows=fixtures.filter(row=>row.country===country);assert.equal(rows.length,6);
  for(const row of rows){const result=await scanPrivateText(row.content,{decode:false});assert.equal(result.status,'ok');for(const seed of row.piiSeeds.filter(seed=>seed.patternExpected)){assert.ok(result.findings.some(finding=>finding.type===seed.expectedRule&&finding.value.includes(seed.value)),'Missing supported type '+seed.type+' in '+country);}}
});

test('mutated check digits fail exact validators rather than receiving checksum credit',{skip:fixtures.length===0},async()=>{
  const rows=JSON.parse(await readFile(path.join(privateRoot,'checksum-negatives.json'),'utf8'));assert.ok(rows.length>=30);
  for(const row of rows){const result=await validatePrivacyValue(row.type,row.value);assert.equal(result.status,'ok');assert.equal(result.valid,false,'Invalid check digit incorrectly validated for '+row.type);}
});

test('encoded private fields are detected after local base64, hex, URL, HTML and Unicode decoding',async()=>{
  const email='unit'+'@'+'example.invalid';
  const samples=[Buffer.from(email).toString('base64'),Buffer.from(email).toString('hex'),email.replace('@','%40'),email.replace('@','&#64;'),email.replace('@','\\u0040')];
  for(const value of samples){const result=await scanPrivateText(value);assert.equal(result.status,'ok');assert.ok(result.findings.some(finding=>finding.type==='EMAIL'&&finding.source==='decoded'));assert.ok(result.decodedVariants.length>0);}
});

test('recursive decoder limits fail closed and do not turn arbitrary prose into data',()=>{
  assert.equal(decodeVariants('x'.repeat(17000)).failClosed,true);
  assert.equal(decodeVariants('A harmless general question.').variants.length,0);
  const encoded=Buffer.from(Buffer.from('unit'+'@'+'example.invalid').toString('base64')).toString('base64');
  assert.ok(decodeVariants(encoded).variants.some(variant=>variant.depth===2));
});

test('private extraction offsets remain correct after non-BMP Unicode characters',async()=>{
  const value='unit'+'@'+'example.invalid',text='🧪 '+value;
  const result=await scanPrivateText(text,{decode:false}),finding=result.findings.find(row=>row.type==='EMAIL');
  assert.ok(finding);assert.equal(text.slice(finding.start,finding.end)===value,true);
});

test('passport and licence generic formats require supporting keywords',async()=>{
  const value='ZZ'+''.padStart(7,'1');
  const plain=await scanPrivateText('Discuss '+value+' as an arbitrary code.',{decode:false});
  assert.equal(plain.findings.some(finding=>['PASSPORT_NUMBER','DRIVER_LICENCE'].includes(finding.type)),false);
  const labelled=await scanPrivateText('Passport: '+value,{decode:false});assert.ok(labelled.findings.some(finding=>finding.type==='PASSPORT_NUMBER'));
  const plainLabel=await scanPrivateText('Passport '+value,{decode:false});assert.ok(plainLabel.findings.some(finding=>finding.type==='PASSPORT_NUMBER'));
  const driving=await scanPrivateText('Driver licence '+value,{decode:false});assert.ok(driving.findings.some(finding=>finding.type==='DRIVER_LICENCE'));
});

test('Unicode IDN and internal email syntax are treated as private without DNS lookups',async()=>{
  for(const [local,domain]of [['担当','例え.テスト'],['internal','company']]){const value=local+'@'+domain,result=await scanPrivateText(value,{decode:false});assert.ok(result.findings.some(row=>row.type==='EMAIL'));}
});

test('Medicare issue and individual reference zero are not checksum-valid identifiers',{skip:fixtures.length===0},async()=>{
  const value=fixtures.flatMap(row=>row.piiSeeds).find(seed=>seed.type==='AU_MEDICARE').value;
  assert.equal((await validatePrivacyValue('AU_MEDICARE',value+'0')).valid,false);
  assert.equal((await validatePrivacyValue('AU_MEDICARE',value.slice(0,9)+'0')).valid,false);
});

test('invalid labelled TFN is a private warning and never checksum-valid',async()=>{
  const value='123'+' '+'456'+' '+'780';const validation=await validatePrivacyValue('AU_TFN',value);assert.equal(validation.valid,false);
  const result=await scanPrivateText('TFN: '+value,{decode:false});assert.ok(result.findings.some(finding=>finding.type==='AU_TFN_LABELED_INVALID'&&finding.validity==='invalid_checksum_or_format_labeled'));assert.equal(result.findings.some(finding=>finding.type==='AU_TFN'&&finding.validity==='checksum_valid'),false);
});

test('Presidio is an available offline comparison, separate from the strict pipeline',async()=>{
  const result=await scanPresidio('A general question about aggregate sales.');assert.equal(result.status,'ok');assert.equal(result.comparisonOnly,true);assert.ok(Number.isFinite(result.latencyMs));assert.ok(Array.isArray(result.findings));
});
