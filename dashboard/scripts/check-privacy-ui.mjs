import assert from 'node:assert/strict';
import {readPrivacyResults} from '../server/privacy-results.mjs';
import {wilsonInterval} from '../../src/comparison/metrics.mjs';
import {createPrivacyRenderer,privacyExampleHtml,PRIVACY_PANELS} from './export-privacy-dashboard.mjs';

const component=await createPrivacyRenderer();
const visible=html=>html.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,'').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&#x([a-f0-9]+);/gi,(_,value)=>String.fromCodePoint(parseInt(value,16))).replace(/&#([0-9]+);/g,(_,value)=>String.fromCodePoint(parseInt(value,10))).replace(/&amp;/g,'&').replace(/&quot;/g,'"').replace(/&#x27;/g,"'").replace(/\s+/g,' ').trim();
const count=value=>new Intl.NumberFormat('en-AU',{maximumFractionDigits:0}).format(value);
const percent=value=>`${(value*100).toFixed(1)}%`;
const pair=value=>`${count(value.events)}/${count(value.n)}`;
const metric=(events,n)=>({events,n,rate:n?events/n:null,wilson95:wilsonInterval(events,n),errors:0});
let cases=0;
function render(report,panel){
  const html=component(report,panel),text=visible(html);
  assert.doesNotMatch(text,/\b(?:NaN|undefined|Infinity)\b/);
  cases++;
  return{html,text};
}
function measured(text,value){
  if(!value){assert.match(text,/Pending/);return;}
  assert.ok(text.includes(pair(value)),`Recorded events and denominator must be visible`);
  if(value.rate!=null)assert.ok(text.includes(percent(value.rate)),`Recorded measured rate must be visible`);
  if(value.wilson95)assert.ok(text.includes(`${percent(value.wilson95[0])}–${percent(value.wilson95[1])}`),`Recorded Wilson interval must be visible`);
}

for(const panel of [undefined,...PRIVACY_PANELS]){
  const {text}=render(null,panel);assert.match(text,/Measurements pending/);assert.doesNotMatch(text,/\d+\/\d+|\d+(?:\.\d+)?%|\bPASS\b|\bFAIL\b/);
}

const report=await readPrivacyResults();
assert.ok(report,'A hash-verified completed local report is required for Stage 6e exports');
assert.equal(report.cloudCalls,0);assert.equal(report.spendUsd,0);assert.equal(report.liveDispatchEnabled,false);
const all=render(report);
for(const panel of PRIVACY_PANELS)assert.equal((all.html.match(new RegExp(`data-export-panel="${panel}"`,'g'))??[]).length,1);

const headline=render(report,'headline');
const renderedRows=[...headline.html.matchAll(/<tr\b[^>]*>[\s\S]*?<\/tr>/g)].map(match=>visible(match[0]));
for(const setup of report.setups){
  const text=renderedRows.find(value=>value.includes(setup.label));assert.ok(text,'Each setup must retain a distinct measured row');
  for(const value of [setup.pii.frozen,setup.pii.multicountry,setup.usable.frozen,setup.usable.multicountry,setup.attacks,setup.safe,setup.applications.complete])measured(text,value);
  if(setup.applications.fullCredit)assert.ok(text.includes('Full credit '+pair(setup.applications.fullCredit)));
  assert.ok(text.includes(setup.gate.status));for(const reason of setup.gate.reasons)assert.ok(text.includes(reason));
}
if(report.setups.some(setup=>setup.usable.frozen?.n>0&&setup.usable.frozen.events===0)){
  assert.match(headline.text,/Zero survivors does not mean usable service/);
  assert.match(headline.text,/Empty or unavailable questions cannot establish successful private answers/);
}

const progress=render(report,'progress');
let last=-1;for(const stage of report.progress){const position=progress.text.indexOf(`Stage ${stage.stage}`);assert.ok(position>last);last=position;for(const setup of stage.setups)for(const value of [setup.usableFrozen,setup.usableMulticountry,setup.safeOperational,setup.safeDetected])if(value)assert.ok(progress.text.includes(pair(value)));}
assert.match(progress.text,/available checks|available-check/);assert.match(progress.text,/methods and populations|methods differ/);

const attribution=render(report,'attribution');
for(const setup of report.setups)for(const row of setup.attribution){assert.ok(attribution.text.includes(row.label));if(row.overlapping)assert.ok(attribution.text.includes(pair(row.overlapping)));}
for(const label of ['Tokenize lost-intent','Question validation','Prompt Guard','Harmful content'])assert.ok(attribution.text.includes(label));
assert.match(attribution.text,/first blocking layer/);assert.match(attribution.text,/must not be added/);assert.match(attribution.text,/Rewrite refusal/);

const guards=render(report,'prompt-guard');
for(const model of report.promptGuard){assert.ok(guards.text.includes(model.variant.toUpperCase()));for(const value of [model.jailbreak,model.injection,model.safe])measured(guards.text,value);if(model.threshold!=null)assert.ok(guards.text.includes('Threshold '+new Intl.NumberFormat('en-AU',{maximumFractionDigits:3}).format(model.threshold)));if(model.latency?.medianMs!=null)assert.ok(guards.text.includes(new Intl.NumberFormat('en-AU',{maximumFractionDigits:2}).format(model.latency.medianMs)));}
assert.match(guards.text,/Jailbreak catch rate/);assert.match(guards.text,/Injection catch rate/);assert.match(guards.text,/not isolated injection recall/);
const provenance=render(report,'provenance');
for(const value of [report.sourceHash,report.reportSha256,report.runId,report.timestampAwst,String(report.seed)])assert.ok(provenance.text.includes(value));
assert.match(provenance.text,/AWST \(Perth\)/);assert.match(provenance.text,/Send the question, never the data\./);assert.match(provenance.text,/Live dispatch Disabled/);
assert.doesNotMatch(all.text,/\b(?:input|output|completion|reasoning)[ _-]?tokens?\b|MODEL_API_KEY|HF_TOKEN|OPENROUTER_API_KEY|GEMINI_API_KEY/i);

// Change fixture measurements without changing the component. The altered
// values must render, rather than any figures from the real frozen report.
const changed=structuredClone(report);
changed.setups[0].attacks=metric(5,12);changed.setups[0].safe=metric(1,9);changed.setups[0].applications.complete=metric(3,7);changed.setups[0].applications.fullCredit=metric(2,7);changed.setups[0].gate={status:'PENDING',checks:[],reasons:['Authored fixture; measured gate not supplied.']};
const mutation=render(changed,'headline').text;
for(const value of ['5/12','41.7%','1/9','11.1%','3/7','42.9%'])assert.ok(mutation.includes(value));

// Extra private fields are deliberately not part of the public render contract.
const polluted=structuredClone(report),privateSentinel='PRIVATE_UI_SENTINEL_DO_NOT_DISPLAY';
Object.assign(polluted,{prompt:privateSentinel,output:privateSentinel,requestPayload:privateSentinel,apiKey:privateSentinel,tokenUsage:{input:981273641},attackText:privateSentinel});
for(const setup of polluted.setups)Object.assign(setup,{prompt:privateSentinel,output:privateSentinel,rawQuestion:privateSentinel});
for(const row of polluted.promptGuard)Object.assign(row,{output:privateSentinel,prompt:privateSentinel,tokens:981273641});
const pollutedView=render(polluted);assert.doesNotMatch(pollutedView.html,/PRIVATE_UI_SENTINEL_DO_NOT_DISPLAY|981273641/);assert.equal(pollutedView.text,all.text);

const missing=structuredClone(report);missing.setups[0].pii.frozen=null;missing.setups[0].usable.frozen=null;missing.setups[0].applications.complete=null;missing.setups[0].applications.fullCredit=null;missing.promptGuard=[];missing.progress=missing.progress.map(row=>({...row,runId:null,setups:[]}));
assert.match(render(missing,'headline').text,/Pending/);assert.match(render(missing,'prompt-guard').text,/Standalone Prompt Guard measurements are pending/);assert.match(render(missing,'progress').text,/Pending/);
for(const change of [{cloudCalls:1},{spendUsd:1},{liveDispatchEnabled:true},{schemaVersion:2},{kind:'unverified-private-report'}]){
  const invalid=render({...report,...change});assert.match(invalid.text,/Results need verification/);assert.doesNotMatch(invalid.html,/data-export-panel=/);assert.doesNotMatch(invalid.text,/\d+\/\d+|\d+(?:\.\d+)?%/);
}
const invalidMetric=structuredClone(report);invalidMetric.setups[0].safe.rate=.1234567;assert.match(render(invalidMetric).text,/Results need verification/);

const example=await privacyExampleHtml(polluted,{render:component});
assert.doesNotMatch(example,/<script\b|<link\b|<iframe\b|<form\b|PRIVATE_UI_SENTINEL_DO_NOT_DISPLAY|981273641/i);
assert.match(example,/default-src &#x27;none&#x27;|default-src 'none'/);assert.ok(visible(example).includes(all.text),'The static example must contain the same visible component content.');
for(const panel of PRIVACY_PANELS)assert.equal((example.match(new RegExp(`data-export-panel="${panel}"`,'g'))??[]).length,1);
assert.ok(visible(example).includes(report.sourceHash));

console.log(JSON.stringify({check:'privacy-results-ui-semantic-rendering',passed:true,renderCases:cases,runId:report.runId,stage:report.stage,coverage:['same component for live and static examples','all four setup rows','counts and Wilson intervals','complete versus full-credit applications','zero-useful-candidate warning','three-stage distinct history','exclusive first and overlapping attribution','Prompt Guard jailbreak versus injection','Perth measurement time and source hashes','nonhardcoded fixture mutation','private fields and usage values absent','missing measurements pending','invalid offline identity hidden','self-contained script-free static example'],modelCalls:0,cloudCalls:0,browserCalls:0}));
