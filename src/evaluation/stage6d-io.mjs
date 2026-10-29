import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {sha256} from '../rag/receipts.mjs';
import {loadStage6cInputs,loadStage6cQuality,loadPreviousStage6cReport,fingerprintStage6c,stage6cPrivateRoot,STAGE6C_ROOT} from './stage6c-io.mjs';

export const STAGE6D_ROOT=STAGE6C_ROOT;
export {readStage6cJson as readStage6dJson,optionalStage6cJson as optionalStage6dJson,durableStage6cJson as durableStage6dJson,appendStage6cJsonl as appendStage6dJsonl,readStage6cJournal as readStage6dJournal} from './stage6c-io.mjs';
export const stage6dPrivateRoot=(root=STAGE6D_ROOT)=>{const directory=path.resolve(process.env.STAGE6D_PRIVATE_ROOT??path.join(root,'../Handoff-private/stage6d')),relative=path.relative(path.resolve(root),directory);if(!relative||!relative.startsWith('..'+path.sep)&&relative!=='..'&&!path.isAbsolute(relative))throw Error('STAGE6D_PRIVATE_ROOT_MUST_BE_EXTERNAL');return directory;};
export async function loadStage6dInputs({root=STAGE6D_ROOT}={}){
  const source=await loadStage6cInputs({root}),settings=JSON.parse(await readFile(path.join(root,'config/stage6d-evaluation.json'),'utf8'));
  if(settings.seed!==20261027||settings.sourceCorpusItems!==522||settings.multicountryItems!==60||settings.cloudCallsAllowed!==false||settings.qualityItems!==11)throw Error('STAGE6D_INPUT_CONFIGURATION_INVALID');
  if(JSON.stringify(settings.stage7Criteria)!==JSON.stringify(source.settings.stage7Criteria))throw Error('STAGE6D_LOCKED_CRITERIA_CHANGED');
  if(settings.applicationTarget?.setupId!=='meta-lens'||settings.applicationTarget.minCompleted!==8||settings.applicationTarget.totalItems!==11)throw Error('STAGE6D_APPLICATION_TARGET_INVALID');
  const beforeAuditText=await readFile(path.join(root,settings.safeBeforeAudit),'utf8');if(sha256(beforeAuditText)!==settings.safeBeforeAuditSha256)throw Error('STAGE6D_SAFE_AUDIT_HASH_CHANGED');
  for(const previous of settings.preservedStage6cRuns??[])await loadPreviousStage6cReport(root,previous);
  if(settings.runId!== '2026-10-29-stage6d-question-boundary-r4'||!settings.previousStage6dRun||!settings.previousStage6dRunR2||!settings.previousStage6dRunR3)throw Error('STAGE6D_R4_IDENTITY_REQUIRED');
  await loadPriorStage6dRun(root,settings.previousStage6dRun);
  await loadPriorStage6dRun(root,settings.previousStage6dRunR2);
  await loadPriorStage6dRun(root,settings.previousStage6dRunR3);
  return{...source,settings,privateRoot:stage6dPrivateRoot(root)};
}
export const loadStage6dQuality=loadStage6cQuality;
export async function loadPreviousStage6dReport(root,previous){
  const summary=await loadPreviousStage6cReport(root,previous);if(!summary)return null;
  const report=JSON.parse(await readFile(path.join(root,'results',previous.directory,'report.json'),'utf8'));
  let audit=null;try{audit=JSON.parse(await readFile(path.join(root,'docs/stage6d-safe-before-audit.json'),'utf8'));if(audit.sourceReportHash!==previous.reportSha256)throw Error('STAGE6D_SAFE_AUDIT_SOURCE_CHANGED');}catch(error){if(error.code!=='ENOENT')throw error;}
  let retained=null;
  try{const folder=path.join(stage6cPrivateRoot(root),'runs',previous.directory),state=JSON.parse(await readFile(path.join(folder,'study.json'),'utf8'));retained=JSON.parse(await readFile(path.join(folder,'final-rows.json'),'utf8'));if(retained.identity!==sha256(state.identity)||state.source.hash!==report.source.hash)throw Error('STAGE6D_PRIOR_METADATA_IDENTITY_CHANGED');}
  catch(error){if(error.code!=='ENOENT')throw error;}
  const safeCode=value=>/^[A-Z][A-Z_0-9]{0,79}$/.test(value??'')?value:'UNSPECIFIED_LOCAL_ERROR';
  return{...summary,setups:summary.setups.map(setup=>{
    const saved=report.setups.find(row=>row.id===setup.id),rows=retained?.setups[setup.id]??[],qualityRows=retained?.quality[setup.id]??[];
    const lens=setup.id==='meta-lens'?'meta':setup.id==='presidio-baseline'?'presidio':'google';
    const safeRules=rows.filter(row=>row.area==='safe'&&row.population==='frozen').map(row=>{const diagnosis=audit?.safeRows?.find(item=>item.id===row.id&&item.lens===lens),blockedDiagnosis=audit?.blockedSafeDiagnoses?.find(item=>item.id===row.id&&item.setup===setup.id);if(diagnosis&&diagnosis.sourceHash!==(row.sourceHash??row.hash))throw Error('STAGE6D_SAFE_AUDIT_ITEM_CHANGED');return{id:row.id,category:row.category,hash:row.sourceHash??row.hash,blocked:row.hypotheticalBlocked===true,error:row.error===true,layerBlocks:(row.layerBlocks??[]).map(block=>({layerId:block.layerId,code:safeCode(block.code),availability:block.availability===true})),diagnosis:diagnosis?{classification:diagnosis.classification,missingActions:diagnosis.missingActions,missingConstraints:diagnosis.missingConstraints,shape:diagnosis.shape,firstBlockingLayer:blockedDiagnosis?.firstBlockingLayer??null,subrules:blockedDiagnosis?.rules?.map(rule=>({code:safeCode(rule.code),why:rule.why,missingActions:rule.missingActions,missingConstraints:rule.missingConstraints}))??null}:null};});
    const errorStages=rows.flatMap(row=>(row.stages??[]).filter(stage=>['ERROR','INVALID','UNAVAILABLE'].includes(stage.status)).map(stage=>({id:row.id,category:row.category,hash:row.sourceHash??row.hash,area:row.area,layerId:stage.layerId,code:safeCode(stage.code),status:stage.status})));
    return{...setup,quality:saved.quality,layerLatency:saved.layerLatency,qualityPerItemScores:qualityRows.map(row=>({id:row.id,status:row.status,scoreBefore:Number.isFinite(row.beforeScore?.score)?row.beforeScore.score:null,scoreAfter:Number.isFinite(row.afterScore?.score)?row.afterScore.score:null,code:row.reason?safeCode(row.reason):null})),safeRules,safeRulesAvailable:safeRules.length===74,safeRulesSha256:sha256(safeRules),errorStages,errorStagesAvailable:rows.length===582,qualityErrorCodes:qualityRows.filter(row=>row.reason).map(row=>({id:row.id,status:row.status,code:safeCode(row.reason)}))};
  }),beforeSafeAudit:audit,beforeSafeAuditSha256:audit?sha256(await readFile(path.join(root,'docs/stage6d-safe-before-audit.json'),'utf8')):null};
}
/** Immutable earlier Stage 6d baseline. Only metadata is returned; no generated
 * answers, call caches or latency observations enter the new run's work. */
export async function loadPriorStage6dRun(root,previous){
  if(!previous||!/^2026-10-29-stage6d-question-boundary(?:-r[23])?$/.test(previous.directory??'')||!['reportSha256','sourceHash','privateIdentity'].every(key=>/^[a-f0-9]{64}$/.test(previous[key]??''))||!/^[a-f0-9]{40}$/.test(previous.sourceCommit??''))throw Error('STAGE6D_PRIOR_RUN_DESCRIPTOR_INVALID');
  const reportPath=path.join(root,'results',previous.directory),raw=await readFile(path.join(reportPath,'report.json'),'utf8');
  if(sha256(raw)!==previous.reportSha256)throw Error('STAGE6D_PRIOR_REPORT_HASH_CHANGED');
  for(const [name,expected]of Object.entries(previous.publicFiles??{})){if(!/^[a-z-]+\.(?:json|md)$/.test(name)||!/^[a-f0-9]{64}$/.test(expected))throw Error('STAGE6D_PRIOR_FILE_DESCRIPTOR_INVALID');if(sha256(await readFile(path.join(reportPath,name),'utf8'))!==expected)throw Error('STAGE6D_PRIOR_FILE_HASH_CHANGED');}
  const report=JSON.parse(raw);
  if(report.kind!=='stage6d-question-boundary-report'||report.runId!==previous.directory||report.cloudCalls!==0||report.spendUsd!==0||report.liveDispatchEnabled!==false||report.source?.hash!==previous.sourceHash||report.source?.gitCommit!==previous.sourceCommit)throw Error('STAGE6D_PRIOR_REPORT_IDENTITY_CHANGED');
  const folder=path.join(stage6dPrivateRoot(root),'runs',previous.directory),state=JSON.parse(await readFile(path.join(folder,'study.json'),'utf8')),retained=JSON.parse(await readFile(path.join(folder,'final-rows.json'),'utf8'));
  if(retained.identity!==previous.privateIdentity||retained.identity!==sha256(state.identity)||state.identity.sourceHash!==previous.sourceHash||state.source.hash!==previous.sourceHash||sha256(state.source.files)!==previous.sourceHash||sha256(report.source.files)!==previous.sourceHash||state.source.gitCommit!==previous.sourceCommit||sha256(state.identity.inputs)!==sha256(report.inputHashes)||state.identity.quality!==report.qualitySourceHash)throw Error('STAGE6D_PRIOR_PRIVATE_IDENTITY_CHANGED');
  if(state.identity.runId!==undefined&&state.identity.runId!==previous.directory||state.identity.settingsHash!==undefined&&state.identity.settingsHash!==sha256(report.settings))throw Error('STAGE6D_PRIOR_SETTINGS_IDENTITY_CHANGED');
  const safeCode=value=>/^[A-Z][A-Z_0-9]{0,79}$/.test(value??'')?value:'UNSPECIFIED_LOCAL_ERROR';
  return{directory:previous.directory,sha256:previous.reportSha256,sourceCommit:previous.sourceCommit,sourceHash:previous.sourceHash,privateIdentity:previous.privateIdentity,publicFiles:previous.publicFiles,pointerSnapshotSha256:previous.pointerSnapshotSha256,inputHashes:report.inputHashes,qualitySourceHash:report.qualitySourceHash,settingsHash:sha256(report.settings),stage7Criteria:report.settings.stage7Criteria,
    setups:report.setups.map(setup=>{const rows=retained.setups[setup.id]??[],qualityRows=retained.quality[setup.id]??[];if(rows.length!==582||rows.filter(row=>row.population==='frozen').length!==522||rows.filter(row=>row.population==='multicountry').length!==60)throw Error('STAGE6D_PRIOR_FRAME_CHANGED');return{id:setup.id,label:setup.label,privacy:setup.privacy,metrics:setup.metrics,summary:setup.summary,gate:setup.gate,applicationTarget:setup.applicationTarget,errorAttempts:setup.errorAttempts,layerLatency:setup.layerLatency,qualityCompleted:setup.quality.completed,qualityAttempted:setup.quality.n,qualityPerItemScores:qualityRows.map(row=>({id:row.id,status:row.status,scoreBefore:Number.isFinite(row.beforeScore?.score)?row.beforeScore.score:null,scoreAfter:Number.isFinite(row.afterScore?.score)?row.afterScore.score:null,completionKnown:row.completionKnown===true,applicationCompleted:row.applicationCompleted===true,method:row.application?.method??null,code:row.reason?safeCode(row.reason):null})),safeRules:rows.filter(row=>row.population==='frozen'&&row.area==='safe').map(row=>({id:row.id,category:row.category,hash:row.sourceHash??row.hash,blocked:row.hypotheticalBlocked===true,error:row.error===true,layerBlocks:(row.layerBlocks??[]).map(block=>({layerId:block.layerId,code:safeCode(block.code),availability:block.availability===true})),diagnosis:{firstBlockingLayer:row.layerBlocks?.[0]?.layerId??null,intent:row.intent??null,validation:row.validation??null,rewriteStrategy:row.rewriteStrategy??null}}))};}),
    note:'Immutable earlier Stage 6d metadata only. Fresh current-run inferences, scores and latency measurements are required; this is the same known frame, not unseen validation.'};
}
export async function fingerprintStage6d(root=STAGE6D_ROOT){
  const base=await fingerprintStage6c(root),files={...base.files};
  for(const name of ['config/stage6d-evaluation.json','docs/stage6d-safe-before-audit.json','docs/stage6d-r1-application-provenance-audit.json','docs/stage6d-r1-interpretation.md','src/evaluation/stage6d-io.mjs','src/evaluation/stage6d-metrics.mjs','src/evaluation/stage6d-runner.mjs','scripts/run-stage6d.mjs','scripts/preflight-stage6d.mjs','package.json'])files[name]=sha256((await readFile(path.join(root,name),'utf8')).replace(/\r\n/g,'\n'));
  for(const name of ['config/stage6d-rewrite-development.json','config/stage6d-application-development.json','config/stage6d-r2-rewrite-development.json','config/stage6d-r2-rewrite-development-v1.json','config/stage6d-r2-ner-development.json','config/stage6d-r2-ner-development-v1.json','config/stage6d-r3-rewrite-development.json','config/stage6d-r3-rewrite-development-v1.json','config/stage6d-r3-ner-development.json','config/stage6d-r3-ner-development-v1.json','config/stage6d-r4-rewrite-development.json','config/stage6d-r4-rewrite-development-v1.json','config/stage6d-r4-ner-development.json','config/stage6d-r4-ner-development-v1.json','docs/stage6d-r2-interpretation.md','docs/stage6d-r3-interpretation.md'])try{files[name]=sha256((await readFile(path.join(root,name),'utf8')).replace(/\r\n/g,'\n'));}catch(error){if(error.code!=='ENOENT')throw error;}
  return{hash:sha256(files),files,gitCommit:base.gitCommit};
}
