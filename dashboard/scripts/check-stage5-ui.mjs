import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {readStage4Results} from '../server/stage4-results.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const bundle=await build({stdin:{contents:`
import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {Stage5GuardResults} from './src/components/Stage5GuardResults';
import {Stage4Results} from './src/components/Stage4Results';
export const render=(report,routingEnabled)=>renderToStaticMarkup(React.createElement(Stage5GuardResults,{report,routingEnabled}));
export const renderParent=(report,stage5,routingEnabled)=>renderToStaticMarkup(React.createElement(Stage4Results,{report,stage5,routingEnabled,initialTab:'privacy'}));
`,resolveDir:root,sourcefile:'stage5-ui-check.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
const compiled={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(compiled,compiled.exports,require);
const visible=html=>html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
let cases=0;
const render=(report,routingEnabled)=>{const text=visible(compiled.exports.render(report,routingEnabled));assert.doesNotMatch(text,/\b(?:NaN|undefined|Infinity)\b/);cases++;return text;};
const renderParent=(report,stage5,routingEnabled)=>{const text=visible(compiled.exports.renderParent(report,stage5,routingEnabled));assert.doesNotMatch(text.replaceAll('undefined accuracy','unestimable accuracy'),/\b(?:NaN|undefined|Infinity)\b/);cases++;return text;};
const item=(id,change={})=>({id,suite:'company-rag',category:'company-data multi-doc',guardModelId:'llama-guard3:8b',verdict:'safe',safetyCategories:[],screened:true,wouldRelease:true,releaseStatus:'would_release',redactionsApplied:0,preexistingPlaceholderOccurrences:0,privateFieldsExcluded:0,latencyMs:42,...change});
const fixture={schemaVersion:1,kind:'stage5-guard-report',runId:'fixture-screen',timestamp:'2026-10-28T10:00:00Z',sourceRun:'fixture-frozen',sourceStage4Run:'fixture-slices',population:'frozen-saved60',localModelId:'gemma3:12b',guardModelId:'llama-guard3:8b',dryRun:true,cloudCalls:0,spendUsd:0,inboundStatus:'pending',routingFlagDefault:false,
  summary:{items:3,screened:2,released:1,wouldRelease:1,blocked:2,unsafe:1,errors:1,redactionsApplied:2,preexistingPlaceholderOccurrences:4,redactedItems:1,alreadyRedactedItems:1,privateFieldsExcluded:9,companyDocuments:2,adExports:1,actualCloudCalls:0,actualBusinessCloudCalls:0},
  items:[item('safe-fixture',{redactionsApplied:2,preexistingPlaceholderOccurrences:4,privateFieldsExcluded:9}),item('unsafe-fixture',{verdict:'unsafe',safetyCategories:['S1'],wouldRelease:false,releaseStatus:'blocked_local'}),item('unavailable-fixture',{verdict:'unavailable',screened:false,wouldRelease:false,releaseStatus:'blocked_local',error:'LOCAL_GUARD_UNAVAILABLE',latencyMs:null})],certification:{finiteDevUpperRisk:.042,auditOnlyUpperRisk:.23,scope:'Fixed accepted CALIB+AUDIT dev frame only.',futureCertified:false},notes:['Synthetic fixture.']};

for(const flag of [false,undefined]){const missing=render(null,flag);assert.match(missing,/screening is pending/);assert.doesNotMatch(missing,/\$\s*\d|\d+(?:\.\d+)?%|0 actual cloud calls/);assert.match(missing,flag===false?/routing Off/:/routing Pending/);}
const measured=render(fixture,false);
assert.match(measured,/Screened 2 \/ 3/);assert.match(measured,/Would release 1 Safe verdict · request still local/);assert.match(measured,/Blocked locally 2 1 unsafe · 1 errors or invalid results/);assert.match(measured,/New redactions 2/);
assert.match(measured,/Already-redacted placeholder occurrences 4/);assert.match(measured,/Private field groups excluded upstream 9/);assert.match(measured,/0 actual cloud calls/);assert.match(measured,/Actual cloud spend \$0\.00/);assert.match(measured,/Unsafe S1/);assert.match(measured,/4\.20% fixed-dev upper error bound/);assert.match(measured,/23\.0%/);assert.match(measured,/Future questions and unseen source families remain uncertified/);assert.match(measured,/Inbound Guard checks are pending/);assert.match(measured,/flag remains off/);assert.match(measured,/Safe · not sent/);
assert.doesNotMatch(measured,/Successfully sent|Delivered to cloud|Guard screening is pending/);
const on=render(fixture,true);assert.match(on,/routing On/);assert.match(on,/locked company route is enabled/);assert.match(on,/exact-payload Guard pass/);
for(const changed of [{cloudCalls:1},{spendUsd:1},{dryRun:false},{items:fixture.items.map(row=>row.id==='unsafe-fixture'?{...row,wouldRelease:true}:row)}]){const invalid=render({...fixture,...changed},false);assert.match(invalid,/report needs verification/);assert.doesNotMatch(invalid,/Screened 2|Would release 1/);}

// Scope measured screens to the selected saved cohort and local model. The
// historical privacy ledger must remain pending for all other populations.
const stage4=await readStage4Results();assert.ok(stage4,'Publish Stage 4 before checking the Stage 5 privacy integration');
const matchedFixture={...fixture,sourceRun:stage4.sourceRun,sourceStage4Run:stage4.runId,provenance:{policyHash:stage4.sourcePolicyHash},population:stage4.primaryPopulation,localModelId:stage4.recommendation.modelId};
const integrated=renderParent(stage4,matchedFixture,false);
assert.match(integrated,/Screened 2 \/ 3/);assert.match(integrated,/Guard-screened handoffs 2/);assert.match(integrated,/Local Guard screening is recorded/);assert.match(integrated,/2 proposals were screened locally: 1 would be released and 2 were blocked/);assert.match(integrated,/routing Off/);assert.match(integrated,/No request was sent/);
for(const mismatch of [{localModelId:'unmatched-local-model'},{population:'unmatched-saved-cohort'},{sourceRun:'stale-calibration-run'},{sourceStage4Run:'stale-stage4-run'},{provenance:{policyHash:'stale-locked-policy'}}]){
  const unmatched=renderParent(stage4,{...matchedFixture,...mismatch},false);
  assert.match(unmatched,/screening is pending/);assert.match(unmatched,/Guard-screened handoffs Pending/);assert.match(unmatched,/Live boundary verification is pending/);assert.match(unmatched,/Stage 5 screening covers the frozen saved60 Gemma 12B proposals only/);
  assert.doesNotMatch(unmatched,/safe-fixture|Screened 2 \/ 3|Local Guard screening is recorded/);
}
const parentPending=renderParent(stage4,null,false);assert.match(parentPending,/screening is pending/);assert.match(parentPending,/Guard-screened handoffs Pending/);assert.doesNotMatch(parentPending,/safe-fixture|Local Guard screening is recorded/);

// Prefer the production bounded/hash-checked loader once Stage 5 is published.
// Fixture checks above remain independent of private logs and model availability.
let actual=null;
try{const {readStage5Results}=await import('../server/stage5-results.mjs');actual=await readStage5Results();}catch(error){if(error.code!=='ERR_MODULE_NOT_FOUND')throw error;}
if(actual){
  const text=render(actual,false);assert.equal(actual.cloudCalls,0);assert.equal(actual.spendUsd,0);assert.equal(actual.dryRun,true);
  assert.match(text,new RegExp(`Screened ${actual.summary.screened} \\/ ${actual.summary.items}`));
  assert.match(text,new RegExp(`Would release ${actual.summary.released}`));assert.match(text,new RegExp(`Blocked locally ${actual.summary.blocked}`));
  assert.ok(actual.items.every(row=>text.includes(row.id)));assert.ok(actual.items.every(row=>!row.wouldRelease||row.verdict==='safe'));
  assert.match(text,/3\.66%/);assert.match(text,/fixed-dev/);assert.match(text,/no cloud delivery/);
  const integratedActual=renderParent(stage4,actual,false);
  assert.match(integratedActual,/Local Guard screening is recorded/);assert.ok(actual.items.every(row=>integratedActual.includes(row.id)));
  assert.match(integratedActual,new RegExp(`Guard-screened handoffs ${actual.summary.screened}`));
}
console.log(JSON.stringify({check:'stage5-ui-semantic-rendering',passed:true,renderCases:cases,runId:actual?.runId??'fixture-only; measured report pending',coverage:['pending report','real flag off/on/unknown','safe versus unsafe and error','new versus earlier redaction','would release versus actual delivery','finite-dev scope','nonhardcoded fixture metrics','parent matched cohort and model','mismatched cohort and model stay pending','stale source and policy stay pending','parent missing report stays pending',...(actual?['sanitized actual report','parent actual report']:[])],modelCalls:0,cloudCalls:0}));
