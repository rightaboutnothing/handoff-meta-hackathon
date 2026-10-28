import {prepareQuestionOnly,screenQuestionOnly,checkIncomingAnswer,applyAnswerLocally} from '../../src/privacy/question-boundary.mjs';
import path from 'node:path';

export const GENERAL_TEST_QUESTION='What general method should be used for this task?';
export function privacyDependencies({question=GENERAL_TEST_QUESTION,outputSafe=true,answer,citations}={}){
  return{
    scan:async()=>({status:'ok',available:true,failClosed:false,findings:[],decodedVariants:[]}),decode:()=>({variants:[],issues:[],failClosed:false}),
    localCall:async(lens,messages,{schema,maxTokens})=>{
      let value;if(schema.properties.generalizable)value={question,generalizable:true};
      else if(schema.properties.general)value={question,private_values:[],general:true};
      else if(schema.properties.safe)value={safe:true,private_values:[]};
      else{const local=JSON.parse(messages.at(-1).content);let old;try{old=JSON.parse(local.generalGuidance);}catch{}value={answer:answer??old?.answer??'A supported local answer.',citations:citations??(old?.citations??[]).filter(id=>local.evidence.some(row=>(row.chunkId??row.id)===id))};}
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
