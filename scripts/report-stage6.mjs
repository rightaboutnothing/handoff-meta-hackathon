import {readFile,writeFile} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from '../src/rag/receipts.mjs';
import {renderStage6Summary} from '../src/evaluation/stage6-stress.mjs';

// Post-measurement reporting only: the measured JSON and its pointer stay intact.
const pointer=JSON.parse(await readFile('results/stage6-latest.json','utf8'));
if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(pointer.directory??''))throw Error('Invalid Stage 6 report directory');
const folder=path.join('results',pointer.directory),body=await readFile(path.join(folder,'report.json'),'utf8');
if(sha256(body)!==pointer.reportSha256)throw Error('Stage 6 report hash mismatch');
const report=JSON.parse(body),ready=report.readiness;
if(report.kind!=='stage6-guard-stress-report'||report.cloudCalls!==0||report.spendUsd!==0||!ready)throw Error('An offline measured report and prepared requests are required');
const pii=report.metrics.find(row=>row.id==='pii-approved-leaks'),redaction=report.metrics.find(row=>row.id==='pii-redaction-survivors');
const names=report.metrics.find(row=>row.id==='pii-type-name');
const allSurvivingTypes=report.piiByType.filter(row=>row.n>0&&row.events===row.n).map(row=>row.label).join(', ');
const privacyStatus=pii.events>0?'FAIL in this sample':'Not certified by this sample';
const usd=value=>'$'+value.toFixed(6),count=value=>value.toLocaleString('en-US');
let assessment=`## Interpretation and live-path readiness\n\n**General private-data release readiness: ${privacyStatus}.** ${pii.events}/${pii.n} PII queries retained planted values after redaction and received a safe Guard verdict; ${redaction.events}/${redaction.n} candidates retained at least one value before the Guard decision. These candidates were structurally local-only and none was sent. Types surviving in every candidate: ${allSurvivingTypes||'none'}. Name survivors: ${names.events}/${names.n}.\n\nA safe verdict is not a privacy certificate or proof that retrieved instructions are trustworthy. The controls below pass their prepare-only/mocked checks; they do not establish safe release of arbitrary company data. Stage 3's 3.66% certificate still covers its fixed accepted dev frame only.\n\n| Live-path control | Result | Scope |\n|---|---|---|\n${ready.checks.map(check=>`| ${check.label} | ${check.pass===true?'PASS':check.pass===false?'FAIL':'PENDING'} | ${check.detail??''} |`).join('\n')}\n\nThe kill switch is on, routing flag off, Meta configuration paused, and cloud budget unset. The eleven-item batch exceeds default caps. These defaults are unchanged.\n\n### Eleven-item fee estimate, including reasoning\n\n| Quantity | Projection / reservation |\n|---|---:|\n| Input tokens (documented local proxy) | ${count(ready.tokens.input)} |\n| Visible output tokens (assumed) | ${count(ready.tokens.visibleOutput)} |\n| Reasoning tokens (assumed) | ${count(ready.tokens.reasoning)} |\n| Total projected tokens | ${count(ready.tokens.total)} |\n| Projected fee | ${usd(ready.projectedCostUsd)} |\n| Conservative reservation tokens | ${count(ready.requiredCaps.tokens)} |\n| Conservative reservation fee | ${usd(ready.reservedUpperUsd)} |\n| Required call cap | ${ready.requiredCaps.calls} |\n| Default caps | ${ready.defaultCaps.calls} call / ${count(ready.defaultCaps.tokens)} tokens / ${usd(ready.defaultCaps.costUsd)} |\n\n${ready.assumptions.map(note=>'- '+note).join('\n')}\n\nThe ${ready.maxCompletionTokens}-token total completion cap is serialized as Responses \`max_output_tokens\`; Chat Completions calls this \`max_completion_tokens\`. Reasoning is included in completion usage and charged once, as documented in [Meta's Responses quickstart](https://dev.meta.ai/docs/quickstart#read-the-response). No cloud response quality or live billing was measured.\n`;
await writeFile(path.join(folder,'summary.md'),renderStage6Summary(report)+'\n'+assessment);
console.log(JSON.stringify({runId:report.runId,summaryWritten:true,measuredJsonUnchanged:true,cloudCalls:0}));
