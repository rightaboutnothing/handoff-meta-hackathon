import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { readComparisonResults } from '../server/comparison-results.mjs';
import { readGatewayResults } from '../../src/evaluation/publish-results.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const bundle = await build({ stdin: { contents: `
import React from 'react'; import {renderToStaticMarkup} from 'react-dom/server';
import {GatewayBenchmarks} from './src/components/GatewayBenchmarks';
import {GatewaySavings} from './src/components/GatewaySavings';
export const render=(view,data,comparison)=>renderToStaticMarkup(React.createElement(view==='benchmarks'?GatewayBenchmarks:GatewaySavings,{data,comparison}));
`, resolveDir:root, sourcefile:'comparison-check.tsx', loader:'tsx' }, absWorkingDir:root, bundle:true, write:false, platform:'node', format:'cjs', jsx:'automatic', loader:{'.css':'empty'}, logLevel:'silent', define:{'process.env.NODE_ENV':'"production"'} });
const compiled={exports:{}};
new Function('module','exports','require',bundle.outputFiles[0].text)(compiled,compiled.exports,require);
const text=html=>html.replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ');
const measure=(estimate,n=17)=>({estimate,ci95:estimate==null?null:[estimate*.8,estimate],n,coverage:1});
const pipeline={id:'fixture-llama',name:'Finkd fixture',kind:'hybrid',localModelId:'llama3.1:8b',parametersB:8,guardModelId:'llama-guard3:8b',cloudId:'musespark',cloudName:'Muse Spark',hero:true,status:'INCOMPLETE',metrics:{accuracy:measure(null),localAnswerRate:measure(.73),handoffRate:measure(.27),medianLatencyMs:measure(2345),p95LatencyMs:measure(4567),tokensSent:measure(0),actualCloudSpendUsd:measure(0)},byCategory:{reasoning:{metrics:{accuracy:measure(null)}}}};
const report={schemaVersion:1,runId:'fixture-comparison',tier:0,status:'TIER0_COMPLETE',cloudCalls:0,categories:['reasoning'],pipelines:[pipeline,{...pipeline,id:'fixture-local',name:'Local control fixture',kind:'local-only',hero:false,metrics:{accuracy:measure(.61),medianLatencyMs:measure(1234)}}],costPlan:[{pipelineId:pipeline.id,name:pipeline.name,sampleItems:17,plannedHandoffs:5,estimatedInputTokens:3456,estimatedAllCloudInputTokens:7654,expectedInputTokensPer1000:3456,expectedAllCloudInputTokensPer1000:7654,estimatedOutputTokens:1234,estimatedReasoningTokens:200,costPer1000Usd:.4321,cloudOnlyCostPer1000Usd:1.2345,actualSpendUsd:0,assumptions:true,localAllocationIncluded:.0002}],calibration:[]};
const data=await readGatewayResults();
for(const view of ['benchmarks','savings']) {
  const pending=text(compiled.exports.render(view,null,null));
  assert.match(pending,/pending/i);
  assert.doesNotMatch(pending,/NaN|undefined|Infinity|\$\s*\d|\d+(?:\.\d+)?%/);
  const measured=text(compiled.exports.render(view,data,report));
  assert.doesNotMatch(measured,/NaN|undefined|Infinity/);
  assert.match(measured,/73\.0%/);
  assert.match(measured,/Tier 0/);
  assert.match(measured,/Muse Spark/);
}
const bench=compiled.exports.render('benchmarks',data,report);
assert.match(text(bench),/Historical \(retired\)/);
assert.ok(bench.indexOf('Grok')>bench.indexOf('Historical (retired)'), 'Grok model results appear only in the retired historical section');
assert.match(text(bench),/cloud has not answered/);
assert.match(text(compiled.exports.render('savings',data,report)),/\$0\.4321/);
assert.match(text(compiled.exports.render('savings',data,report)),/41,980/,'The monthly token projection uses the weighted per-1,000 inputs, not raw sample totals');
const winners={...report,tier:1,categoryWinners:{reasoning:{accuracy:{pipelineIds:['fixture-local'],estimate:.61,status:'measured'},cost:{pipelineIds:['fixture-local'],estimate:.4321,status:'measured'},latency:{pipelineIds:['fixture-local'],estimate:1234,status:'measured'},recommended:{pipelineId:'fixture-local'}}}};
assert.match(text(compiled.exports.render('benchmarks',data,winners)),/Measured category leaders/);
assert.match(text(compiled.exports.render('benchmarks',data,winners)),/Local control fixture/);

const actual=await readComparisonResults();
if(actual?.tier===0) {
  assert.equal(actual.pipelines.length,23);
  assert.equal(actual.cloudCalls,0);
  const cloudControls=actual.pipelines.filter(row=>row.kind==='cloud-only');
  assert.equal(cloudControls.length,2);
  assert.ok(cloudControls.every(row=>row.metrics.accuracy.estimate===null&&row.metrics.medianLatencyMs.estimate===null),'Uncalled cloud controls have pending quality and total latency');
  for(const view of ['benchmarks','savings'])assert.doesNotMatch(text(compiled.exports.render(view,data,actual)),/NaN|undefined|Infinity/);
  const hero=actual.pipelines.find(row=>row.hero),heroPlan=actual.costPlan.find(row=>row.pipelineId===hero.id);
  const actualSavings=text(compiled.exports.render('savings',data,actual));
  assert.ok(actualSavings.includes(`${(hero.metrics.localStageMedianLatencyMs.estimate/1000).toFixed(2)}s`),'Savings shows measured local stage time while cloud completion remains pending');
  assert.ok(actualSavings.includes(Math.round((heroPlan.expectedAllCloudInputTokensPer1000-heroPlan.expectedInputTokensPer1000)*10).toLocaleString('en-US')),'Actual weighted monthly token projection is displayed');
  const local=actual.pipelines.find(row=>row.kind==='local-only');
  const localSavings={...actual,pipelines:[{...local,hero:true},...actual.pipelines.filter(row=>row.kind==='cloud-only')]};
  assert.match(text(compiled.exports.render('savings',data,localSavings)),/All-cloud · Muse Spark/,'Local-only controls name their recorded cloud counterfactual');
}

const temp=await mkdtemp(path.join(os.tmpdir(),'handoff-comparison-check-'));
try {
  assert.equal(await readComparisonResults({resultsDir:temp}),null);
  await writeFile(path.join(temp,'comparison-latest.json'),JSON.stringify({directory:'../outside'}));
  await assert.rejects(readComparisonResults({resultsDir:temp}),/Invalid comparison/);
  const runDir=path.join(temp,'fixture-run'); await mkdir(runDir);
  const body=JSON.stringify({...report,prompt:'gated fixture question must stay private',pipelines:[{...pipeline,output_text:'private fixture answer',apiKey:'private fixture credential'}]});
  await writeFile(path.join(runDir,'report.json'),body);
  await writeFile(path.join(temp,'comparison-latest.json'),JSON.stringify({directory:'fixture-run',reportSha256:createHash('sha256').update(body).digest('hex')}));
  const publicReport=await readComparisonResults({resultsDir:temp});
  assert.equal(publicReport.pipelines[0].cloudName,'Muse Spark');
  assert.doesNotMatch(JSON.stringify(publicReport),/private fixture|gated fixture|apiKey|output_text/);
  await writeFile(path.join(temp,'comparison-latest.json'),JSON.stringify({directory:'fixture-run',sha256:'incorrect'}));
  await assert.rejects(readComparisonResults({resultsDir:temp}),/hash mismatch/);
} finally {
  // The exact temporary directory was returned by mkdtemp under the OS temp root.
  if(path.dirname(temp)===os.tmpdir()&&path.basename(temp).startsWith('handoff-comparison-check-'))await rm(temp,{recursive:true,force:true});
}
console.log(JSON.stringify({check:'comparison-dashboard',passed:true,checks:['pending measurements','recorded metric values','retired Grok isolation','assumed cost plan','confined report references','public aggregate sanitization','report hash integrity'],modelCalls:0}));
