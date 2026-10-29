import {runStage6f} from '../src/evaluation/stage6f-runner.mjs';
try{const report=await runStage6f();console.log(JSON.stringify({runId:report.runId,status:report.status,stage7Allowed:report.stage7Allowed,applicationTarget:report.applicationTarget,liveDispatchEnabled:false,cloudCalls:0,spendUsd:0}));}
catch{console.error('Stage 6f evaluation stopped safely; private checkpoints retained. No private content or credentials are printed.');process.exitCode=1;}
