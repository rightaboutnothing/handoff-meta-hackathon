import test from 'node:test';
import assert from 'node:assert/strict';
import {localChat} from '../src/server/gateway-models.mjs';

test('local HTTP failures retain status and request identity without reading a response body or retrying',async()=>{
  const original=globalThis.fetch;let calls=0,bodyReads=0;
  globalThis.fetch=async()=>{calls++;return{ok:false,status:503,json:async()=>{bodyReads++;throw Error('Backend body must remain private');},text:async()=>{bodyReads++;throw Error('Backend body must remain private');}};};
  try{await assert.rejects(localChat('authored-local-model',[{role:'user',content:'An authored benign task.'}],{maxTokens:50}),error=>error.code==='LOCAL_HTTP_ERROR'&&error.status===503&&error.modelId==='authored-local-model'&&/^[a-f0-9]{64}$/.test(error.requestHash)&&error.message==='LOCAL_HTTP_ERROR'&&Number.isFinite(error.latencyMs));assert.equal(calls,1);assert.equal(bodyReads,0);}finally{globalThis.fetch=original;}
});
