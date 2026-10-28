import {prepareQuestionOnly,screenQuestionOnly,checkIncomingAnswer,applyAnswerLocally} from '../../src/privacy/question-boundary.mjs';
import path from 'node:path';

export const GENERAL_TEST_QUESTION='How can a fictional private sales report be analyzed?';
function syntheticQuestion(task){
  if(typeof task!=='string')return GENERAL_TEST_QUESTION;
  let text=task.trim().replace(/[.;]\s+(?:[A-Za-z_ ]+|\[[^\r\n:]+\])\s*:\s*.*$/,'').replace(/[.!]+$/,'').replace(/\b[A-Za-z]+\d+[A-Za-z0-9]*\b/g,'[PRODUCT]');if(text.endsWith('?'))return text;
  const verbs={analyze:'analyzed',summarize:'summarized',explain:'explained',compare:'compared',calculate:'calculated',describe:'described',list:'listed',draft:'drafted',write:'written'};
  const match=/^(analyze|summarize|explain|compare|calculate|describe|list|draft|write)\s+(.+)$/i.exec(text);
  if(match)return'How can '+match[2]+' be '+verbs[match[1].toLowerCase()]+'?';
  return'How can '+text.replace(/^./,letter=>letter.toLowerCase())+' be addressed?';
}
export function privacyDependencies({question,outputSafe=true,answer,citations}={}){
  return{
    scan:async text=>({status:'ok',available:true,failClosed:false,findings:[...String(text).matchAll(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g)].map(match=>({start:match.index,end:match.index+match[0].length,type:'EMAIL',value:match[0],source:'original'})),decodedVariants:[]}),decode:()=>({variants:[],issues:[],failClosed:false}),
    localCall:async(lens,messages,{schema,maxTokens})=>{
      let body;try{body=JSON.parse(messages.at(-1).content);}catch{body={};}
      let value;if(schema.properties.generalizable)value={question:question??syntheticQuestion(body.task),generalizable:true};
      else if(schema.properties.private_values)value={private_values:[]};
      else{const local=JSON.parse(messages.at(-1).content);let old;try{old=JSON.parse(local.generalGuidance);}catch{}const first=local.applicationMode==='extractive'?local.evidence.find(row=>typeof row.text==='string'&&(row.chunkId??row.id)):null;value={answer:answer??(first?first.text:old?.answer??'A supported local answer.'),citations:citations??(first?[first.chunkId??first.id]:(old?.citations??[]).filter(id=>local.evidence.some(row=>(row.chunkId??row.id)===id)))};}
      return{modelId:lens==='meta'?'synthetic-privacy-meta':'synthetic-privacy-google',text:JSON.stringify(value),tokens:{input:10,output:10,total:20},latencyMs:1,settings:{maxTokens,contextTokens:4096},doneReason:'stop'};
    },
    harmfulGuard:async(_lens,_input,output)=>{const safe=output===undefined||outputSafe;return{safe,classification:safe?'safe':'unsafe',modelId:'synthetic-content-guard',latencyMs:1,tokens:{input:1,output:1,total:2}};},
    promptGuard:async(_texts,{variant})=>({status:'PASS',available:true,detected:false,variant,modelId:'synthetic-local-injection-guard',latencyMs:1,windows:1,maxScore:0}),
  };
}
/** Full mocked chain; this is not an unsafe permit factory or client bypass. */
export function questionBoundaryFixture(options={}){
  const dependencies=privacyDependencies(options);
  return{
    questionBoundary:async(item,{dataDir,lens='meta'}={})=>screenQuestionOnly(await prepareQuestionOnly(item,{lens,dataDir,dependencies:{...dependencies,keyDirectory:path.join(dataDir,'machine-local-test-keys')}}),{dependencies}),
    checkIncomingAnswer:(prepared,text)=>checkIncomingAnswer(prepared,text,{dependencies}),
    applyAnswerLocally:(prepared,checked,{localContext=[]}={})=>applyAnswerLocally(prepared,checked,{localContext,dependencies}),
  };
}
