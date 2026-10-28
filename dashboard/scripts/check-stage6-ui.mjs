import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {readStage6Results} from '../server/stage6-results.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const bundle=await build({stdin:{contents:`
import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {Stage6GuardStressResults} from './src/components/Stage6GuardStressResults';
export const render=(report,routingEnabled)=>renderToStaticMarkup(React.createElement(Stage6GuardStressResults,{report,routingEnabled}));
`,resolveDir:root,sourcefile:'stage6-ui-check.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
const compiled={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(compiled,compiled.exports,require);
const visible=html=>html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
let cases=0;
const render=(report,flag)=>{const text=visible(compiled.exports.render(report,flag));assert.doesNotMatch(text,/\b(?:NaN|undefined|Infinity)\b/);cases++;return text;};
const row=(id,area,n,events,wilson95,label=id)=>({id,label,area,n,events,rate:n?events/n:null,wilson95,errors:0,definition:`Fixture ${area} measurement.`});
const fixture={schemaVersion:1,kind:'stage6-guard-stress-report',runId:'fixture-stress',timestamp:'2026-10-28T12:00:00Z',tier:0,cloudCalls:0,modelAnswerCalls:0,spendUsd:0,guardModelId:'llama-guard3:8b',metrics:[
  row('attacks','attacks',20,18,[.699,.972],'Attack benchmark blocking'),row('safe','safe',74,3,[.014,.113],'Safe false blocks'),row('pii','pii',50,8,[.083,.285],'PII query leaks'),row('evasion','evasion',30,12,[.246,.577],'Evasion blocking'),row('japanese','evasion',5,1,[.036,.624],'Japanese trick'),row('inbound','inbound',18,2,[.031,.328],'Unsafe local outputs')],
  categoryBreakdown:[row('reference-s1','attacks',10,9,[.596,.982],'S1 reference category')],
  failuresByArea:{attacks:[{id:'attack-failed-fixture',category:'S1',hash:'a'.repeat(64),prompt:'PRIVATE_SENTINEL'}],safe:[{id:'safe-block-fixture',category:'benign',output:'PRIVATE_SENTINEL'}]},
  readiness:{kind:'stage6-live-readiness',preparedItems:11,cloudCalls:0,spendUsd:0,projectedCostUsd:.01567,reservedUpperUsd:.04789,tokens:{input:101,visibleOutput:202,reasoning:303,total:606},defaultKillSwitch:true,defaultCaps:{calls:1,tokens:1000,costUsd:.001},requiredCaps:{calls:11,tokens:12000,costUsd:.05},runFitsDefaultCaps:false,maxCompletionTokens:768,checks:[{id:'permit',label:'Fresh Guard pass required',pass:true,detail:'Payload bytes are bound to a single release.'},{id:'caps',label:'Run fits the default cap',pass:false,detail:'An operator must explicitly budget the batch.'},{id:'probe',label:'Real Responses inference',pass:null,detail:'Deferred; no cloud request.'}],assumptions:['Prices and output/reasoning lengths are planning assumptions.']},
  sources:[{id:'fixture-source',name:'Fixture benchmark',licence:'MIT',url:'https://example.invalid/licence'}],limitations:['Correlated variants limit generalization.'],notes:['No prompt text is published.']};

for(const flag of [false,true,undefined]){const text=render(null,flag);assert.match(text,/stress test is pending/);assert.match(text,flag===false?/routing Off/:flag===true?/routing On/:/routing Pending/);assert.doesNotMatch(text,/(?:\d+\.\d+%|\$0|Actual cloud requests 0)/);}
const measured=render(fixture,false);
for(const expected of [/Attacks blocked 90\.0%/,/Safe queries wrongly blocked 4\.1%/,/Guard-safe queries retaining PII 16\.0%/,/18 \/ 20/,/69\.9%–97\.2%/,/3 \/ 74/,/8 \/ 50/,/Japanese trick/,/1 \/ 5/,/2 \/ 18/,/0\.01567/,/0\.04789/,/Projected reasoning tokens 303/,/Pass Fresh Guard pass required/,/Fail Run fits the default cap/,/Pending Real Responses inference/,/Actual cloud requests 0/,/Actual cloud spend \$0\.00/,/routing Off/,/fixed accepted dev frame only/,/not certify future company traffic/,/attack-failed-fixture S1/,/safe-block-fixture benign/])assert.match(measured,expected);
assert.doesNotMatch(measured,/PRIVATE_SENTINEL|Successfully sent|Delivered to cloud/);
assert.match(measured,/Default run cap 1 calls · 1,000 total tokens · \$0\.0010/);assert.match(measured,/11 calls · 12,000 total tokens · \$0\.0500/);assert.match(measured,/Completion cap · includes reasoning 768 tokens/);assert.match(measured,/Kill switch by default On/);assert.match(measured,/batch exceeds the default run limits/);
assert.match(measured,/Privacy readiness · failed in this sample/);assert.match(measured,/8 \/ 50 Guard-safe candidates retained planted PII/);assert.match(measured,/Passing the control checks below does not establish safe release of arbitrary company data/);
const noLeaks=structuredClone(fixture);Object.assign(noLeaks.metrics.find(row=>row.area==='pii'),{events:0,rate:0,wilson95:[0,.071]});const cleanSample=render(noLeaks,false);assert.doesNotMatch(cleanSample,/Privacy readiness · failed|Guard-safe candidates retained planted PII\./);assert.match(cleanSample,/No Guard-safe candidates retained planted PII in this sample/);assert.match(cleanSample,/does not establish universal privacy/);
assert.match(render(fixture,true),/routing On/);
const pending=structuredClone(fixture);pending.metrics=[row('attacks','attacks',0,0,null,'Attack benchmark blocking')];pending.categoryBreakdown=[];pending.readiness=null;pending.failuresByArea={};
const pendingText=render(pending);assert.match(pendingText,/Attacks blocked Pending/);assert.match(pendingText,/0 \/ 0 Pending 0/);assert.match(pendingText,/parser checks are pending/);assert.doesNotMatch(pendingText,/Projected cloud fee \$/);
assert.match(pendingText,/Privacy readiness remains pending/);assert.doesNotMatch(pendingText,/Privacy readiness · failed/);
for(const changes of [{cloudCalls:1},{modelAnswerCalls:1},{spendUsd:1},{tier:1},{kind:'raw-attack-text'}]){const text=render({...fixture,...changes},false);assert.match(text,/Stress results need verification/);assert.doesNotMatch(text,/90\.0%|attack-failed-fixture/);}
const many=structuredClone(fixture);many.failuresByArea.pii=Array.from({length:9},(_,index)=>({id:`pii-failure-${index}`,category:'address'}));const limited=render(many,false);assert.match(limited,/pii-failure-4/);assert.doesNotMatch(limited,/pii-failure-[5-8]/);
const changed=structuredClone(fixture);Object.assign(changed.metrics[0],{n:8,events:5,rate:.625,wilson95:[.31,.86],errors:2});changed.readiness.projectedCostUsd=.12345;changed.readiness.tokens.reasoning=876;
const custom=render(changed,false);assert.match(custom,/Attacks blocked 62\.5%/);assert.match(custom,/5 \/ 8 31\.0%–86\.0% 2/);assert.match(custom,/\$0\.12345/);assert.match(custom,/Projected reasoning tokens 876/);

const actual=await readStage6Results();
if(actual){
  const text=render(actual,false);assert.equal(actual.cloudCalls,0);assert.equal(actual.spendUsd,0);assert.equal(actual.tier,0);
  for(const metric of actual.metrics){assert.ok(text.includes(metric.label));assert.ok(text.includes(`${metric.events} / ${metric.n}`));if(metric.rate!=null)assert.ok(text.includes(`${(metric.rate*100).toFixed(1)}%`));}
  for(const rows of Object.values(actual.failuresByArea))assert.ok(rows.slice(0,5).every(row=>text.includes(row.id)));
  if(actual.readiness){assert.match(text,/Prepared items/);assert.ok(actual.readiness.checks.every(check=>text.includes(check.label)));}
  const privacy=actual.metrics.find(row=>row.area==='pii');if(privacy?.events>0){assert.match(text,/Privacy readiness · failed in this sample/);assert.ok(text.includes(`${privacy.events} / ${privacy.n} Guard-safe candidates retained planted PII`));}
}
console.log(JSON.stringify({check:'stage6-ui-semantic-rendering',passed:true,renderCases:cases,runId:actual?.runId??'fixture-only; measured report pending',coverage:['pending report and flags','nonhardcoded metric counts and Wilson intervals','measured errors','failure identities only and capped at five','reasoning-inclusive cost assumptions','readiness pass fail pending','privacy failure alert and no-leak/pending states','finite-dev scope','offline-only report validation',...(actual?['sanitized actual report']:[])],modelCalls:0,cloudCalls:0}));
