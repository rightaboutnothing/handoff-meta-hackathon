import {preflightStage6d} from '../src/evaluation/stage6d-runner.mjs';
try{console.log(JSON.stringify(await preflightStage6d()));}
catch{console.error('Stage 6d metadata preflight failed safely. No private content or credentials are printed.');process.exitCode=1;}
