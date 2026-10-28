import {runStage6d} from '../src/evaluation/stage6d-runner.mjs';
try{const report=await runStage6d();console.log(JSON.stringify({runId:report.runId,status:report.status,stage7Allowed:report.stage7Allowed,applicationTarget:report.applicationTarget,liveDispatchEnabled:false,cloudCalls:0,spendUsd:0}));}
catch{console.error('Stage 6d evaluation stopped safely; private checkpoints retained. No private content or credentials are printed.');process.exitCode=1;}
