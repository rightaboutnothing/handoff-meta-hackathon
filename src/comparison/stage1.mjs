import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile,mkdir} from 'node:fs/promises';
import {comparisonLocal,COMPARISON_SETTINGS} from '../server/comparison-models.mjs';
import {generateLocalAnswer,extractPlainCitations,LOCAL_ANSWER_SETTINGS} from './local-answer.mjs';
import {validateCitations} from './citations.mjs';
import {loadComparisonDataset} from './dataset.mjs';
import {attachRestorer} from './context.mjs';
import {createPrivacyVault} from '../rag/privacy.mjs';
import {scoreItem} from './scoring.mjs';
import {gradeBlindAnswer} from '../scoring/second-grader.mjs';
import {isCloudEligible} from './policy.mjs';
import {recordEnvironment} from './hardware.mjs';
import {atomicJson,appendCheckpoint,readCheckpoints,retryItem,routeLocal,installTier0NetworkBoundary} from './runner.mjs';
import {costStudyFingerprint,plainPrompt} from './cost-audit.mjs';
import {acquireRunLock} from './run-lock.mjs';
import {summarizeStage1,renderStage1Summary} from './stage1-report.mjs';
import {sha256} from '../rag/receipts.mjs';

const root=fileURLToPath(new URL('../../',import.meta.url));
const settings=JSON.parse(await readFile(new URL('../../config/stage1-answer.json',import.meta.url),'utf8'));
const company=item=>item.category.startsWith('company-data');
const optional=async file=>{try{return JSON.parse(await readFile(file,'utf8'));}catch(error){if(error.code==='ENOENT')return null;throw error;}};
const rowKey=row=>`${row.phase}|${row.cohort}|${row.modelId}|${row.id}`;
export function stage1Route(item,answer,classifier){
  const decision=routeLocal(item,answer,classifier);
  if(answer.routingSource&&answer.needsCloud&&decision.route!=='local_only_safety')return{...decision,reason:'Code requires assistance after local self-check, answer parsing or citation validation'};
  return decision;
}
export function scoreStage1Answer(item,answer,prepared,{rawText=answer.answer}={}){
  const allowed=new Set(prepared.chunks.map(chunk=>chunk.chunkId));
  if((answer.citations??[]).some(citation=>!allowed.has(citation.chunkId)))throw new Error('Only retrieved, validated citation IDs may enter scoring');
  const text=prepared.restore(answer.answer),scoring=scoreItem(item,{answer:text,citations:answer.citations,status:'ok',route:'local'});
  const secondScore=gradeBlindAnswer(item,{answerText:text,rawText:prepared.restore(rawText),parseValid:answer.parseValid});
  return{scoring,secondScore,groundedFullCredit:scoring.labelAvailable&&scoring.score===1&&(!company(item)||(answer.citationAudit?.grounded&&!answer.citationAudit?.rejectedIds?.length))};
}
/** Normalize before/after scorer text identically, retaining the original saved
 * scoring and citation audit separately. No reference enters either local call. */
export function baselineStage1Row(item,record,prepared,{modelId,cohort,baselineSource='saved_previous_run'}={}){
  const original=record.answer??{},isPlain=cohort==='plain50';
  const parsed=isPlain?extractPlainCitations(record.raw?.text??original.answer??'',prepared,{company:company(item)}):{answer:original.answer??'',citations:original.citations??[]};
  // The historical plain parser treated every bracket as a citation. Preserve
  // that actual pre-validation audit instead of making its old errors vanish.
  const rawCitations=original.citations??parsed.citations;
  const citationAudit=validateCitations(rawCitations,prepared,{requireCitations:company(item)});
  const answer={...original,answer:parsed.answer,citations:citationAudit.citations,citationAudit,parseValid:isPlain?true:original.parseValid!==false};
  const grading=scoreStage1Answer(item,answer,prepared,{rawText:record.raw?.text??answer.answer});
  return{id:item.id,groupId:item.groupId,category:item.category,safe:isCloudEligible(item),company:company(item),cohort,modelId,phase:'before',baselineSource,answer,...grading,
    historicalScoring:record.scoring??null,error:record.error??null,stages:record.raw?[{stage:'legacy_local_answer',modelId,latencyMs:record.raw.latencyMs,tokens:record.raw.tokens}]:[]};
}

export async function runStage1Study({runId='2026-10-28-stage1-answer-citations',dataDir=path.join(root,'.handoff'),log=event=>console.error(JSON.stringify(event))}={}){
  if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(runId))throw new Error('Invalid Stage 1 run ID');
  const privateDir=path.join(root,'.logs/stage1',runId),publicDir=path.join(root,'results',runId);
  await mkdir(privateDir,{recursive:true});
  const release=await acquireRunLock(path.join(privateDir,'run.lock'),{owner:{runId,purpose:'stage1-local-answer-citations'}}),boundary=installTier0NetworkBoundary();
  const progress=async event=>{const value={at:new Date().toISOString(),runId,tier:0,cloudCalls:0,spendUsd:0,...event};await appendCheckpoint(path.join(privateDir,'progress.jsonl'),value);log(value);};
  try{
    if(settings.answerMaxTokens!==LOCAL_ANSWER_SETTINGS.answerMaxTokens||settings.selfCheckMaxTokens!==LOCAL_ANSWER_SETTINGS.selfCheckMaxTokens||settings.seed!==COMPARISON_SETTINGS.seed)throw new Error('Stage 1 generation settings differ from the declared contract');
    const [manifest,previous,environment,source]=await Promise.all([
      readFile(path.join(root,'tasks/comparison/stage1-manifest.json'),'utf8').then(JSON.parse),
      readFile(path.join(root,'results',settings.controlRun,'report.json'),'utf8').then(JSON.parse),recordEnvironment(),costStudyFingerprint()]);
    const classifiers=previous.classifiers,thresholds=Object.fromEntries(settings.models.map(id=>[id,classifiers[id].threshold]));
    for(const modelId of settings.models){const before=previous.environment.ollamaModels.find(model=>model.modelId===modelId),after=environment.ollamaModels.find(model=>model.modelId===modelId);if(!before||!after||before.digest!==after.digest)throw new Error('Installed model weights differ from the previous study');}
    const ids=[...new Set(manifest.cohorts.flatMap(cohort=>cohort.itemIds))],items=await loadComparisonDataset({split:'test',ids}),byId=new Map(items.map(item=>[item.id,item]));
    if(ids.some(id=>!byId.get(id)?.available))throw new Error('All saved items must be available from accepted local caches before inference');
    const vault=await createPrivacyVault(dataDir),contexts=new Map(),contextHashes={};
    for(const id of ids){const file=path.join(root,'.logs/comparison-cost',settings.controlRun,'contexts',sha256(id)+'.json'),text=await readFile(file,'utf8'),prepared=JSON.parse(text);if(typeof prepared.question!=='string'||!Array.isArray(prepared.chunks))throw new Error('Saved context is malformed');contextHashes[id]=sha256(text);contexts.set(id,await attachRestorer(prepared,{dataDir,vault}));}
    const baselineDataHash=sha256(await Promise.all([
      readFile(path.join(root,'.logs/comparison',settings.baselineRun,'local.jsonl'),'utf8'),
      readFile(path.join(root,'.logs/comparison-cost',settings.controlRun,'audit-plain.jsonl'),'utf8')]));
    const identity={sourceHash:source.hash,settingsHash:sha256(settings),manifestHash:sha256(manifest),classifierHash:sha256(classifiers),contextHash:sha256(contextHashes),baselineDataHash,models:environment.ollamaModels.map(row=>[row.modelId,row.digest]).sort()};
    const oldState=await optional(path.join(privateDir,'study.json'));
    if(oldState&&sha256(oldState.identity)!==sha256(identity))throw new Error('Stage 1 resume denied: code, settings, contexts, model versions or frozen classifiers changed');
    await atomicJson(path.join(privateDir,'study.json'),{identity,source,environment,thresholds});
    const priorOriginal=await readCheckpoints(path.join(root,'.logs/comparison',settings.baselineRun,'local.jsonl')),
      priorPlain=await readCheckpoints(path.join(root,'.logs/comparison-cost',settings.controlRun,'audit-plain.jsonl')),
      outputFile=path.join(privateDir,'items.jsonl'),saved=new Map((await readCheckpoints(outputFile)).map(row=>[rowKey(row),row]));
    const prior=new Map([...priorOriginal.map(row=>[`${row.modelId}|saved60|${row.id}`,row]),...priorPlain.map(row=>[`${row.modelId}|plain50|${row.id}`,row])]);
    for(const modelId of settings.models)for(const cohort of manifest.cohorts)for(const id of cohort.itemIds)if(!prior.has(`${modelId}|${cohort.id}|${id}`)&&!(modelId==='gemma3:4b'&&cohort.id==='plain50'))throw new Error('Saved prior-method baseline is missing; do not silently shrink the experiment');
    const cacheCall=async(modelId,messages,options)=>{
      const key=sha256({identity,modelId,messages,options}),file=path.join(privateDir,'local-steps',key+'.json'),cached=await optional(file);if(cached)return cached.response;
      const response=await retryItem(()=>comparisonLocal(modelId,messages,options),{onRetry:event=>progress({phase:'retry',modelId,stageHash:key,...event})});
      await atomicJson(file,{modelId,inputHash:sha256(messages),optionsHash:sha256(options),response});return response;
    };
    for(const modelId of settings.models){
      const hasWork=manifest.cohorts.some(cohort=>cohort.itemIds.some(id=>!saved.has(`after|${cohort.id}|${modelId}|${id}`)||!saved.has(`before|${cohort.id}|${modelId}|${id}`)&&!prior.has(`${modelId}|${cohort.id}|${id}`)));
      if(hasWork){const warm=await retryItem(()=>comparisonLocal(modelId,[{role:'user',content:'Reply with OK.'}],{maxTokens:8,json:false}));await progress({phase:'warm-up',modelId,latencyMs:warm.latencyMs,excludedFromTimings:true});}
      for(const cohort of manifest.cohorts){let completed=0;
        for(const id of cohort.itemIds){const item=byId.get(id),prepared=contexts.get(id),beforeKey=`before|${cohort.id}|${modelId}|${id}`,afterKey=`after|${cohort.id}|${modelId}|${id}`;
          if(!saved.has(beforeKey)){
            let row;
            try{
            let record=prior.get(`${modelId}|${cohort.id}|${id}`),baselineSource='saved_previous_run';
            if(!record){if(modelId!=='gemma3:4b'||cohort.id!=='plain50')throw new Error('Unexpected missing saved baseline');baselineSource='replayed_previous_method';const raw=await cacheCall(modelId,[{role:'user',content:plainPrompt(prepared)}],{maxTokens:settings.answerMaxTokens,json:false});const citations=[...new Set([...raw.text.matchAll(/\[([^\]\n]+)\]/g)].map(match=>match[1]))];record={raw,answer:{answer:raw.text,citations,parseValid:true}};}
            row=baselineStage1Row(item,record,prepared,{modelId,cohort:cohort.id,baselineSource});
            }catch{row={id,groupId:item.groupId,category:item.category,safe:isCloudEligible(item),company:company(item),cohort:cohort.id,modelId,phase:'before',baselineSource:modelId==='gemma3:4b'&&cohort.id==='plain50'?'replayed_previous_method':'saved_previous_run',error:'BASELINE_STAGE1_FAILED',scoring:{labelAvailable:false},secondScore:{labelAvailable:false},answer:{},stages:[]};}
            row.sourceHash=source.hash;await appendCheckpoint(outputFile,row);saved.set(beforeKey,row);
          }
          if(!saved.has(afterKey)){let row;
            try{const generated=await generateLocalAnswer(modelId,prepared,{variant:cohort.variant,item,dependencies:{call:cacheCall}}),grading=scoreStage1Answer(item,generated.answer,prepared,{rawText:generated.rawAnswer.text}),decision=stage1Route(item,generated.answer,classifiers[modelId]);
              row={id,groupId:item.groupId,category:item.category,safe:isCloudEligible(item),company:company(item),cohort:cohort.id,modelId,phase:'after',answer:generated.answer,...grading,decision,stages:generated.stages,rawAnswer:generated.rawAnswer,rawCheck:generated.rawCheck,error:null,sourceHash:source.hash,environmentHash:environment.sha256};
            }catch{row={id,groupId:item.groupId,category:item.category,safe:isCloudEligible(item),company:company(item),cohort:cohort.id,modelId,phase:'after',error:'LOCAL_STAGE1_FAILED',scoring:{labelAvailable:false},secondScore:{labelAvailable:false},answer:{parseValid:false,selfCheckParseValid:false},stages:[],sourceHash:source.hash};}
            await appendCheckpoint(outputFile,row);saved.set(afterKey,row);
          }
          completed++;await progress({phase:'local-stage1',modelId,cohort:cohort.id,completed,total:cohort.itemIds.length,itemId:id,status:saved.get(afterKey).error?'error':'ok'});
        }
      }
    }
    const records=[...saved.values()],summary=summarizeStage1(manifest.cohorts,records,{modelIds:settings.models,manifest,thresholds});
    const endSource=await costStudyFingerprint();if(endSource.hash!==source.hash)throw new Error('Code/settings changed during Stage 1; mixed results will not be published');
    if(sha256(classifiers)!==identity.classifierHash)throw new Error('Frozen classifiers changed during Stage 1');
    const report={schemaVersion:1,runId,timestamp:new Date().toISOString(),tier:0,status:records.some(row=>row.error)?'STAGE1_COMPLETE_WITH_ERRORS':'STAGE1_COMPLETE',cloudCalls:0,spendUsd:0,remoteCountingCalls:0,network:boundary.status(),settings:{...settings,localAnswer:LOCAL_ANSWER_SETTINGS,comparison:COMPARISON_SETTINGS},source,thresholds,classifierHashes:Object.fromEntries(settings.models.map(id=>[id,sha256(classifiers[id])])),environment,manifestHash:identity.manifestHash,contextHash:identity.contextHash,savedContextFrozen:true,calibrationChanged:false,summary,
      notes:['Stage 1 changes answer generation, self-check and citation validation only. Retrieval and all calibration coefficients/thresholds are frozen.','Old Gemma 4B plain50 baseline is a newly measured prior-method replay, not a saved previous run.','Both answer and self-check latency/tokens are counted; warm-ups are separate.','Raw invalid citations are measured before validation; rejected IDs cannot be passed to scoring or routing as valid.','Full credit is automated rubric coverage; the independent deterministic method is not expert semantic gold.','The next stage is retrieval completeness. Do not proceed without a later instruction.']};
    await atomicJson(path.join(publicDir,'report.json'),report);await atomicJson(path.join(publicDir,'manifest.json'),{...manifest,source,contextHashes,classifierHash:identity.classifierHash,thresholds});
    await (await import('node:fs/promises')).writeFile(path.join(publicDir,'summary.md'),renderStage1Summary(report));
    await progress({phase:'complete',afterRows:records.filter(row=>row.phase==='after').length,stopBeforeStage2:true});return report;
  }finally{boundary.restore();await release();}
}
