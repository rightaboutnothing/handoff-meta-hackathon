import {preflightStage6f} from '../src/evaluation/stage6f-runner.mjs';
try{console.log(JSON.stringify(await preflightStage6f()));}
catch{console.error('Stage 6f metadata preflight failed safely. No private content or credentials are printed.');process.exitCode=1;}
