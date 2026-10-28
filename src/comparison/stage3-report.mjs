import {bootstrapEstimate,wilsonInterval,mean} from './metrics.mjs';

const finite=value=>typeof value==='number'&&Number.isFinite(value);
const full=value=>finite(value)&&value>=1;
const inferredSlice=category=>/^company-data(?:[ -])/.test(String(category))?'company':'general';
const measuredScore=row=>!row.error&&row.scoring?.labelAvailable!==false&&finite(row.scoring?.score)?row.scoring.score:null;
const gateValue=gate=>{for(const key of ['eligible','passed','pass','allowed'])if(typeof gate?.[key]==='boolean')return gate[key];return null;};
const beforeValue=row=>typeof row.beforeAccepted==='boolean'?row.beforeAccepted:typeof row.previousAccepted==='boolean'?row.previousAccepted:null;
const ratio=(rows,predicate)=>rows.length?rows.filter(predicate).length/rows.length:null;

function checkedRows(input){
  if(!Array.isArray(input))throw new Error('Acceptance records must be an array');const seen=new Set(),devIds=new Map();
  return input.map(row=>{
    const modelId=row.modelId??row.localModelId,population=row.population;
    if(typeof row.id!=='string'||!row.id||typeof modelId!=='string'||!modelId||typeof population!=='string'||!population||typeof row.safe!=='boolean'||typeof row.accepted!=='boolean')throw new Error('Acceptance rows require explicit population, model/item identity and safe/accepted booleans');
    const slice=row.slice??inferredSlice(row.category);if(!['company','general'].includes(slice)||row.category!=null&&slice!==inferredSlice(row.category))throw new Error('Acceptance slice must match company/general task category');
    const identity=JSON.stringify([population,modelId,row.id]);if(seen.has(identity))throw new Error('Duplicate population/model/item acceptance result');seen.add(identity);
    if(row.safe&&row.accepted&&gateValue(row.gate)===false)throw new Error('A failed hard gate cannot be reported as a local acceptance');
    const score=measuredScore(row);if(score!=null&&(score<0||score>1))throw new Error('Rubric scores must lie within 0–1');
    if(population.startsWith('dev-')){const key=JSON.stringify([modelId,row.id]);if(devIds.has(key)&&devIds.get(key)!==population)throw new Error('Dev roles may not overlap item IDs');devIds.set(key,population);}
    return{...row,modelId,population,slice,groupId:row.groupId??row.id};
  });
}
function summarizeRows(rows,options){
  const safe=rows.filter(row=>row.safe),accepted=safe.filter(row=>row.accepted),supported=accepted.filter(row=>measuredScore(row)!=null),correct=accepted.filter(row=>full(measuredScore(row)));
  const unknown=accepted.filter(row=>measuredScore(row)==null),knownWrong=supported.length-correct.length;
  const measurement=(selected,predicate)=>bootstrapEstimate(selected,sample=>ratio(sample,predicate),options);
  const acceptedAccuracy=measurement(accepted,row=>full(measuredScore(row))),acceptedError=measurement(accepted,row=>!full(measuredScore(row)));
  const before=rows.filter(row=>beforeValue(row)!==null),beforeSafe=before.filter(row=>row.safe),beforeAccepted=beforeSafe.filter(row=>beforeValue(row));
  const gateReasons={};for(const row of safe){if(gateValue(row.gate)!==false)continue;const reasons=Array.isArray(row.gate?.reasons)?row.gate.reasons:[row.gate?.reason??'hard_gate_failed'];for(const value of reasons){const key=typeof value==='string'&&/^[A-Za-z0-9_:.-]{1,100}$/.test(value)?value:'other_code_gate';gateReasons[key]=(gateReasons[key]??0)+1;}}
  return{items:rows.length,safeItems:safe.length,adversarialLocalOnlyItems:rows.length-safe.length,unsafeMarkedAccepted:rows.filter(row=>!row.safe&&row.accepted).length,
    accepted:accepted.length,acceptedCorrect:correct.length,acceptedKnownWrong:knownWrong,acceptedUnknown:unknown.length,acceptedConservativeWrong:knownWrong+unknown.length,
    labelled:rows.filter(row=>measuredScore(row)!=null).length,unknownLabels:rows.filter(row=>measuredScore(row)==null).length,errors:rows.filter(row=>row.error).length,
    acceptanceRateAllQueries:measurement(rows,row=>row.safe&&row.accepted),acceptanceRateSafeQueries:measurement(safe,row=>row.accepted),
    acceptedAccuracy,acceptedAnswerAccuracy:acceptedAccuracy.estimate,acceptedAccuracySupportedOnly:measurement(supported,row=>full(measuredScore(row))),
    acceptedErrorRate:accepted.length?(knownWrong+unknown.length)/accepted.length:null,acceptedErrorRateBootstrap:acceptedError,
    acceptedErrorUpper95Descriptive:acceptedError.ci95?.[1]??null,acceptedAccuracyWilson95IidSensitivity:wilsonInterval(correct.length,accepted.length),
    uncertaintyScope:'Source-group bootstrap is descriptive; it can be degenerate for zero observed errors and is not the calibration risk certificate. Wilson intervals assume IID accepted items and are sensitivity only.',
    projectedCloudCallsSkipped:accepted.length,projectedCloudCalls:safe.length-accepted.length,
    projectedCloudCallsSkippedPer1000:{...bootstrapEstimate(rows,sample=>sample.length?1000*ratio(sample,row=>row.safe&&row.accepted):null,options),unit:'calls skipped per 1,000 all queries'},
    gateMeasured:safe.filter(row=>gateValue(row.gate)!==null).length,hardGateRejected:safe.filter(row=>gateValue(row.gate)===false).length,hardGateReasons:gateReasons,
    before:{measuredItems:before.length,safeItems:beforeSafe.length,accepted:beforeAccepted.length,acceptanceRateAllQueries:measurement(before,row=>row.safe&&beforeValue(row)),acceptanceRateSafeQueries:measurement(beforeSafe,row=>beforeValue(row)),
      acceptanceRateChange:bootstrapEstimate(before,sample=>mean(sample.map(row=>Number(row.safe&&row.accepted)-Number(row.safe&&beforeValue(row)))),options)},
    actualCloudCalls:0,actualCloudSpendUsd:0};
}

/** Reporting only: role/model/population isolation is explicit; no threshold is
 * fitted or selected here. Unknown accepted labels count as conservative error. */
export function summarizeStage3Acceptance(inputRows,{seed=20261027,replicates=2000}={}){
  const input=checkedRows(inputRows),options={seed,replicates},rows=[];
  const populations=[...new Set(input.map(row=>row.population))],modelIds=[...new Set(input.map(row=>row.modelId))];
  for(const population of populations)for(const modelId of modelIds)for(const slice of ['company','general','overall']){
    const selected=input.filter(row=>row.population===population&&row.modelId===modelId&&(slice==='overall'||row.slice===slice));if(!selected.length)continue;
    rows.push({population,modelId,slice,...summarizeRows(selected,options)});
  }
  const devCoverage=modelIds.map(modelId=>{const selected=input.filter(row=>row.modelId===modelId&&row.population.startsWith('dev-'));return{modelId,items:selected.length,uniqueItems:new Set(selected.map(row=>row.id)).size,
    roles:Object.fromEntries([...new Set(selected.map(row=>row.role??row.population.slice(4)))].map(role=>[role,selected.filter(row=>(row.role??row.population.slice(4))===role).length]))};});
  return{schemaVersion:1,rows,devCoverage,populations,modelIds,slices:['company','general','overall'],seed,replicates,
    errorDefinition:'Any supported rubric score below full credit is wrong. Accepted unknown/unsupported labels or execution errors count conservatively as wrong; the supported-only sensitivity is separate.',
    intervalMethod:'Seeded source-group bootstrap percentile 95%, descriptive only; Wilson IID intervals are sensitivity, not certification',
    riskCertificateComputedHere:false,modelsPooled:false,populationsPooled:false,cloudCalls:0,spendUsd:0};
}

const escaped=value=>String(value??'pending').replaceAll('|','\\|').replace(/[\r\n]+/g,' ');
const percent=value=>finite(value)?`${(value*100).toFixed(1)}%`:'pending';
const num=value=>finite(value)?String(value):'pending';
const money=value=>finite(value)?`$${value.toFixed(4)}`:'pending';
const fixed=value=>finite(value)?value.toFixed(6):'pending';
function accuracy(metric){if(metric?.estimate==null)return'pending';return`${percent(metric.estimate)}${metric.ci95?` [${metric.ci95.map(percent).join(', ')}]`:' [CI unavailable]'}`;}
function acceptanceTable(rows){return['| Model | Slice | Accepted / safe / all | All-query acceptance (95% CI) | Accepted correct / unknown | Conservative accepted accuracy (95% CI) | Cloud calls skipped |',
  '|---|---|---:|---:|---:|---:|---:|',...rows.map(row=>`| ${escaped(row.modelId)} | ${escaped(row.slice)} | ${row.accepted} / ${row.safeItems} / ${row.items} | ${accuracy(row.acceptanceRateAllQueries)} | ${row.acceptedCorrect} / ${row.acceptedUnknown} | ${accuracy(row.acceptedAccuracy)} | ${row.projectedCloudCallsSkipped} |`)].join('\n');}
function costTable(rows){return['| Model | Slice | Cloud | Skipped safe calls | Counted cloud input / all query | Total projected tokens / all query | Cloud fees / 1,000 all queries | Matched cloud-only / 1,000 | Saving (95% CI) |',
  '|---|---|---|---:|---:|---:|---:|---:|---:|',...rows.map(row=>`| ${escaped(row.modelId??row.localModelId)} | ${escaped(row.slice)} | ${escaped(row.cloudId)} | ${num(row.cloudCallsSkipped)} | ${finite(row.cloudInputTokensPerQuery)?row.cloudInputTokensPerQuery.toFixed(2):'pending'} | ${finite(row.cloudTotalTokensPerQuery)?row.cloudTotalTokensPerQuery.toFixed(2):'pending'} | ${money(row.costPer1000AllQueriesUsd)} | ${money(row.cloudOnlyCostPer1000AllQueriesUsd)} | ${accuracy(row.allQueries?.savingRate)} |`)].join('\n');}
function certificatesOf(calibration){const rows=[];for(const[modelId,model]of Object.entries(calibration?.models??{}))for(const[slice,data]of Object.entries(model.slices??{}))rows.push({modelId,slice,data});return rows;}

export function renderStage3Summary(report){
  if(!(report.tier===0||report.tier0===true)||report.cloudCalls!==0||(report.spendUsd??report.actualSpendUsd)!==0||report.network?.externalRequests!==0)throw new Error('Stage 3 report requires recorded zero cloud/external requests and spend');
  const acceptance=report.acceptance?.rows??[],costs=report.costs?.summary??[],certificates=certificatesOf(report.calibration);
  const frozen=acceptance.some(row=>row.population.startsWith('frozen-'));if(frozen&&(report.testReplayLocked!==true||typeof report.policyHash!=='string'||!report.policyHash))throw new Error('Frozen test replay requires a locked policy hash before evaluation');
  if(costs.some(row=>(row.actualCloudCalls??0)!==0||(row.actualCloudSpendUsd??0)!==0))throw new Error('A Stage 3 cost projection cannot report actual cloud spend');
  const budget=report.settings?.errorBudget??report.calibration?.errorBudget??certificates[0]?.data.errorBudget;
  const certificateTable=['| Model | Slice | Candidate / operational threshold | Calib accepted / finite accepted frame | Conservative calib errors | Upper finite-frame risk bound | Upper audit-only risk bound | Status |',
    '|---|---|---:|---:|---:|---:|---:|---|',...certificates.map(({modelId,slice,data})=>`| ${escaped(modelId)} | ${escaped(slice)} | ${fixed(data.candidateThreshold)} / ${fixed(data.threshold)} | ${num(data.certificate?.sampled)} / ${num(data.certificate?.population)} | ${num(data.certificate?.wrong)} | ${percent(data.certificate?.upperRisk)} | ${percent(data.certificate?.unsampled?.upperRisk)} | ${escaped(data.status)} |`)];
  const allocations=['| Model | Generated dev items | Unique dev IDs | Recorded role counts |','|---|---:|---:|---|',...(report.acceptance?.devCoverage??[]).map(row=>`| ${escaped(row.modelId)} | ${row.items} | ${row.uniqueItems} | ${Object.entries(row.roles).map(([role,count])=>`${escaped(role)}=${count}`).join('; ')} |`)];
  const populations=[...new Set(acceptance.map(row=>row.population))],primary=populations.filter(p=>p==='dev-audit'||p==='frozen-saved60'),other=populations.filter(p=>!primary.includes(p));
  const populationSection=population=>{const rows=acceptance.filter(row=>row.population===population),plans=costs.filter(row=>row.population===population);const before=rows.filter(row=>row.before?.measuredItems>0);return`### ${escaped(population)}\n\n${acceptanceTable(rows)}\n\n${before.length?`Frozen previous policy acceptance → new acceptance (all-query): ${before.map(row=>`${escaped(row.modelId)} / ${escaped(row.slice)} ${percent(row.before.acceptanceRateAllQueries?.estimate)} → ${percent(row.acceptanceRateAllQueries?.estimate)}`).join('; ')}.\n\n`:''}${plans.length?costTable(plans):'Cost projection pending for this population.'}\n`;};
  const riskScopes=[...new Set(certificates.map(row=>row.data.certificate?.scope).filter(Boolean))];
  return`# Stage 3: dev-only local acceptance calibration\n\nRun ${escaped(report.runId)}. **Tier 0: zero cloud calls, zero external requests, $0 cloud spend.** Policy hash: ${escaped(report.policyHash)}. Generation/partition seed: ${escaped(report.settings?.seed??report.acceptance?.seed)}.\n\n## Dev allocation and error-budget scope\n\n${allocations.join('\n')}\n\nThe stated error budget is **${percent(budget)}**. Company and general/GPQA policies are separate for every local model. Fit, selection, calibration and audit roles remain separate; test answers are replayed only after the policy is locked. No test label selects a model or threshold. Adversarial items remain local-only and are excluded from ordinary safe-answer acceptance and projected skipped-cloud-call counts.\n\n${certificateTable.join('\n')}\n\nCertificate scope: ${riskScopes.length?riskScopes.map(escaped).join('; '):'See recorded calibration certificate; scope is not inferred from observed accuracy.'} **These bounds certify only the stated fixed finite dev frame, not future company traffic, new responses or the test population.** No future 5% error guarantee is claimed. A noncertified slice abstains; lack of acceptance is not a zero-error certificate. Audit and frozen-test confidence intervals below describe their observed outcomes rather than extending the calibration certificate.\n\n## Primary frozen comparisons\n\n${primary.map(populationSection).join('\n')}\n\n## Other roles and frozen plain control\n\n${other.map(populationSection).join('\n')}\n\n## Interpretation\n\nAccepted-answer accuracy treats unknown or unsupported accepted labels conservatively as errors. Supported-only accuracy and explicitly IID Wilson sensitivity intervals are retained in JSON. Source-group bootstrap intervals are descriptive and can be degenerate with no observed errors; they do not replace the finite-frame risk certificate. Fit/selection statistics are diagnostics, not independent accuracy estimates. Rates use observed question counts and retain separate populations/models; no average of different Gemma sizes is reported.\n\nOnly answers passing citation/source-completeness validation and the truncation gate can be accepted. Model output at the 768-token structured cap escalates. All retained gates are evaluated before calibrated acceptance; no oracle source list or grading reference is a runtime feature.\n\nCloud fees use each saved redacted question/minimal-context payload counted offline with Gemini's pinned SDK-selected tokenizer and the labelled Muse Spark Llama BPE proxy. Server framing and provider invoices are unknown; output/reasoning lengths, unit prices and zero cache discount are assumptions. The same lean question-only payload serves handoff and cloud-only baselines, while accepted/adversarial items incur zero cloud fees. Local hardware allocation is separate. These are conditional pre-Guard projections: no new cloud answer quality or future Guard decision is measured. Cloud quality per dollar remains pending. Raw payloads, keys and GPQA question text stay private.\n\n**STOP before Stage 4.**\n`;
}
