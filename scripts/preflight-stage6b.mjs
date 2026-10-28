import {preflightStage6b} from '../src/evaluation/stage6b-runner.mjs';
try{console.log(JSON.stringify(await preflightStage6b()));}
catch{console.error('Stage 6b metadata-only preflight failed; no model inference or cloud request was attempted. No private text is printed.');process.exitCode=1;}
