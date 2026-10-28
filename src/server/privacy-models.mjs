import {performance} from 'node:perf_hooks';
import {readFile} from 'node:fs/promises';

export async function privacyModelSettings(){return JSON.parse(await readFile(new URL('../../config/stage6b.json',import.meta.url),'utf8'));}
export async function callLensModel(lens,messages,{schema,maxTokens}={}){
  const settings=await privacyModelSettings();if(!['meta','google'].includes(lens))throw Error('Unknown privacy lens');
  const {localChat}=await import('./gateway-models.mjs');
  return localChat(settings[lens].rewriteModel,messages,{schema,maxTokens:maxTokens??settings.checkMaxTokens});
}
/** Uses the installed ShieldGemma 1 text template, not image-only ShieldGemma 2. */
export async function screenLensHarmful(lens,input,answer){
  const settings=await privacyModelSettings(),started=performance.now();
  if(lens==='meta'){const {guardText}=await import('./gateway-models.mjs');return guardText(input,answer);}
  if(lens!=='google')throw Error('Unknown privacy lens');
  try{
    const {localChat}=await import('./gateway-models.mjs');
    const result=await localChat(settings.google.guardModel,[{role:'user',content:input},...(answer===undefined?[]:[{role:'assistant',content:answer}])],{maxTokens:settings.google.guardMaxTokens});
    const match=/^\s*(Yes|No)\b[.,:]?/i.exec(result.text),truncated=result.doneReason==='length'||result.tokens.output>=settings.google.guardMaxTokens;
    const classification=truncated||!match?'invalid':match[1].toLowerCase()==='no'?'safe':'unsafe';
    return{...result,safe:classification==='safe',classification,direction:answer===undefined?'outbound':'inbound',categories:[],policyProtocol:'Installed official ShieldGemma 1 text User/Chatbot policy template; Yes/No prefix; truncation fails closed'};
  }catch{return{safe:false,classification:'unavailable',modelId:settings.google.guardModel,latencyMs:performance.now()-started,tokens:{input:0,output:0,total:0},categories:[]};}
}
