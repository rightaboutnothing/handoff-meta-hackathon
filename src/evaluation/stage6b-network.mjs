const allowedModels=new Set(['llama3.2:3b','gemma3:4b','llama-guard3:8b','shieldgemma:2b']);
import {sha256} from '../rag/receipts.mjs';
/** A test corpus never obtains a route to an external model, under any flag. */
export function installStage6bNetworkFence({onRequest=async()=>{}}={}){
  const original=globalThis.fetch,counts={localRequests:0,metadataRequests:0,modelCalls:0,externalRequests:0,blockedExternalRequests:0,blockedLocalRequests:0,byModel:{}};
  globalThis.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url),method=String(options.method??'GET').toUpperCase();
    if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='11434'||url.username||url.password){counts.blockedExternalRequests++;await onRequest({at:new Date().toISOString(),kind:'external_denied'});throw Object.assign(Error('Stage 6b external request denied'),{code:'STAGE6B_NETWORK_DENIED'});}
    let allowed=method==='GET'&&['/api/tags','/api/version'].includes(url.pathname),model;
    if(method==='POST'&&['/api/chat','/api/generate','/api/show'].includes(url.pathname)){
      let body;try{body=JSON.parse(options.body);}catch{}
      model=body?.model;
      allowed=allowedModels.has(model)&&(url.pathname==='/api/show'||body.stream===false&&body.keep_alive===-1&&body.options?.temperature===0&&body.options?.seed===20261027&&Number.isInteger(body.options?.num_predict)&&body.options.num_predict>0&&body.options.num_predict<=2048&&Number.isInteger(body.options?.num_ctx)&&body.options.num_ctx<=8192);
    }
    if(!allowed||url.search||new Headers(options.headers).has('Authorization')){counts.blockedLocalRequests++;await onRequest({at:new Date().toISOString(),kind:'local_denied'});throw Object.assign(Error('Stage 6b local protocol denied'),{code:'STAGE6B_LOCAL_PROTOCOL_DENIED'});}
    counts.localRequests++;
    if(['/api/chat','/api/generate'].includes(url.pathname)){counts.modelCalls++;counts.byModel[model]=(counts.byModel[model]??0)+1;}else counts.metadataRequests++;
    await onRequest({at:new Date().toISOString(),kind:['/api/chat','/api/generate'].includes(url.pathname)?'local_model':'local_metadata',modelId:model??null,requestHash:sha256(options.body??url.pathname)});
    return original(input,{...options,redirect:'error'});
  };
  return{restore(){globalThis.fetch=original;},status:()=>structuredClone(counts)};
}

/** Prompt-Guard-only replay is a local file/worker operation: no HTTP at all. */
export function installStage6bNoNetworkFence(){
  const original=globalThis.fetch;let denied=0;
  globalThis.fetch=async()=>{denied++;throw Object.assign(Error('Prompt Guard replay cannot access any network or other model'),{code:'STAGE6B_REPLAY_NETWORK_DENIED'});};
  return{restore(){globalThis.fetch=original;},status:()=>({networkRequests:0,deniedRequests:denied})};
}
