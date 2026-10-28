import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {readStage4Results} from '../server/stage4-results.mjs';

const root=fileURLToPath(new URL('../',import.meta.url)),require=createRequire(import.meta.url);
const bundle=await build({stdin:{contents:`
import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';
import {Stage4Results} from './src/components/Stage4Results';
export const render=(report,tab='results',slice='company')=>renderToStaticMarkup(React.createElement(Stage4Results,{report,initialTab:tab,initialSlice:slice}));
`,resolveDir:root,sourcefile:'stage4-ui-check.tsx',loader:'tsx'},absWorkingDir:root,bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'}});
const compiled={exports:{}};new Function('module','exports','require',bundle.outputFiles[0].text)(compiled,compiled.exports,require);
const visible=html=>html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,'').replace(/<[^>]+>/g,' ').replace(/&amp;/g,'&').replace(/&#x27;/g,"'").replace(/&quot;/g,'"').replace(/\s+/g,' ').trim();
let cases=0;
const render=(report,tab='results',slice='company')=>{const output=visible(compiled.exports.render(report,tab,slice));assert.doesNotMatch(output.replaceAll('undefined accuracy','unestimable accuracy'),/\b(?:NaN|undefined|Infinity)\b/);cases++;return output;};
for(const tab of ['results','costs','privacy']){const pending=render(null,tab);assert.match(pending,/pending/i);assert.doesNotMatch(pending,/\$\s*\d|\d+(?:\.\d+)?%/);}

// Use the same bounded, hashed, sanitized loader as the local server. A field
// dropped by the publisher must not silently become a hardcoded UI metric.
const report=await readStage4Results();assert.ok(report,'Publish Stage 4 before checking measured dashboard rendering');
assert.equal(report.cloudCalls,0);assert.equal(report.modelCalls,0);assert.equal(report.spendUsd,0);
const recommended=report.recommendation.modelId,population=report.primaryPopulation;
const company=report.rows.find(row=>row.population===population&&row.modelId===recommended&&row.sliceId==='company');
const results=render(report);assert.ok(results.includes(`${(company.acceptanceRate*100).toFixed(1)}%`));assert.ok(results.includes(`${company.acceptedCorrect}/${company.accepted} full credit`));assert.match(results,/Wilson 95%:/);assert.match(results,/77\.2–100\.0%/);assert.match(results,/Separate AUDIT-only bound: 15\.8%/);assert.match(results,/Future questions remain uncertified/);
assert.match(render(report,'results','gpqa'),/Exploratory slice · 1 question per model/);assert.match(render(report,'results','gpqa'),/does not establish general performance on hard questions/);
assert.match(render(report,'results','company-multi'),/does not establish general performance on broader traffic for this workload/);
const other=render(report,'results','other');assert.match(other,/local-only questions stay on the machine/);
const costs=render(report,'costs');const fee=report.costs.find(row=>row.population===population&&row.modelId===recommended&&row.sliceId==='company'&&row.cloudId==='muse-spark');assert.ok(costs.includes(`$${fee.costPer1000.toFixed(4)}`));assert.ok(costs.includes(`$${fee.savingPer1000.toFixed(4)}`));assert.match(costs,/Muse Spark/);assert.match(costs,/25%/);assert.match(costs,/50%/);assert.match(costs,/75%/);assert.match(costs,/pre-Guard projections/);assert.match(costs,/Output length is projected/);
const privacy=render(report,'privacy'),boundary=report.privacy.find(row=>row.population===population&&row.modelId===recommended);
assert.match(privacy,new RegExp(`${boundary.businessDataQueries} queries contained business data`));assert.match(privacy,new RegExp(`Answered fully locally ${boundary.fullyLocalBusinessDataQueries}`));assert.match(privacy,new RegExp(`Proposed redacted handoffs ${boundary.proposedBusinessHandoffs}`));assert.match(privacy,/0 actual business-data transfers/);assert.match(privacy,/Guard-screened handoffs Pending/);assert.match(privacy,/16 company-document queries \+ 8 synthetic ad-export queries/);assert.match(privacy,/Question-only means no local draft/);assert.match(privacy,/did not run new outbound or inbound Guard screens/);

// Deliberately different fixture measurements prove the component reads JSON,
// including confidence intervals, latency, cloud-fee savings and privacy counts.
const changed=structuredClone(report);changed.recommendation.reason='Fixture recommendation from saved data.';changed.certification.finiteDevUpperRisk=.047;changed.certification.auditOnlyUpperRisk=.23;
Object.assign(changed.rows.find(row=>row.population===population&&row.modelId===recommended&&row.sliceId==='company'),{accepted:5,acceptedCorrect:4,acceptanceRate:.3125,acceptedAccuracy:.8,acceptedAccuracyWilson95:[.4,.9],escalations:11,escalationRate:.6875,medianLatencyMs:1234});
const customResults=render(changed);assert.match(customResults,/31\.3%/);assert.match(customResults,/80\.0%/);assert.match(customResults,/40\.0–90\.0%/);assert.match(customResults,/1\.23s/);assert.match(customResults,/4\.70%/);
Object.assign(changed.costs.find(row=>row.population===population&&row.modelId===recommended&&row.sliceId==='company'&&row.cloudId==='muse-spark'),{costPer1000:.1234,cloudOnlyPer1000:.9876,savingPer1000:.8642,savingRate:.8642/.9876});
const customCosts=render(changed,'costs');assert.match(customCosts,/\$0\.1234/);assert.match(customCosts,/\$0\.9876/);assert.match(customCosts,/\$0\.8642/);assert.match(customCosts,/87\.5%/);
Object.assign(changed.privacy.find(row=>row.population===population&&row.modelId===recommended),{businessDataQueries:18,companyQueries:11,adPrivacyQueries:7,fullyLocalBusinessDataQueries:4,proposedBusinessHandoffs:14,draftPayloads:2});
const customPrivacy=render(changed,'privacy');assert.match(customPrivacy,/18 queries contained business data/);assert.match(customPrivacy,/Answered fully locally 4/);assert.match(customPrivacy,/Proposed redacted handoffs 14/);assert.match(customPrivacy,/11 company-document queries \+ 7 synthetic ad-export queries/);assert.match(customPrivacy,/Proposed payloads containing a local draft 2/);assert.match(customPrivacy,/Inspect the proposed payload content/);
console.log(JSON.stringify({check:'stage4-ui-semantic-rendering',passed:true,renderCases:cases,runId:report.runId,coverage:['sanitized actual report','pending report','slice definitions','GPQA small-sample disclosure','Wilson interval','fee assumptions','business privacy denominator','Guard pending','nonhardcoded fixture metrics'],modelCalls:0,cloudCalls:0}));
