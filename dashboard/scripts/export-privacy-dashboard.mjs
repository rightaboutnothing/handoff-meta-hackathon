import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync} from 'node:fs';
import {lstat,mkdir,readFile,realpath,writeFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';

export const PRIVACY_PANELS=Object.freeze(['headline','progress','attribution','prompt-guard','provenance']);
const dashboardRoot=fileURLToPath(new URL('../',import.meta.url));
const repositoryRoot=path.resolve(dashboardRoot,'..');
const require=createRequire(import.meta.url);
const sha=value=>createHash('sha256').update(value).digest('hex');
const exportBasename=/^[a-z][a-z0-9-]{0,63}$/;

/** Versioned exports are one ordinary child folder, never a path. Keeping the
 * default destination unchanged also keeps existing export commands compatible. */
export function privacyExportTarget(options={}){
  if(!options||typeof options!=='object'||Array.isArray(options)||Object.keys(options).some(key=>!['outputSubdirectory','filenamePrefix'].includes(key)))throw Error('PRIVACY_EXPORT_INVALID_OPTIONS');
  const {outputSubdirectory,filenamePrefix='stage6e'}=options;
  if(outputSubdirectory!==undefined&&(typeof outputSubdirectory!=='string'||!exportBasename.test(outputSubdirectory)||/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(outputSubdirectory)))throw Error('PRIVACY_EXPORT_INVALID_SUBDIRECTORY');
  if(typeof filenamePrefix!=='string'||!exportBasename.test(filenamePrefix))throw Error('PRIVACY_EXPORT_INVALID_PREFIX');
  const baseDirectory=path.join(repositoryRoot,'docs/dashboard');
  return{baseDirectory,outputDirectory:outputSubdirectory?path.join(baseDirectory,outputSubdirectory):baseDirectory,outputSubdirectory:outputSubdirectory??null,filenamePrefix};
}

export function parsePrivacyExportArguments(args){
  if(!Array.isArray(args))throw Error('PRIVACY_EXPORT_INVALID_ARGUMENTS');
  const options={};
  for(let index=0;index<args.length;index++){
    const key=args[index]==='--output-subdir'?'outputSubdirectory':args[index]==='--prefix'?'filenamePrefix':null;
    if(!key||Object.hasOwn(options,key)||typeof args[index+1]!=='string'||args[index+1].startsWith('--'))throw Error('PRIVACY_EXPORT_INVALID_ARGUMENTS');
    options[key]=args[++index];
  }
  privacyExportTarget(options);
  return options;
}

async function prepareExportDirectory(target){
  await mkdir(target.baseDirectory,{recursive:true});
  const baseInfo=await lstat(target.baseDirectory);
  if(!baseInfo.isDirectory()||baseInfo.isSymbolicLink())throw Error('PRIVACY_EXPORT_UNSAFE_DIRECTORY');
  const base=await realpath(target.baseDirectory);
  const repository=await realpath(repositoryRoot),relative=path.relative(repository,base);
  if(!relative||relative.startsWith('..'+path.sep)||relative==='..'||path.isAbsolute(relative))throw Error('PRIVACY_EXPORT_UNSAFE_DIRECTORY');
  if(target.outputSubdirectory){
    await mkdir(target.outputDirectory,{recursive:true});
    const info=await lstat(target.outputDirectory),resolved=await realpath(target.outputDirectory);
    if(!info.isDirectory()||info.isSymbolicLink()||path.dirname(resolved).toLowerCase()!==base.toLowerCase())throw Error('PRIVACY_EXPORT_UNSAFE_DIRECTORY');
  }
}

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

export async function exportPrivacyDashboard(options={}){
  const target=privacyExportTarget(options);
  const {readPrivacyResults}=await import('../server/privacy-results.mjs');
  const report=await readPrivacyResults();
  if(!report)throw Error('PRIVACY_EXPORT_LOCKED_RESULTS_PENDING');
  assert.equal(report.cloudCalls,0);assert.equal(report.spendUsd,0);assert.equal(report.liveDispatchEnabled,false);
  for(const value of [report.sourceHash,report.reportSha256])assert.match(value,/^[a-f0-9]{64}$/);
  const {outputDirectory}=target;
  await prepareExportDirectory(target);
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
      const filename=`${target.filenamePrefix}-${id}.png`,bytes=await panel.screenshot({type:'png',animations:'disabled',scale:'css'});
      await writeFile(path.join(outputDirectory,filename),bytes);
      panels.push({id,file:filename,sha256:sha(bytes),width:Math.ceil(box.width),height:Math.ceil(box.height)});
    }
    assert.equal(externalRequests,0,'An offline example must not load external resources');
    await context.close();
  }finally{await browser.close();}
  const rendererSourceHashes={};
  for(const name of ['src/components/PrivacyResults.tsx','src/components/PrivacyResults.css','src/privacyResultsTypes.ts','server/privacy-results.mjs','scripts/export-privacy-dashboard.mjs'])rendererSourceHashes['dashboard/'+name]=sha(await readFile(path.join(dashboardRoot,name)));
  const manifest={schemaVersion:1,kind:'privacy-dashboard-snapshots',generatedAt:new Date().toISOString(),measurement:{stage:report.stage,runId:report.runId,reportSha256:report.reportSha256,sourceHash:report.sourceHash,sourceCommit:report.sourceCommit,seed:report.seed,timestamp:report.timestamp,timestampAwst:report.timestampAwst,cloudCalls:report.cloudCalls,spendUsd:report.spendUsd,liveDispatchEnabled:report.liveDispatchEnabled},html:{file:'index.html',sha256:sha(html)},panels,rendererSourceHashes,rendering:{sameComponentAsDashboard:true,browser:choice.kind,externalRequests,embeddedRawReport:false,modelCalls:0}};
  if(target.outputSubdirectory||target.filenamePrefix!=='stage6e')manifest.destination={outputSubdirectory:target.outputSubdirectory,filenamePrefix:target.filenamePrefix};
  await writeFile(path.join(outputDirectory,'manifest.json'),JSON.stringify(manifest,null,2)+'\n','utf8');
  return{runId:report.runId,outputDirectory,html:'index.html',panels:panels.map(({id,file,width,height})=>({id,file,width,height})),manifest:'manifest.json',modelCalls:0,cloudCalls:0,externalRequests};
}

if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  try{console.log(JSON.stringify(await exportPrivacyDashboard(parsePrivacyExportArguments(process.argv.slice(2)))));}
  catch{console.error('Local privacy dashboard export failed. No private content or credentials were printed.');process.exitCode=1;}
}
