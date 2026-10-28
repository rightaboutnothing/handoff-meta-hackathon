import assert from 'node:assert/strict';
import {readFile,writeFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import {sha256} from '../src/rag/receipts.mjs';
const args=process.argv.slice(2),at=args.indexOf('--run-id'),runId=at<0?'2026-10-28-stage3-dev-risk-calibration':args[at+1];
if(!/^[A-Za-z0-9][A-Za-z0-9_-]{0,90}$/.test(runId??''))throw new Error('Invalid Stage 3 verification run ID');
const pub=`results/${runId}/`,priv=`.logs/stage3/${runId}/`;
const json=async file=>JSON.parse(await readFile(file,'utf8'));
const lines=async file=>(await readFile(file,'utf8')).trim().split('\n').filter(Boolean).map(JSON.parse);
const [report,lock,progress,items,decisions,counts,contexts]=await Promise.all([json(pub+'report.json'),json(priv+'policy-lock.json'),lines(priv+'progress.jsonl'),lines(priv+'items.jsonl'),json(priv+'decisions.json'),json(priv+'token-counts.json'),json(priv+'contexts-lock.json')]);
assert.equal(report.cloudCalls,0);assert.equal(report.spendUsd,0);assert.equal(report.network.externalRequests,0);assert.equal(report.budgetUnset,true);
assert.equal(sha256(report.calibration),report.policyHash);assert.equal(lock.policyHash,report.policyHash);assert.equal(sha256(contexts),report.contextHash);
assert.equal(items.length,2460);assert.equal(new Set(items.map(r=>`${r.modelId}|${r.id}`)).size,2460);
const events=progress.filter(x=>x.phase==='dev-local'),opened=progress.filter(x=>x.phase==='frozen-replay-open'),locked=progress.filter(x=>x.phase==='policy-locked');
assert.equal(events.length,2460);assert.equal(opened.length,1);assert.equal(locked.length,1);assert.ok(events.every(x=>x.at<lock.lockedAt));assert.ok(lock.lockedAt<opened[0].at);
for(const row of items){assert.equal(row.contextHash,contexts[row.id]);const prepared=await json(priv+'contexts/'+sha256(row.id)+'.json');assert.equal(sha256(prepared),contexts[row.id]);}
for(const [file,hash]of Object.entries(report.source.files)){const pinned=execFileSync('git',['show',`${report.source.gitCommit}:${file}`],{encoding:'utf8',maxBuffer:32*1024*1024});assert.equal(sha256(pinned.replace(/\r\n/g,'\n')),hash);}
const accepted=decisions.filter(r=>r.accepted),unsafe=decisions.filter(r=>!r.safe);
assert.ok(accepted.every(r=>r.safe&&r.gate.eligible&&Object.values(r.gate.checks).every(Boolean)&&r.scoring.score===1));
assert.ok(unsafe.every(r=>!r.accepted&&r.decision.route==='local_only_safety'));
assert.ok(counts.filter(r=>!r.eligible).every(r=>r.inputTokens===0&&r.payloadHash===null&&!r.handedOff));
assert.ok(!/^\s*(?:export\s+)?CLOUD_BUDGET_USD\s*=/m.test(await readFile('.env','utf8')));
const result={runId,verifiedAt:new Date().toISOString(),passed:true,modelItemRows:items.length,frozenRows:decisions.length-items.length,acceptedRows:accepted.length,unsafeLocalOnlyRows:unsafe.length,invalidAcceptedRows:0,unsafeCloudPayloadRows:0,modelErrors:items.filter(r=>r.error).map(({id,modelId,category,role,error})=>({id,modelId,category,role,error})),retryEvents:progress.filter(r=>r.phase==='retry').length,policyHash:report.policyHash,policyLockedAt:lock.lockedAt,replayOpenedAt:opened[0].at,policyLockEvents:locked.length,sourceCommit:report.source.gitCommit,pinnedSourceFilesVerified:Object.keys(report.source.files).length,devContextHashesVerified:Object.keys(contexts).length,cloudCalls:0,externalRequests:0,spendUsd:0,cloudBudgetUnset:true,modelsPooled:false,postRunChange:'Summary presentation adds the already-recorded Wilson IID sensitivity intervals beside descriptive bootstrap intervals; measured JSON, policies and settings are unchanged.'};
await writeFile(pub+'verification.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));
