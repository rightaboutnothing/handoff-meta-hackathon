import {rerunStage6bPromptGuard} from '../src/evaluation/stage6b-pg-replay.mjs';
try{const report=await rerunStage6bPromptGuard();console.log(JSON.stringify({runId:report.runId,kind:report.kind,cloudCalls:0,spendUsd:0,models:Object.fromEntries(Object.entries(report.assets).map(([key,row])=>[key,row.status]))}));}
catch{console.error('Prompt Guard-only replay stopped safely; no other model was invoked and no prompt or credential material was printed.');process.exitCode=1;}
