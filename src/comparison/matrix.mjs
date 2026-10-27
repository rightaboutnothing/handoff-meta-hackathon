import { readFile } from 'node:fs/promises';
export const comparisonConfig=JSON.parse(await readFile(new URL('../../config/comparison.json',import.meta.url),'utf8'));
export function buildPipelineMatrix(config=comparisonConfig){
  const rows=[];
  for(const local of config.localModels)for(const guard of config.guards)for(const cloud of config.clouds){
    const id=`${local.id}+${guard.id}+${cloud.id}`;
    rows.push({id,name:id===config.heroPipelineId?'Finkd':`${local.name} / ${guard.name} / ${cloud.name}`,kind:'hybrid',localId:local.id,localModelId:local.modelId,parametersB:local.parametersB,family:local.family,guardId:guard.id,guardModelId:guard.modelId,cloudId:cloud.providerId,cloudName:cloud.name,hero:id===config.heroPipelineId});
  }
  for(const local of config.localModels)rows.push({id:`${local.id}+local-only`,name:`${local.name} / Local-only`,kind:'local-only',localId:local.id,localModelId:local.modelId,parametersB:local.parametersB,family:local.family,guardId:null,guardModelId:null,cloudId:null,cloudName:null});
  for(const cloud of config.clouds)rows.push({id:`cloud-only+${cloud.id}`,name:`${cloud.name} / Cloud-only (safe)`,kind:'cloud-only',localId:null,localModelId:null,parametersB:null,family:cloud.providerId==='muse-spark'?'Meta':'Google',guardId:null,guardModelId:null,cloudId:cloud.providerId,cloudName:cloud.name,safeOnly:true});
  for(const local of config.localModels)for(const cloud of config.clouds)rows.push({id:`${local.id}+guard-off+${cloud.id}`,name:`${local.name} / Guard OFF / ${cloud.name} (safe)`,kind:'guard-off',localId:local.id,localModelId:local.modelId,parametersB:local.parametersB,family:local.family,guardId:null,guardModelId:null,cloudId:cloud.providerId,cloudName:cloud.name,safeOnly:true});
  return rows;
}
