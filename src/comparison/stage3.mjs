import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {comparisonLocal,loadPricing} from '../server/comparison-models.mjs';
import {generateLocalAnswer} from './local-answer.mjs';
import {attachToolEvidence} from './claim-citations.mjs';
import {retrieveComplete} from '../rag/complete-retrieval.mjs';
import {calculateLocal} from '../rag/calculators.mjs';
import {createPrivacyVault} from '../rag/privacy.mjs';
import {loadComparisonDataset,loadComparisonManifest} from './dataset.mjs';
import {prepareContext,attachRestorer} from './context.mjs';
import {createLocalTokenCounters} from '../server/token-counts.mjs';
import {recordEnvironment} from './hardware.mjs';
import {costStudyFingerprint,verifyAuditCorpus} from './cost-audit.mjs';
import {atomicJson,appendCheckpoint,readCheckpoints,retryItem,installTier0NetworkBoundary} from './runner.mjs';
import {scoreStage2Answer} from './stage2.mjs';
import {isCompanyItem} from './stage2-metrics.mjs';
import {isCloudEligible} from './policy.mjs';
import {acquireRunLock} from './run-lock.mjs';
import {sha256} from '../rag/receipts.mjs';
import {acceptanceSlice,evaluateAcceptanceGate,extractAcceptanceFeatures,partitionDevItems} from './acceptance-gates.mjs';
import {fitSliceCalibrators,applyRiskCalibrator} from './risk-calibration.mjs';
import {projectStage3Costs} from './stage3-costs.mjs';
import {summarizeStage3Acceptance,renderStage3Summary} from './stage3-report.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const optional=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const key=row=>`${row.modelId}|${row.id}`;
const serializable=value=>JSON.parse(JSON.stringify(value));
const retrievalStage=context=>({stage:'retrieval',modelId:'nomic-embed-text:v1.5',latencyMs:context.retrievalLatencyMs??0,tokens:{input:0,output:0,total:0},sharedMeasuredStage:true});

export function assertStage3BudgetUnset(env=process.env){if(env.CLOUD_BUDGET_USD!==undefined)throw new Error('Stage 3 requires CLOUD_BUDGET_USD to remain unset');}
export function assertLockedReplay(lock,calibration,{sourceHash,partitionHash}={}){
  if(!lock?.lockedAt||lock.policyHash!==sha256(calibration)||sourceHash&&lock.sourceHash!==sourceHash||partitionHash&&lock.partitionHash!==partitionHash)throw new Error('Frozen replay requires an unchanged durable dev-only policy lock');
  return true;
}
export function decorateAcceptance(item,row,prepared,{role,population}={}){
  const gate=evaluateAcceptanceGate(item,row,prepared),features=extractAcceptanceFeatures(item,row,prepared,gate);
  return{...row,id:item.id,groupId:item.groupId??item.id,category:item.category,suite:item.suite,safety:item.safety,safe:isCloudEligible(item),slice:acceptanceSlice(item),role,population,gate,features};
}
export function projectableRow(row,item,prepared){return{...row,item:{id:item.id,category:item.category,suite:item.suite,safety:item.safety},prepared};}

/** The dependency is deliberately invoked only AFTER the durable lock has been
 * re-read and checked. No test loading, scoring or threshold tuning precedes it. */
export async function replayAfterPolicyLock({lockFile,calibration,sourceHash,partitionHash,loadReplay}){
  const lock=JSON.parse(await readFile(lockFile,'utf8'));assertLockedReplay(lock,calibration,{sourceHash,partitionHash});
  const result=await loadReplay(lock);
  const after=JSON.parse(await readFile(lockFile,'utf8'));assertLockedReplay(after,calibration,{sourceHash,partitionHash});
  if(sha256(lock)!==sha256(after))throw new Error('Policy lock changed during frozen replay');return result;
}

export async function runStage3Study({runId='2026-10-28-stage3-dev-risk-calibration',dataDir=path.join(root,'.handoff'),log=event=>console.error(JSON.stringify(event))}={}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(runId))throw new Error('Invalid Stage 3 run ID');
  assertStage3BudgetUnset();
  const settings=JSON.parse(await readFile(path.join(root,'config/stage3.json'),'utf8'));
  if(settings.retrievalQualityThreshold!==.35||settings.structuredMaxTokens!==768||settings.selfCheckMaxTokens!==128||settings.serial!==true)throw new Error('Frozen Stage 2 retrieval/cap settings must be preserved');
  const privateDir=path.join(root,'.logs/stage3',runId),publicDir=path.join(root,'results',runId);
  await mkdir(privateDir,{recursive:true});
  const release=await acquireRunLock(path.join(privateDir,'run.lock'),{owner:{runId,purpose:'stage3-dev-local-only'}}),boundary=installTier0NetworkBoundary();
  const progress=async event=>{const row={at:new Date().toISOString(),runId,tier:0,cloudCalls:0,spendUsd:0,...event};await appendCheckpoint(path.join(privateDir,'progress.jsonl'),row);log(row);};
  try{
    const [manifest,datasetManifest,source,environment,counters,pricing]=await Promise.all([
      readFile(path.join(root,'tasks/comparison/stage3-manifest.json'),'utf8').then(JSON.parse),loadComparisonManifest(),costStudyFingerprint(),recordEnvironment(),createLocalTokenCounters(),loadPricing()]);
    // This is the sole dataset load before locking. Never request all/test/core.
    const items=await loadComparisonDataset({split:'dev-train'});
    if(items.length!==820||items.some(item=>!item.available))throw new Error('All 820 fixed dev items must be available locally');
    const partition=partitionDevItems(items,{seed:settings.seed,roles:settings.roles,expectedDevIds:datasetManifest.devTrainIDs});
    if(partition.assignmentHash!==manifest.partition.assignmentHash||sha256([...manifest.devTrainIDs].sort())!==partition.devIdsHash||manifest.settingsHash!==sha256(settings))throw new Error('Dev role manifest/settings changed');
    for(const modelId of settings.models)if(!environment.ollamaModels.some(model=>model.modelId===modelId))throw new Error('Required pinned local model is not installed');
    const vault=await createPrivacyVault(dataDir),corpus=await verifyAuditCorpus(dataDir,vault,datasetManifest);
    const identity={source:source.hash,settings:sha256(settings),manifest:sha256(manifest),partition:partition.assignmentHash,corpus:corpus.corpusHash,tokenizers:sha256(counters.metadata),models:settings.models.map(id=>[id,environment.ollamaModels.find(m=>m.modelId===id).digest])};
    const previous=await optional(path.join(privateDir,'study.json'));
    if(previous&&sha256(previous.identity)!==sha256(identity))throw new Error('Stage 3 resume refused: frozen code/settings/models/corpus changed');
    await atomicJson(path.join(privateDir,'study.json'),{identity,source,environment,settings,partition});
    await progress({phase:'start',devItems:items.length,modelOrder:settings.models,partitionHash:partition.assignmentHash,sourceHash:source.hash,budgetUnset:true});
    const countTokens=text=>Math.max(counters.countText('muse-spark',text),counters.countText('gemini',text)),contexts=new Map();
    for(const item of items){
      const file=path.join(privateDir,'contexts',sha256(item.id)+'.json');let saved=await optional(file);
      if(!saved){
        if(isCompanyItem(item)){
          vault.registerNames([...new Set(item.prompt.match(/\bCANARY-[A-Za-z0-9_-]+\b/gi)??[])]);const redacted=vault.redact(item.prompt);await vault.save();
          const found=await retryItem(()=>retrieveComplete(redacted.text,{dataDir,vault,topK:settings.retrievalTopK,tokenBudget:settings.retrievalTokenBudget,countTokens}));
          saved={...found,question:redacted.text,retrievalScore:found.bestMatchScore,sourceDocCount:new Set(found.chunks.map(chunk=>chunk.file)).size,retrievalLatencyMs:found.latencyMs,piiRedacted:redacted.count};
        }else saved=await prepareContext(item,{dataDir,vault});
        await atomicJson(file,saved);
      }
      contexts.set(item.id,await attachRestorer(saved,{dataDir,vault}));
      if(contexts.size%20===0||contexts.size===items.length)await progress({phase:'prepare',completed:contexts.size,total:items.length});
    }
    const contextHashes=Object.fromEntries([...contexts].map(([id,prepared])=>[id,sha256(serializable(prepared))]));
    const contextsLockFile=path.join(privateDir,'contexts-lock.json'),priorContextHashes=await optional(contextsLockFile);
    if(priorContextHashes&&sha256(priorContextHashes)!==sha256(contextHashes))throw new Error('Saved dev contexts changed; refusing mixed answers and evidence');
    await atomicJson(contextsLockFile,contextHashes);
    const rowFile=path.join(privateDir,'items.jsonl'),savedRows=new Map((await readCheckpoints(rowFile)).map(row=>[key(row),row]));
    for(const row of savedRows.values())if(!items.some(item=>item.id===row.id)||!settings.models.includes(row.modelId)||row.sourceHash!==source.hash||row.contextHash!==contextHashes[row.id])throw new Error('Checkpoint row is outside the frozen Stage 3 identity/context');
    const cacheCall=async(modelId,messages,options)=>{
      const hash=sha256({identity,modelId,messages,options}),file=path.join(privateDir,'local-steps',hash+'.json'),cached=await optional(file);if(cached)return cached.response;
      const response=await retryItem(()=>comparisonLocal(modelId,messages,options),{onRetry:event=>progress({phase:'retry',modelId,...event})});
      await atomicJson(file,{modelId,inputHash:sha256(messages),response});return response;
    };
    for(const modelId of settings.models){
      if(items.some(item=>!savedRows.has(`${modelId}|${item.id}`))){const warm=await retryItem(()=>comparisonLocal(modelId,[{role:'user',content:'Reply with OK.'}],{maxTokens:settings.warmupTokens,json:false}));await progress({phase:'warm-up',modelId,latencyMs:warm.latencyMs,excludedFromTimings:true});}
      for(const item of items){
        const rowKey=`${modelId}|${item.id}`,prepared=contexts.get(item.id),role=partition.assignments[item.id];
        if(!savedRows.has(rowKey)){
          let row;
          try{
            const tool=isCompanyItem(item)?calculateLocal(prepared.question,prepared.chunks):null;
            const generated=await generateLocalAnswer(modelId,prepared,{variant:'structured',item,answerMaxTokens:settings.structuredMaxTokens,requireClaimCitations:true,toolResult:tool?.status==='computed'?tool:undefined,dependencies:{call:cacheCall}});
            const augmented=generated.prepared??prepared,grading=scoreStage2Answer(item,generated.answer,prepared,{rawText:generated.rawAnswer.text,evidenceChunks:augmented.chunks});
            row=decorateAcceptance(item,{modelId,split:'dev',sourceSplit:'dev-train',variant:'structured',answer:generated.answer,...grading,rawAnswer:generated.rawAnswer,rawCheck:generated.rawCheck,toolResult:tool,runtimeCompleteness:prepared.completeness??null,stages:[retrievalStage(prepared),...generated.stages],sourceHash:source.hash,error:null},augmented,{role,population:`dev-${role}`});
          }catch{
            row=decorateAcceptance(item,{modelId,split:'dev',sourceSplit:'dev-train',variant:'structured',answer:{parseValid:false},scoring:{labelAvailable:false},stages:[],sourceHash:source.hash,error:'LOCAL_STAGE3_FAILED'},prepared,{role,population:`dev-${role}`});
          }
          row.contextHash=contextHashes[item.id];await appendCheckpoint(rowFile,row);savedRows.set(rowKey,row);
        }
        await progress({phase:'dev-local',modelId,itemId:item.id,completed:savedRows.size,total:items.length*settings.models.length,status:savedRows.get(rowKey).error?'error':'ok'});
      }
    }
    const devRows=[...savedRows.values()];
    const calibration=fitSliceCalibrators(devRows,{...settings,modelIds:settings.models,rolesById:partition.assignments,manifest:{devIds:manifest.devTrainIDs}});
    const policyHash=sha256(calibration),lockFile=path.join(privateDir,'policy-lock.json'),oldLock=await optional(lockFile);
    if(oldLock)assertLockedReplay(oldLock,calibration,{sourceHash:source.hash,partitionHash:partition.assignmentHash});
    const lock=oldLock??{version:1,lockedAt:new Date().toISOString(),policyHash,sourceHash:source.hash,partitionHash:partition.assignmentHash,devRowsHash:sha256(devRows),testLabelsUsed:false,futureCertified:false};
    await atomicJson(path.join(privateDir,'calibration.json'),calibration);await atomicJson(lockFile,lock);
    await progress({phase:'policy-locked',policyHash,devRows:devRows.length,testOpened:false});
    const devById=new Map(items.map(item=>[item.id,item]));
    const projectedDev=devRows.map(row=>projectableRow({...row,decision:applyRiskCalibrator(calibration,row),accepted:applyRiskCalibrator(calibration,row).accepted},devById.get(row.id),contexts.get(row.id)));
    // User approved saved-answer replay after lock. No new test inference.
    const replay=await replayAfterPolicyLock({lockFile,calibration,sourceHash:source.hash,partitionHash:partition.assignmentHash,loadReplay:async locked=>{
      await progress({phase:'frozen-replay-open',policyHash:locked.policyHash,policyLockedAt:locked.lockedAt});
      const originalReport=JSON.parse(await readFile(path.join(root,'results',settings.frozenReplayRun,'report.json'),'utf8'));
      for(const modelId of settings.models){const old=originalReport.environment.ollamaModels.find(model=>model.modelId===modelId),now=environment.ollamaModels.find(model=>model.modelId===modelId);if(!old||old.digest!==now.digest)throw new Error('Frozen replay model weights differ from dev generation');}
      const testManifest=JSON.parse(await readFile(path.join(root,'tasks/comparison/stage2-manifest.json'),'utf8')),ids=[...new Set(testManifest.cohorts.flatMap(cohort=>cohort.itemIds))];
      const testItems=await loadComparisonDataset({split:'test',ids}),testById=new Map(testItems.map(item=>[item.id,item]));
      const rows=await readCheckpoints(path.join(root,'.logs/stage2',settings.frozenReplayRun,'items.jsonl'));
      const selected=rows.filter(row=>row.phase==='after'&&testById.has(row.id)),out=[],hashes={};
      for(const modelId of settings.models)for(const cohort of testManifest.cohorts)for(const id of cohort.itemIds){
        const prior=selected.find(row=>row.modelId===modelId&&row.cohort===cohort.id&&row.id===id);if(!prior)throw new Error('Saved frozen comparison is incomplete');
        const item=testById.get(id),dir=isCompanyItem(item)?path.join(root,'.logs/stage2',settings.frozenReplayRun):path.join(root,'.logs/comparison-cost',settings.sourceContextRun);
        const text=await readFile(path.join(dir,'contexts',sha256(id)+'.json'),'utf8');hashes[id]=sha256(text);const prepared=JSON.parse(text);
        const augmented=prior.toolResult?.status==='computed'?attachToolEvidence(prepared,prior.toolResult).prepared:prepared;
        const decorated=decorateAcceptance(item,{...prior,beforeAccepted:prior.decision?.route==='local',split:'test'},augmented,{population:`frozen-${cohort.id}`});
        const decision=applyRiskCalibrator(calibration,decorated);out.push(projectableRow({...decorated,decision,accepted:decision.accepted},item,prepared));
      }
      return{rows:out,manifestHash:sha256(testManifest),contextHash:sha256(hashes),openedAfter:locked.lockedAt};
    }});
    const all=[...projectedDev,...replay.rows],acceptance=summarizeStage3Acceptance(all,{seed:settings.seed,replicates:settings.replicates});
    const costs=await projectStage3Costs(all,{pricing,counters,seed:settings.seed,replicates:400});
    await atomicJson(path.join(privateDir,'potential-cloud-payloads.json'),costs.privatePayloads);await atomicJson(path.join(privateDir,'token-counts.json'),costs.countRows);
    await atomicJson(path.join(privateDir,'decisions.json'),all.map(({item,prepared,...row})=>row));
    assertStage3BudgetUnset();assertLockedReplay(JSON.parse(await readFile(lockFile,'utf8')),calibration,{sourceHash:source.hash,partitionHash:partition.assignmentHash});
    if((await costStudyFingerprint()).hash!==source.hash)throw new Error('Source/settings changed during Stage 3 measurement');
    if((await verifyAuditCorpus(dataDir,vault,datasetManifest)).corpusHash!==corpus.corpusHash)throw new Error('Synthetic corpus changed during Stage 3');
    const {privatePayloads,countRows,...publicCosts}=costs;
    const report={schemaVersion:1,runId,timestamp:new Date().toISOString(),tier:0,status:devRows.some(row=>row.error)?'STAGE3_COMPLETE_WITH_ERRORS':'STAGE3_COMPLETE',cloudCalls:0,remoteCountingCalls:0,spendUsd:0,budgetUnset:true,network:boundary.status(),settings,source,environment,corpus,partition,calibration,policyHash,policyLock:lock,testReplayLocked:true,replay:{manifestHash:replay.manifestHash,contextHash:replay.contextHash,openedAfter:replay.openedAfter,rows:replay.rows.length,newInferenceCalls:0},acceptance,costs:publicCosts,contextHash:sha256(contextHashes),notes:['All 820 dev items are processed for each local model, with FIT/SELECT/CALIB/AUDIT roles fixed before generation.','Only company/general slices are calibrated. Full category reporting remains Stage 4.','Finite-frame risk certification does not imply a 5% guarantee for future questions or the final test.','Frozen Stage 2 answers are replayed after the durable lock, without fitting or changing thresholds.','All output cap, citation, self-check and inferred source-completeness gates apply before acceptance.','Pricing and projected output lengths remain assumptions; hidden provider framing/billing are unknown.']};
    await atomicJson(path.join(publicDir,'report.json'),report);await atomicJson(path.join(publicDir,'policy.json'),{policyHash,lock,calibration});await atomicJson(path.join(publicDir,'manifest.json'),{...manifest,identity,contextHash:sha256(contextHashes)});
    await writeFile(path.join(publicDir,'summary.md'),renderStage3Summary(report));await progress({phase:'complete',devRows:devRows.length,frozenRows:replay.rows.length,stopBeforeStage4:true});return report;
  }finally{boundary.restore();await release();}
}
