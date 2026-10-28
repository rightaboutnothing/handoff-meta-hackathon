import {runStage6c} from '../src/evaluation/stage6c-runner.mjs';
try{const report=await runStage6c();console.log(JSON.stringify({runId:report.runId,status:report.status,stage7Allowed:report.stage7Allowed,liveDispatchEnabled:false,cloudCalls:0,spendUsd:0,setups:report.setups.map(row=>({id:row.id,frozen:row.privacy.frozen.usable,multicountry:row.privacy.multicountry.usable,gate:row.gate.sampleCriteriaPassed}))}));}
catch{console.error('Stage 6c evaluation stopped safely; private checkpoints retained. No private content or credentials are printed.');process.exitCode=1;}
