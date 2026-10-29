import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir,readFile,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

export const PRIVACY_PANELS=Object.freeze(['headline','progress','attribution','prompt-guard','provenance']);
const dashboardRoot=fileURLToPath(new URL('../',import.meta.url));
const repositoryRoot=path.resolve(dashboardRoot,'..');
const require=createRequire(import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');

/** The static examples and the live app share the exact same React component.
 * Only the adapter's aggregate DTO is accepted; it is never embedded as JSON. */
export async function createPrivacyRenderer(){
  const bundle=await build({
    stdin:{contents:`import React from 'react';import {renderToStaticMarkup} from 'react-dom/server';import {PrivacyResults} from './src/components/PrivacyResults';export const render=(report,onlyPanel)=>renderToStaticMarkup(React.createElement(PrivacyResults,{report,onlyPanel}));`,resolveDir:dashboardRoot,sourcefile:'privacy-static-render.tsx',loader:'tsx'},
    absWorkingDir:dashboardRoot,bundle:true,write:false,platform:'node',format:'cjs',jsx:'automatic',loader:{'.css':'empty'},logLevel:'silent',define:{'process.env.NODE_ENV':'"production"'},
  });
  const compiled={exports:{}};
  new Function('module','exports','require',bundle.outputFiles[0].text)(compiled,compiled.exports,require);
  assert.equal(typeof compiled.exports.render,'function');
  return compiled.exports.render;
}

export async function privacyExampleHtml(report,{render}={}){
  const renderer=render??await createPrivacyRenderer();
  const css=await Promise.all(['src/index.css','src/Gateway.css','src/components/PrivacyResults.css'].map(async name=>(await readFile(path.join(dashboardRoot,name),'utf8')).replace(/\r\n/g,'\n')));
  const markup=renderer(report);
  assert.doesNotMatch(markup,/\b(?:NaN|undefined|Infinity)\b/);
  // No hydration, fetch, embedded payload or external asset is needed to view
  // this example. Charts are the component's native SVG/CSS and accessible text.
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src \'none\'; style-src \'unsafe-inline\'; img-src data:; base-uri \'none\'; form-action \'none\'"><title>Handoff — locked local privacy results</title><style>'+css.join('\n')+'\nbody{margin:0;padding:32px;background:var(--canvas,#fff)}.privacy-static-example{max-width:1440px;margin:0 auto}*,*::before,*::after{box-sizing:border-box}@media(max-width:760px){body{padding:16px}}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important}}</style></head><body><main class="gateway-shell privacy-static-example">'+markup+'</main></body></html>\n';
}

async function chooseBrowser(chromium){
  const bundled=chromium.executablePath();
  if(existsSync(bundled))return{executablePath:bundled,kind:'installed-playwright-chromium'};
  // Use an already installed browser; never download one during an offline export.
  for(const candidate of [process.env.PROGRAMFILES&&path.join(process.env.PROGRAMFILES,'Google/Chrome/Application/chrome.exe'),process.env['PROGRAMFILES(X86)']&&path.join(process.env['PROGRAMFILES(X86)'],'Microsoft/Edge/Application/msedge.exe')].filter(Boolean))if(existsSync(candidate))return{executablePath:candidate,kind:candidate.endsWith('chrome.exe')?'installed-chrome':'installed-edge'};
  throw Error('PRIVACY_EXPORT_LOCAL_BROWSER_UNAVAILABLE');
}

export async function exportPrivacyDashboard(){
  const {readPrivacyResults}=await import('../server/privacy-results.mjs');
  const report=await readPrivacyResults();
  if(!report)throw Error('PRIVACY_EXPORT_LOCKED_RESULTS_PENDING');
  assert.equal(report.cloudCalls,0);assert.equal(report.spendUsd,0);assert.equal(report.liveDispatchEnabled,false);
  for(const value of [report.sourceHash,report.reportSha256])assert.match(value,/^[a-f0-9]{64}$/);
  const outputDirectory=path.join(repositoryRoot,'docs/dashboard');
  await mkdir(outputDirectory,{recursive:true});
  const html=await privacyExampleHtml(report),htmlFile=path.join(outputDirectory,'index.html');
  await writeFile(htmlFile,html,'utf8');
  const {chromium}=await import('@playwright/test'),choice=await chooseBrowser(chromium);
  const browser=await chromium.launch({headless:true,executablePath:choice.executablePath,args:['--disable-background-networking','--disable-sync','--disable-component-update','--no-first-run','--no-default-browser-check','--disable-features=OptimizationHints,MediaRouter,AutofillServerCommunication']});
  let externalRequests=0;
  const panels=[];
  try{
    const context=await browser.newContext({viewport:{width:1504,height:1080},deviceScaleFactor:1,reducedMotion:'reduce',colorScheme:'light',serviceWorkers:'block'});
    const expectedUrl=pathToFileURL(htmlFile).href;
    await context.route('**/*',async route=>{
      const url=route.request().url();
      if(url===expectedUrl)return route.continue();
      externalRequests++;
      await route.abort();
    });
    const page=await context.newPage();
    await page.goto(expectedUrl,{waitUntil:'load'});
    await page.evaluate(()=>document.fonts.ready);
    for(const id of PRIVACY_PANELS){
      const panel=page.locator(`[data-export-panel="${id}"]`);
      assert.equal(await panel.count(),1,'A snapshot panel must have exactly one source element');
      await panel.scrollIntoViewIfNeeded();
      const box=await panel.boundingBox();assert.ok(box&&box.width>0&&box.height>0);
      const filename=`stage6e-${id}.png`,bytes=await panel.screenshot({type:'png',animations:'disabled',scale:'css'});
      await writeFile(path.join(outputDirectory,filename),bytes);
      panels.push({id,file:filename,sha256:sha(bytes),width:Math.ceil(box.width),height:Math.ceil(box.height)});
    }
    assert.equal(externalRequests,0,'An offline example must not load external resources');
    await context.close();
  }finally{await browser.close();}
  const rendererSourceHashes={};
  for(const name of ['src/components/PrivacyResults.tsx','src/components/PrivacyResults.css','src/privacyResultsTypes.ts','server/privacy-results.mjs','scripts/export-privacy-dashboard.mjs'])rendererSourceHashes['dashboard/'+name]=sha(await readFile(path.join(dashboardRoot,name)));
  const manifest={schemaVersion:1,kind:'privacy-dashboard-snapshots',generatedAt:new Date().toISOString(),measurement:{stage:report.stage,runId:report.runId,reportSha256:report.reportSha256,sourceHash:report.sourceHash,sourceCommit:report.sourceCommit,seed:report.seed,timestamp:report.timestamp,timestampAwst:report.timestampAwst,cloudCalls:report.cloudCalls,spendUsd:report.spendUsd,liveDispatchEnabled:report.liveDispatchEnabled},html:{file:'index.html',sha256:sha(html)},panels,rendererSourceHashes,rendering:{sameComponentAsDashboard:true,browser:choice.kind,externalRequests,embeddedRawReport:false,modelCalls:0}};
  await writeFile(path.join(outputDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
  return{runId:report.runId,outputDirectory,html:'index.html',panels:panels.map(({id,file,width,height})=>({id,file,width,height})),manifest:'manifest.json',modelCalls:0,cloudCalls:0,externalRequests};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await exportPrivacyDashboard()));}
  catch{console.error('Local privacy dashboard export failed. No private content or credentials were printed.');process.exitCode=1;}
}
