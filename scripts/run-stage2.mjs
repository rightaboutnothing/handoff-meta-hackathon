import{runStage2Study}from'../src/comparison/stage2.mjs';
import{writeFile}from'node:fs/promises';
const args=process.argv.slice(2),at=args.indexOf('--run-id');
try{const report=await runStage2Study({runId:at<0?undefined:args[at+1]});console.log(`Stage 2 complete: results/${report.runId}/summary.md. Cloud calls 0; spend $0. STOP before Stage 3.`);}catch(error){await writeFile('.logs/stage2-error.json',JSON.stringify({name:error.name,code:error.code??null,message:error.message,stack:error.stack},null,2)).catch(()=>{});console.error('Stage 2 stopped; private diagnostics/checkpoints retained. Cloud inference was never enabled.');process.exitCode=1;}
