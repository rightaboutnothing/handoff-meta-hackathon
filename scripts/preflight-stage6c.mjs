import {preflightStage6c} from '../src/evaluation/stage6c-runner.mjs';
try{console.log(JSON.stringify(await preflightStage6c()));}
catch{console.error('Stage 6c metadata preflight failed safely. No private content or credentials are printed.');process.exitCode=1;}
