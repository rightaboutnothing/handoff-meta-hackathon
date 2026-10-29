import test from 'node:test';
import assert from 'node:assert/strict';
import {createCompanyMiddleware} from '../dashboard/server/company-data.mjs';

async function invoke(method,origin){
  let body,calledNext=false;const headers={};
  const res={statusCode:0,setHeader:(key,value)=>{headers[key]=value;},end:value=>{body=JSON.parse(value);}};
  await createCompanyMiddleware()({url:'/api/company/privacy-results',method,headers:origin?{origin}:{}},res,()=>{calledNext=true;});
  return{status:res.statusCode,body,headers,calledNext};
}
test('privacy results endpoint reads aggregate files with no model or network request',async()=>{
  const before=globalThis.fetch;globalThis.fetch=()=>{throw Error('NETWORK_NOT_ALLOWED_IN_REPORT_VIEW');};
  try{
    const response=await invoke('GET');assert.equal(response.status,200);assert.equal(response.calledNext,false);assert.equal(response.headers['Cache-Control'],'no-store');
    if(response.body){assert.equal(response.body.kind,'privacy-results-dashboard');assert.equal(response.body.cloudCalls,0);assert.equal(response.body.liveDispatchEnabled,false);assert.doesNotMatch(JSON.stringify(response.body),/"(?:prompt|output|raw|payload|tokens|privateValues)"\s*:/);}
  }finally{globalThis.fetch=before;}
});
test('privacy results endpoint rejects sends and untrusted origins before reading a request body',async()=>{
  for(const method of ['POST','PUT','DELETE']){const response=await invoke(method);assert.equal(response.status,405);assert.deepEqual(response.body,{error:'Saved privacy results are read-only'});}
  const response=await invoke('GET','https://example.invalid');assert.equal(response.status,403);
});
