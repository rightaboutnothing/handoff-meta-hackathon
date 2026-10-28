import {writeStage4Report} from '../src/comparison/stage4.mjs';
const args=process.argv.slice(2),at=args.indexOf('--run-id');
const report=await writeStage4Report({runId:at<0?undefined:args[at+1]});
console.log(JSON.stringify({runId:report.runId,sourceRun:report.sourceRun,rows:report.rows.length,costPlans:report.costs.length,cloudCalls:report.cloudCalls,modelCalls:report.modelCalls,spendUsd:report.spendUsd}));
