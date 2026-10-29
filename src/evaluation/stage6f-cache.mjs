import {sha256} from '../rag/receipts.mjs';
const clean=value=>typeof value==='string'&&/^[A-Za-z0-9_.:-]{1,200}$/.test(value);
export function stage6fRecordScope({phase,itemId,lens='shared',mode='default',sourceHash=null}){
  if(![phase,itemId,lens,mode].every(clean)||sourceHash!==null&&!/^[a-f0-9]{64}$/.test(sourceHash))throw Error('STAGE6F_RECORD_SCOPE_INVALID');
  return Object.freeze({phase,itemId,lens,mode,sourceHash});
}
/** Scope changes the local checkpoint identity, never the model's messages. */
export function stage6fInvocationIdentity(scope,lens,messages,options={}){
  if(!scope||!Object.isFrozen(scope)||!clean(lens)||!Array.isArray(messages)||options.cacheScope!==undefined&&!/^[a-f0-9]{64}$/.test(options.cacheScope))throw Error('STAGE6F_INVOCATION_SCOPE_INVALID');
  stage6fRecordScope(scope);
  return sha256({scope,lens,messages,options});
}
export function stage6fTransportOptions(options={}){
  if(options.cacheScope!==undefined&&!/^[a-f0-9]{64}$/.test(options.cacheScope))throw Error('STAGE6F_CACHE_SCOPE_INVALID');
  const {cacheScope,...transport}=options;return transport;
}
