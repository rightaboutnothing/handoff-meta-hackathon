import {runStage1Study} from '../src/comparison/stage1.mjs';
import {writeFile} from 'node:fs/promises';
const args=process.argv.slice(2),at=args.indexOf('--run-id');
try{const report=await runStage1Study({runId:at<0?undefined:args[at+1]});console.log(`Stage 1 complete: results/${report.runId}/summary.md. Cloud calls 0; spend $0. STOP before Stage 2.`);}
catch(error){await writeFile('.logs/stage1-error.json',JSON.stringify({name:error.name,code:error.code??null,message:error.message,stack:error.stack},null,2)).catch(()=>{});console.error('Stage 1 stopped; private diagnostics/checkpoints retained. Cloud inference was never enabled.');process.exitCode=1;}
