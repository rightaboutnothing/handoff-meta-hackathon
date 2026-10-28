/** Every stress item is local-only even when a future live flag is enabled. */
export function installStage6NetworkBoundary({modelId='llama-guard3:8b',phase='guard'}={}){
  if(!['guard','translation'].includes(phase)||modelId!==(phase==='guard'?'llama-guard3:8b':'gemma3:12b'))throw Error('Unsupported Stage 6 local phase');
  const original=globalThis.fetch,counts={localRequests:0,guardCalls:0,translationCalls:0,metadataRequests:0,externalRequests:0,blockedExternalRequests:0,blockedOtherLocalRequests:0};
  globalThis.fetch=async(input,options={})=>{
    const url=new URL(typeof input==='string'||input instanceof URL?input:input.url),method=String(options.method??'GET').toUpperCase();
    if(url.protocol!=='http:'||!['localhost','127.0.0.1','[::1]'].includes(url.hostname)||url.port!=='11434'||url.username||url.password){counts.blockedExternalRequests++;throw Error('Stage 6 external request structurally denied');}
    let allowed=method==='GET'&&['/api/tags','/api/version'].includes(url.pathname);
    if(method==='POST'&&['/api/generate','/api/chat','/api/show'].includes(url.pathname)){
      let body;try{body=JSON.parse(options.body);}catch{}
      const common=body?.model===modelId&&(url.pathname==='/api/show'||body.stream===false&&body.keep_alive===-1&&body.options?.temperature===0&&body.options?.seed===20261027&&body.options?.num_ctx===4096);
      allowed=common&&(url.pathname==='/api/show'||phase==='guard'&&url.pathname==='/api/generate'&&body.raw===true&&body.options?.num_predict===40||phase==='translation'&&url.pathname==='/api/chat'&&body.options?.num_predict===384);
    }
    if(!allowed||url.search){counts.blockedOtherLocalRequests++;throw Error('Unexpected Stage 6 local model or protocol denied');}
    counts.localRequests++;if(url.pathname==='/api/generate')counts.guardCalls++;else if(url.pathname==='/api/chat')counts.translationCalls++;else counts.metadataRequests++;
    return original(input,{...options,redirect:'error'});
  };
  return{restore(){globalThis.fetch=original;},status:()=>({...counts})};
}
