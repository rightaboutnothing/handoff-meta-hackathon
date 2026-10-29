import {useId} from 'react';
import type {PrivacyMetric,PrivacyPanel,PrivacyProgress,PrivacyResultsReport,PrivacySetup} from '../privacyResultsTypes';
import './PrivacyResults.css';

const pending='Pending';
const number=(value:number|null|undefined,digits=0)=>value==null||!Number.isFinite(value)?pending:new Intl.NumberFormat('en-AU',{maximumFractionDigits:digits}).format(value);
const percent=(value:number|null|undefined)=>value==null||!Number.isFinite(value)?pending:`${(value*100).toFixed(1)}%`;
const interval=(value:PrivacyMetric|null|undefined)=>value?.wilson95?`${percent(value.wilson95[0])}–${percent(value.wilson95[1])}`:pending;
const pair=(value:PrivacyMetric|null|undefined)=>value?`${number(value.events)}/${number(value.n)}`:pending;
const setupColour=(id:string)=>id==='meta-lens'?'#0866ff':id==='google-lens'?'#098d82':id==='google-native-only'?'#b57912':'#78869b';
const setupDash=(id:string)=>id==='google-native-only'?'7 4':id==='presidio-baseline'?'2 5':undefined;
const shortName=(setup:Pick<PrivacySetup,'id'|'label'>)=>setup.id==='meta-lens'?'Meta':setup.id==='google-lens'?'Google':setup.id==='google-native-only'?'Google native-only':setup.id==='presidio-baseline'?'Presidio':setup.label;
const isMetric=(metric:PrivacyMetric|null|undefined)=>metric==null||Number.isInteger(metric.n)&&metric.n>=0&&Number.isInteger(metric.events)&&metric.events>=0&&metric.events<=metric.n&&(metric.n===0?metric.rate===null&&metric.wilson95===null:Number.isFinite(metric.rate)&&Math.abs((metric.rate as number)-metric.events/metric.n)<1e-8&&Array.isArray(metric.wilson95)&&metric.wilson95.length===2&&metric.wilson95.every(value=>Number.isFinite(value)&&value>=0&&value<=1));
function validReport(report:PrivacyResultsReport){return report.kind==='privacy-results-dashboard'&&report.schemaVersion===1&&report.cloudCalls===0&&report.spendUsd===0&&report.liveDispatchEnabled===false&&Array.isArray(report.setups)&&report.setups.every(setup=>[setup.pii?.frozen,setup.pii?.multicountry,setup.usable?.frozen,setup.usable?.multicountry,setup.attacks,setup.safe,setup.applications?.complete,setup.applications?.fullCredit].every(isMetric));}

function Metric({value,bad=false}:{value:PrivacyMetric|null|undefined;bad?:boolean}){
  return <span className={`pvr-measure ${bad?'pvr-caution':''}`}><strong>{pair(value)}</strong><span>{percent(value?.rate)}</span><small>Wilson 95% {interval(value)}</small>{value?.errors? <small>{number(value.errors)} execution errors</small>:null}</span>;
}
function TwinMetric({frozen,multicountry,privacy=false}:{frozen:PrivacyMetric|null;multicountry:PrivacyMetric|null;privacy?:boolean}){
  return <div className="pvr-twin"><div><span className="pvr-population">Frozen</span><Metric value={frozen} bad={privacy?(frozen?.events??0)>0:!!frozen&&frozen.n>0&&frozen.events===0}/></div><div><span className="pvr-population">Multi-country</span><Metric value={multicountry} bad={privacy?(multicountry?.events??0)>0:!!multicountry&&multicountry.n>0&&multicountry.events===0}/></div></div>;
}
function PanelHeader({eyebrow,title,detail}:{eyebrow:string;title:string;detail:string}){
  return <header className="pvr-panel-heading"><div><span className="pvr-eyebrow">{eyebrow}</span><h2>{title}</h2></div><p>{detail}</p></header>;
}
function RunTag({report}:{report:PrivacyResultsReport}){return <div className="pvr-run-tag"><span>Stage {report.stage} · locked results</span><code>{report.runId}</code></div>;}

function Headline({report}:{report:PrivacyResultsReport}){
  const unavailable=report.setups.filter(row=>row.usable.frozen&&row.usable.frozen.n>0&&row.usable.frozen.events===0);
  return <section id="privacy-headline" data-export-panel="headline" className="pvr-panel pvr-headline" aria-label="Latest locked privacy results">
    <PanelHeader eyebrow="Boundary evidence · latest locked run" title="Privacy that can be inspected." detail="Every setup keeps its own denominators. These are local measurements, with no cloud delivery."/>
    <RunTag report={report}/>
    <div className="pvr-scroll"><table className="pvr-table pvr-headline-table"><caption className="pvr-sr-only">PII survivors, usable questions, attack blocks, safe false blocks, local applications and Stage 7 gates, with Wilson 95% intervals</caption><thead><tr><th scope="col">Setup</th><th scope="col">PII survivors <small>lower is better</small></th><th scope="col">Usable questions <small>higher is better</small></th><th scope="col">Attacks blocked</th><th scope="col">Safe wrongly blocked</th><th scope="col">Local answers applied</th><th scope="col">Stage 7</th></tr></thead><tbody>{report.setups.map(setup=><tr key={setup.id}><th scope="row"><span className="pvr-setup"><i style={{background:setupColour(setup.id)}} aria-hidden="true"/>{setup.label}</span>{!setup.productionCandidate&&<small className="pvr-control">Comparison control</small>}</th><td><TwinMetric {...setup.pii} privacy/></td><td><TwinMetric {...setup.usable}/></td><td><Metric value={setup.attacks}/><small className="pvr-cell-note">Combined available checks</small></td><td><Metric value={setup.safe} bad={(setup.safe?.events??0)>0}/></td><td><Metric value={setup.applications.complete}/><small className="pvr-cell-note">Full credit {pair(setup.applications.fullCredit)}</small><small className="pvr-cell-note">{setup.applications.complete?'Local surrogate guidance':'Application not measured'}</small></td><td><span className={`pvr-gate ${setup.gate.status.toLowerCase()}`}>{setup.gate.status}</span><ul className="pvr-gate-reasons">{setup.gate.reasons.map((reason,index)=><li key={index}>{reason}</li>)}</ul><small className="pvr-cell-note">Unresolved errors: {number(setup.errors)}</small></td></tr>)}</tbody></table></div>
    {unavailable.length>0&&<div className="pvr-warning" role="note"><strong>Zero survivors does not mean usable service.</strong><p>{unavailable.map(setup=>`${setup.label}: ${pair(setup.usable.frozen)} usable frozen questions`).join(' · ')}. Empty or unavailable questions cannot establish successful private answers.</p></div>}
    <p className="pvr-method-note">Wilson intervals describe the measured sample under an independence sensitivity assumption. Related synthetic templates are correlated. Completed applications are separate from full-credit answers; Presidio is a PII comparison, not a safety pipeline.</p>
  </section>;
}

type TrendKey='usableFrozen'|'safeOperational';
function TrendChart({report,metricKey,title,subtitle}:{report:PrivacyResultsReport;metricKey:TrendKey;title:string;subtitle:string}){
  const plot={left:54,right:536,top:26,bottom:202},x=(index:number)=>plot.left+(plot.right-plot.left)*(report.progress.length>1?index/(report.progress.length-1):0),y=(rate:number)=>plot.bottom-rate*(plot.bottom-plot.top),ticks=[0,.25,.5,.75,1];
  return <div className="pvr-trend"><h3>{title}</h3><p>{subtitle}</p><svg viewBox="0 0 576 246" role="img" aria-label={title}><title>{title}; exact values and missing measurements are listed in the table below.</title>{ticks.map(tick=><g key={tick}><line x1={plot.left} x2={plot.right} y1={y(tick)} y2={y(tick)} className="pvr-grid-line"/><text x={plot.left-10} y={y(tick)+4} textAnchor="end" className="pvr-axis">{Math.round(tick*100)}%</text></g>)}{report.progress.map((stage,index)=><text key={stage.stage} x={x(index)} y={229} textAnchor="middle" className="pvr-axis">Stage {stage.stage}</text>)}{report.setups.map(setup=>{
    const points=report.progress.map((stage,index)=>({index,metric:stage.setups.find(row=>row.id===setup.id)?.[metricKey]}));
    return <g key={setup.id}>{points.slice(1).map((point,index)=>{const previous=points[index];return point.metric?.rate!=null&&previous.metric?.rate!=null?<line key={`line-${point.index}`} x1={x(previous.index)} y1={y(previous.metric.rate)} x2={x(point.index)} y2={y(point.metric.rate)} stroke={setupColour(setup.id)} strokeWidth="2.3" strokeDasharray={setupDash(setup.id)}/>:null;})}{points.map(point=>point.metric?.rate!=null?<g key={`point-${point.index}`}><circle cx={x(point.index)} cy={y(point.metric.rate)} r="4" fill={setupColour(setup.id)} stroke="var(--pvr-surface)" strokeWidth="1.5"/><title>{setup.label} · Stage {report.progress[point.index].stage}: {pair(point.metric)} · {percent(point.metric.rate)} · Wilson 95% {interval(point.metric)}</title></g>:null)}</g>})}</svg></div>;
}
function Progress({report}:{report:PrivacyResultsReport}){
  const find=(stage:PrivacyProgress,id:string)=>stage.setups.find(setup=>setup.id===id);
  return <section id="privacy-progress" data-export-panel="progress" className="pvr-panel" aria-label="Privacy progress across stages">
    <PanelHeader eyebrow="Progress · separate locked measurements" title="Keep the regressions visible." detail={`${report.progress.map(row=>'Stage '+row.stage).join(' → ')}. Missing measurements stay pending; methods and populations are not silently blended.`}/>
    <div className="pvr-legend">{report.setups.map(setup=><span key={setup.id}><i style={{background:setupColour(setup.id)}}/>{shortName(setup)}</span>)}</div>
    <div className="pvr-trend-grid"><TrendChart report={report} metricKey="usableFrozen" title="Usable questions · frozen PII set" subtitle="Share of attempted frozen questions with usable outgoing questions."/><TrendChart report={report} metricKey="safeOperational" title="Safe queries wrongly blocked" subtitle="Operational blocks include fail-closed unavailable checks."/></div>
    <div className="pvr-scroll"><table className="pvr-table pvr-progress-table"><caption className="pvr-sr-only">Exact progress counts, separate frozen and multi-country usability, operational safe blocks and measured-check safe blocks</caption><thead><tr><th scope="col">Setup</th>{report.progress.map(stage=><th scope="col" key={stage.stage}>Stage {stage.stage}<small>{stage.runId??pending}</small></th>)}</tr></thead><tbody>{report.setups.map(setup=><tr key={setup.id}><th scope="row">{setup.label}</th>{report.progress.map(stage=>{const row=find(stage,setup.id);return <td key={stage.stage}><dl className="pvr-progress-values"><div><dt>Usable · frozen</dt><dd>{pair(row?.usableFrozen)}</dd></div><div><dt>Usable · country</dt><dd>{pair(row?.usableMulticountry)}</dd></div><div><dt>Safe blocks · operational</dt><dd>{pair(row?.safeOperational)}</dd></div><div><dt>Safe blocks · available checks</dt><dd>{pair(row?.safeDetected)}</dd></div></dl></td>;})}</tr>)}</tbody></table></div>
    <p className="pvr-method-note">A fail-closed pending detector can block safe queries operationally without a measured positive classification. Both counts remain visible. Lines connect separate runs on a known frame; they do not establish unseen-traffic improvement.</p>
  </section>;
}

function Attribution({report}:{report:PrivacyResultsReport}){
  const layers=[...new Map(report.setups.flatMap(setup=>setup.attribution.map(row=>[row.layerId,row.label] as const))).entries()],max=Math.max(1,...report.setups.flatMap(setup=>setup.attribution.flatMap(row=>row.firstBlocks==null?[]:[row.firstBlocks])));
  return <section id="privacy-attribution" data-export-panel="attribution" className="pvr-panel" aria-label="False-block attribution by layer">
    <PanelHeader eyebrow="False-block attribution · first failure" title="Which check stopped the question?" detail="Bars count the first blocking layer. Overlapping flags are shown separately and must not be added to the bar totals."/>
    <div className="pvr-attribution-grid">{layers.map(([layerId,label])=><div className="pvr-layer" key={layerId}><h3>{label}</h3>{report.setups.map(setup=>{const row=setup.attribution.find(value=>value.layerId===layerId);return <div className="pvr-layer-row" key={setup.id}><span>{shortName(setup)}</span><div className="pvr-bar-track" aria-hidden="true">{row?.firstBlocks!=null&&<i style={{width:`${row.firstBlocks/max*100}%`,background:setupColour(setup.id)}}/>}</div><strong>{number(row?.firstBlocks)}</strong><small>overlap {row?.overlapping?pair(row.overlapping):pending}</small></div>;})}</div>)}</div>
    {!layers.length&&<p className="pvr-empty">Layer attribution is pending. No missing layer is rendered as zero.</p>}
    <p className="pvr-method-note">Lost intent at tokenisation and question validation remain separate from Prompt Guard and harmful-content verdicts. Rewrite refusals and other failures stay visible so the requested layers do not conceal residual blocks. A classifier verdict is a measurement, not an explanation of a model's internal reasoning.</p>
  </section>;
}

function PromptGuard({report}:{report:PrivacyResultsReport}){
  return <section id="privacy-prompt-guard" data-export-panel="prompt-guard" className="pvr-panel" aria-label="Prompt Guard comparison">
    <PanelHeader eyebrow="Prompt Guard · local original-text screening" title="Jailbreaks and injections are different tests." detail="The primary detector and comparison keep the locked threshold. Higher combined pipeline blocking is not isolated injection recall."/>
    <div className="pvr-pg-grid">{report.promptGuard.map(model=><article className={`pvr-pg-card ${model.variant==='86m'?'primary':''}`} key={model.variant}><div className="pvr-pg-title"><div><span className="pvr-eyebrow">{model.variant==='86m'?'Primary':'Comparison'}</span><h3>Prompt Guard 2 <span>{model.variant.toUpperCase()}</span></h3></div><span className="pvr-threshold">Threshold {number(model.threshold,3)}</span></div><div className="pvr-pg-rates"><div><span>Jailbreak catch rate</span><Metric value={model.jailbreak}/></div><div><span>Injection catch rate</span><Metric value={model.injection}/></div><div><span>Safe wrongly blocked</span><Metric value={model.safe} bad={(model.safe?.events??0)>0}/></div></div><dl className="pvr-latencies"><div><dt>Median latency</dt><dd>{number(model.latency?.medianMs,2)}<small>ms</small></dd></div><div><dt>p95 latency</dt><dd>{number(model.latency?.p95Ms,2)}<small>ms</small></dd></div><div><dt>Available / attempted</dt><dd>{number(model.available)}/{number(model.attempted)}</dd></div><div><dt>Execution errors</dt><dd>{number(model.errors)}</dd></div></dl></article>)}</div>
    {!report.promptGuard.length&&<p className="pvr-empty">Standalone Prompt Guard measurements are pending.</p>}
    <p className="pvr-method-note">These rates screen original local inputs. The composed pipeline also checks transformed questions, decoded variants and other layers, so its safe-block count may differ. Injection weaknesses remain findings; these measurements do not change a threshold.</p>
  </section>;
}

function Provenance({report}:{report:PrivacyResultsReport}){
  return <footer id="privacy-provenance" data-export-panel="provenance" className="pvr-panel pvr-provenance" aria-label="Measurement provenance">
    <PanelHeader eyebrow="Measurement receipt · local-only evidence" title="Send the question, never the data." detail="A locked run, a reproducible source and an explicit boundary. No live dispatch is enabled by this view."/>
    <dl className="pvr-provenance-grid"><div><dt>Measured source hash</dt><dd><code>{report.sourceHash}</code></dd></div><div><dt>Measurement run</dt><dd><code>{report.runId}</code></dd></div><div><dt>Run time · Perth</dt><dd>{report.timestampAwst}</dd></div><div><dt>Seed</dt><dd><code>{report.seed==null?pending:String(report.seed)}</code></dd></div><div><dt>Measured source commit</dt><dd><code>{report.sourceCommit??pending}</code></dd></div><div><dt>Report SHA-256</dt><dd><code>{report.reportSha256}</code></dd></div></dl>
    <div className="pvr-offline-rail"><span>Cloud model calls <strong>{number(report.cloudCalls)}</strong></span><span>Cloud spend <strong>${number(report.spendUsd,2)}</strong></span><span>Live dispatch <strong>{report.liveDispatchEnabled?'Enabled':'Disabled'}</strong></span><span>Run stage <strong>{report.stage}</strong></span></div>
    {report.gaps.length>0&&<div className="pvr-gaps"><h3>What the results cannot fill</h3><ul>{report.gaps.map((gap,index)=><li key={index}>{gap}</li>)}</ul></div>}
    {report.notes.length>0&&<details className="pvr-notes"><summary>Method and interpretation notes</summary>{report.notes.map((note,index)=><p key={index}>{note}</p>)}</details>}
    <p className="pvr-method-note">This view exposes aggregate measurements only. It contains no prompt text, private values, model answers, credentials or request payloads. The synthetic PII sets and known evaluation frame do not establish compliance or guarantee future privacy.</p>
  </footer>;
}

const panels:{id:PrivacyPanel;render:(report:PrivacyResultsReport)=>React.ReactNode}[]=[{id:'headline',render:report=><Headline report={report}/>},{id:'progress',render:report=><Progress report={report}/>},{id:'attribution',render:report=><Attribution report={report}/>},{id:'prompt-guard',render:report=><PromptGuard report={report}/>},{id:'provenance',render:report=><Provenance report={report}/>}];
export function PrivacyResults({report,onlyPanel}:{report?:PrivacyResultsReport|null;onlyPanel?:PrivacyPanel}){
  const uid=useId();
  if(!report)return <section className="pvr-view pvr-panel pvr-empty" aria-labelledby={`${uid}-heading`}><span className="pvr-eyebrow">Locked privacy results</span><h2 id={`${uid}-heading`}>Measurements pending.</h2><p>No complete Stage 6f, Stage 6d or Stage 6c report is available. Missing evidence is never counted as a pass.</p></section>;
  if(!validReport(report))return <section className="pvr-view pvr-panel pvr-empty" role="alert"><span className="pvr-eyebrow">Locked privacy results</span><h2>Results need verification.</h2><p>The saved data do not match the required local-only measurement state. Figures are hidden.</p></section>;
  return <div className="pvr-view" data-privacy-results={report.runId}>{panels.filter(panel=>!onlyPanel||panel.id===onlyPanel).map(panel=><div className="pvr-panel-wrapper" key={panel.id}>{panel.render(report)}</div>)}</div>;
}
