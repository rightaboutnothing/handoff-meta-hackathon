import {prepareStage6Live} from '../src/evaluation/stage6-live-preparation.mjs';
try{const report=await prepareStage6Live();console.log(JSON.stringify({runId:report.runId,preparedItems:report.preparedItems,projectedCostUsd:report.projectedCostUsd,reservedUpperUsd:report.reservedUpperUsd,tokens:report.tokens,runFitsDefaultCaps:report.runFitsDefaultCaps,cloudCalls:0,spendUsd:0}));}
catch{console.error('Stage 6 live preparation failed; no cloud request was attempted.');process.exitCode=1;}
