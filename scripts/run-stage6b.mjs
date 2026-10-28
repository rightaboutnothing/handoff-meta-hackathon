import {runStage6b} from '../src/evaluation/stage6b-runner.mjs';
try{const report=await runStage6b();console.log(JSON.stringify({runId:report.runId,status:report.status,cloudCalls:0,spendUsd:0,setups:report.setups.map(row=>({id:row.id,gate:row.gate,candidateCoverage:row.candidateCoverage}))}));}
catch{console.error('Stage 6b evaluation stopped safely; private checkpoints retained. No prompt, key or token material is printed.');process.exitCode=1;}
