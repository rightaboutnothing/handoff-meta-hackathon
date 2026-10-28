import {readFile,readdir} from 'node:fs/promises';
import {createReadStream} from 'node:fs';
import {createHash} from 'node:crypto';
import path from 'node:path';
import {sha256} from '../rag/receipts.mjs';
import {STAGE6B_ROOT,stage6bPrivateRoot,readStage6bJson,durableStage6bJson} from './stage6b-io.mjs';
import {STAGE6B_SETUPS,summarizeStage6bSetup} from './stage6b-metrics.mjs';
import {installStage6bNoNetworkFence} from './stage6b-network.mjs';

export function replayPromptGuardDecision(row,result){
  const reasons=(row.blockedByLayer??[]).filter(reason=>!reason.startsWith('PROMPT_GUARD_'));
  if(result.status!=='PASS')reasons.push(result.status==='BLOCKED'?'PROMPT_GUARD_BLOCKED':'PROMPT_GUARD_PENDING');
  const detections={...row.availableDetections,injection:result.detected===true};
  return{...row,hypotheticalBlocked:reasons.length>0,detectedBlock:Object.values(detections).some(value=>value===true),availableDetections:detections,pendingInjection:result.status==='PENDING',blockedByLayer:reasons,stages:(row.stages??[]).filter(stage=>!stage.layerId?.startsWith('prompt_guard_')).map(stage=>({...stage,reused:true})).concat([{layerId:'prompt_guard_86m',status:result.status,available:result.available,detected:result.detected,modelId:result.modelId,latencyMs:result.latencyMs}]),actualCloudCalls:0};
}
async function fileHash(file){const hash=createHash('sha256');for await(const bytes of createReadStream(file))hash.update(bytes);return hash.digest('hex');}
async function modelFiles(){
  const config=await readStage6bJson(path.join(STAGE6B_ROOT,'config/stage6b.json')),out={};
  for(const [variant,model]of Object.entries(config.promptGuard.variants)){
    const directory=path.resolve(STAGE6B_ROOT,model.directory),names=await readdir(directory).catch(()=>[]),files={};
    for(const name of names.filter(name=>/^(?:config|tokenizer|tokenizer_config|special_tokens_map)\.json$|\.safetensors$/.test(name)))files[name]=await fileHash(path.join(directory,name));
    out[variant]={modelId:model.modelId,files,status:names.includes('config.json')&&names.some(name=>name.endsWith('.safetensors'))?'LOCAL_FILES_PRESENT':'PENDING'};
  }return out;
}
/** Reruns only Prompt Guard from retained private inputs. No rewrite, strict
 * scanner, redaction, harmful guard, surrogate or application model is called. */
export async function rerunStage6bPromptGuard({runId,adapter,log=event=>console.error(JSON.stringify(event))}={}){
  const root=STAGE6B_ROOT,pointer=await readStage6bJson(path.join(root,'results/stage6b-latest.json'));
  runId??=pointer.directory;if(runId!==pointer.directory||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(runId))throw Error('Prompt Guard replay must name the retained run');
  const body=await readFile(path.join(root,'results',runId,'report.json'),'utf8');if(sha256(body)!==pointer.reportSha256)throw Error('Original Stage 6b report hash changed');
  const original=JSON.parse(body),directory=path.join(stage6bPrivateRoot(root),'runs',runId),state=await readStage6bJson(path.join(directory,'study.json')),retained=await readStage6bJson(path.join(directory,'final-rows.json'));
  if(retained.identity!==sha256(state.identity))throw Error('Retained private decision identity changed');
  const fence=installStage6bNoNetworkFence(),{screenPromptGuardInputs,closePromptGuardWorkers}=await import('../privacy/prompt-guard.mjs');
  try{
    const classify=adapter??screenPromptGuardInputs,assets=await modelFiles(),replayed={},items=[];
    for(const descriptor of STAGE6B_SETUPS.filter(row=>row.injectionRequired)){
      const rows=[],sourceRows=retained.setups[descriptor.id];
      for(const row of sourceRows){
        const phase=row.area==='inbound'?'incoming-prepared-':'prepared-',snapshot=await readStage6bJson(path.join(directory,phase+descriptor.lens,sha256(row.id)+'.json'));
        if(snapshot.identity!==retained.identity)throw Error('Prompt Guard input snapshot identity changed');
        const value=snapshot.value,prepared=row.area==='inbound'?value.prepared:value;
        if(prepared.sourceHash!==row.sourceHash||prepared.questionHash!==row.questionHash||sha256(prepared.sourceText)!==row.sourceHash)throw Error('Retained original or rewritten question changed');
        const texts=row.area==='inbound'?(value.injectionScanTexts??[value.text]):prepared.injectionScanTexts;
        if(!Array.isArray(texts)||!texts.length||texts.some(text=>typeof text!=='string'))throw Error('Retained Prompt Guard variants missing');
        const result86=await classify(texts,{size:'86m'}),result22=await classify(texts,{size:'22m'});
        const replayedRow=replayPromptGuardDecision(row,result86);replayedRow.stages.push({layerId:'prompt_guard_22m',status:result22.status,available:result22.available,detected:result22.detected,modelId:result22.modelId,latencyMs:result22.latencyMs});rows.push(replayedRow);items.push({id:row.id,area:row.area,setup:descriptor.id,inputHash:sha256(texts),variants:texts.length,model86m:result86,model22m:result22});
        if(rows.length%25===0||rows.length===sourceRows.length)log({phase:'prompt-guard-only',setup:descriptor.id,completed:rows.length,total:sourceRows.length,cloudCalls:0});
      }
      replayed[descriptor.id]=summarizeStage6bSetup(descriptor,rows,{quality:original.setups.find(row=>row.id===descriptor.id).quality,countryRecall:original.setups.find(row=>row.id===descriptor.id).countryRecall});
    }
    const timestamp=new Date().toISOString(),replayId=timestamp.replace(/[:.]/g,'-'),report={schemaVersion:1,kind:'stage6b-prompt-guard-only-replay',runId,timestamp,tier:0,cloudCalls:0,spendUsd:0,originalReportHash:pointer.reportSha256,upstreamIdentity:retained.identity,assets,network:fence.status(),setups:Object.values(replayed),items,notes:['Only Prompt Guard was rerun. Frozen rewrite, strict-rule, LLM check, tokenisation, harmful-content, local application and country-recall results were reused.','The 22M model is comparison-only; the 86M decision is the required operational injection layer.','Both setup rows remain local-only and no report grants a cloud release permit.','Real cloud answer quality remains deferred.']};
    await durableStage6bJson(path.join(root,'results',runId,'prompt-guard-replays',replayId+'.json'),report);return report;
  }finally{closePromptGuardWorkers();fence.restore();}
}
