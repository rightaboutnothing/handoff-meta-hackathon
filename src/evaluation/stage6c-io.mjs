import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from '../rag/receipts.mjs';
import {STAGE6B_ROOT,loadStage6bInputs,loadStage6bQuality,fingerprintStage6b,readStage6bJson} from './stage6b-io.mjs';

export const STAGE6C_ROOT=STAGE6B_ROOT;
export const stage6cPrivateRoot=(root=STAGE6C_ROOT)=>{const directory=path.resolve(process.env.STAGE6C_PRIVATE_ROOT??path.join(root,'../Handoff-private/stage6c')),relative=path.relative(path.resolve(root),directory);if(!relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw Error('STAGE6C_PRIVATE_ROOT_MUST_BE_EXTERNAL');return directory;};
export {readStage6bJson as readStage6cJson,optionalStage6bJson as optionalStage6cJson,durableStage6bJson as durableStage6cJson,appendStage6bJsonl as appendStage6cJsonl,readStage6bJournal as readStage6cJournal} from './stage6b-io.mjs';
export async function loadStage6cInputs({root=STAGE6C_ROOT}={}){
  const source=await loadStage6bInputs({root}),settings=await readStage6bJson(path.join(root,'config/stage6c-evaluation.json'));
  if(settings.sourceCorpusItems!==522||settings.multicountryItems!==60||source.multicountry.length!==60||settings.cloudCallsAllowed!==false||settings.seed!==20261027)throw Error('STAGE6C_INPUT_CONFIGURATION_INVALID');
  if(new Set([...source.items,...source.multicountry].map(item=>item.id)).size!==582)throw Error('STAGE6C_ITEM_IDS_MUST_BE_UNIQUE');
  for(const [area,count]of Object.entries({attacks:200,safe:74,pii:50,evasion:60,inbound:138}))if(source.items.filter(item=>item.area===area).length!==count)throw Error('STAGE6C_FROZEN_STRATA_INVALID');
  if(source.multicountry.some(item=>!Array.isArray(item.piiSeeds)||!item.piiSeeds.length||item.localOnly!==true||item.attackSet!==true||item.safety?.cloudEligible===true))throw Error('STAGE6C_MULTICOUNTRY_LOCAL_ONLY_REQUIRED');
  return{...source,settings,privateRoot:stage6cPrivateRoot(root),multicountrySourceRoot:source.privateRoot};
}
export const loadStage6cQuality=loadStage6bQuality;
export async function loadPreviousStage6cReport(root,previous){
  if(!previous)return null;
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(previous.directory??'')||!/^[a-f0-9]{64}$/.test(previous.reportSha256??''))throw Error('STAGE6C_PREVIOUS_BASELINE_INVALID');
  const text=await readFile(path.join(root,'results',previous.directory,'report.json'),'utf8');
  if(sha256(text)!==previous.reportSha256)throw Error('STAGE6C_PREVIOUS_BASELINE_CHANGED');
  const report=JSON.parse(text);
  if(report.kind!=='stage6c-question-boundary-report'||report.runId!==previous.directory||report.cloudCalls!==0||report.spendUsd!==0)throw Error('STAGE6C_PREVIOUS_BASELINE_INVALID');
  return{directory:previous.directory,sha256:previous.reportSha256,sourceCommit:report.source.gitCommit,
    setups:report.setups.map(setup=>({id:setup.id,privacy:setup.privacy,metrics:setup.metrics,detectorBreakdown:setup.detectorBreakdown,falsePositiveAttribution:setup.falsePositiveAttribution,errors:setup.summary.errors,qualityCompleted:setup.quality.completed,qualityAttempted:setup.quality.n})),
    promptGuardStandalone:report.promptGuardStandalone.map(model=>({variant:model.variant,threshold:model.threshold,attacks:model.attacks,safe:model.safe,available:model.available,attempted:model.attempted})),
    note:'Preserved prior measurement; no model call, checkpoint or latency is reused in the new run. Corrections reuse the same known evaluation frame, not an unseen validation set.'};
}
export const isStage6cSourceFile=name=>!/(?:^|\/)__pycache__\/|\.py[co]$/i.test(name)&&/\.(?:mjs|py|json)$/.test(name);
export async function fingerprintStage6c(root=STAGE6C_ROOT){
  const original=await fingerprintStage6b(root),files=Object.fromEntries(Object.entries(original.files).filter(([name])=>isStage6cSourceFile(name)));
  for(const name of ['config/stage6c-evaluation.json','config/stage6c-rewrite-development.json','config/stage6c-integration-development.json','config/prompt-guard-artifacts.json','src/evaluation/stage6c-io.mjs','src/evaluation/stage6c-metrics.mjs','src/evaluation/stage6c-runner.mjs','src/rag/gateway.mjs'])files[name]=sha256((await readFile(path.join(root,name),'utf8')).replace(/\r\n/g,'\n'));
  return{hash:sha256(files),files,gitCommit:original.gitCommit};
}
