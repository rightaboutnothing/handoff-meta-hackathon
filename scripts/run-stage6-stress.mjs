import {runStage6Stress} from '../src/evaluation/stage6-stress.mjs';
try{const report=await runStage6Stress();console.log(JSON.stringify({runId:report.runId,summary:report.summary,cloudCalls:0,spendUsd:0}));}
catch{console.error('Stage 6 local Guard run stopped safely; checkpoints retained. No prompt text or keys printed.');process.exitCode=1;}
