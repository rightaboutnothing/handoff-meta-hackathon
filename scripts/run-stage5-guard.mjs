import {runStage5Guard} from '../src/evaluation/stage5-guard.mjs';
import {writeFile,mkdir} from 'node:fs/promises';
const args=process.argv.slice(2),at=args.indexOf('--run-id');
try{const report=await runStage5Guard({runId:at<0?undefined:args[at+1]});console.log(JSON.stringify({runId:report.runId,summary:report.summary,cloudCalls:0,spendUsd:0}));}
catch(error){await mkdir('.logs',{recursive:true});await writeFile('.logs/stage5-error.json',JSON.stringify({name:error.name,code:error.code??null,message:error.message,stack:error.stack},null,2));console.error('Stage 5 Guard screening stopped; private checkpoints retained. No cloud model calls are enabled.');process.exitCode=1;}
