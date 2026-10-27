import { useEffect, useState } from 'react';
import { AnimatePresence, MotionConfig, motion } from 'framer-motion';
import { useMotionPreference } from './hooks/useMotionPreference';
import { GatewayAsk } from './components/GatewayAsk';
import { GatewaySavings } from './components/GatewaySavings';
import { GatewayTrust } from './components/GatewayTrust';
import { GatewayBenchmarks } from './components/GatewayBenchmarks';
import { formatCount, formatPercent, getRound, type GatewayResults } from './gatewayTypes';
import type { ComparisonReport } from './comparisonTypes';
import './Gateway.css';

type View = 'ask' | 'savings' | 'trust' | 'benchmarks';
const views: {id: View; label: string; description: string}[] = [
  {id:'ask',label:'Ask',description:'Your company knowledge'},
  {id:'savings',label:'Savings',description:'The economics of local first'},
  {id:'trust',label:'Trust',description:'Inspect the boundary'},
  {id:'benchmarks',label:'Benchmarks',description:'Follow the evidence'},
];
function Wordmark() {
  return <a className="gw-wordmark" href="#ask" aria-label="Handoff home"><svg viewBox="0 0 40 40" aria-hidden="true"><path d="M8 13H26L21 8M32 27H14L19 32" fill="none" stroke="currentColor" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round"/><circle cx="8" cy="13" r="4" fill="currentColor"/><circle cx="32" cy="27" r="4" fill="currentColor"/></svg><span>Handoff</span></a>;
}
export default function GatewayApp() {
  const reduced=useMotionPreference();
  const [view,setView]=useState<View>(()=>views.some(item=>`#${item.id}`===location.hash)?location.hash.slice(1) as View:'ask');
  const [data,setData]=useState<GatewayResults|null>(null),[error,setError]=useState('');
  const [comparison,setComparison]=useState<ComparisonReport|null>(null);
  const [meta,setMeta]=useState<'paused'|'live'>('paused'),[dark,setDark]=useState(false);
  const refresh=async()=>{const results=await Promise.allSettled([fetch('/api/company/results').then(async response=>{if(!response.ok)throw new Error('Measured results could not be loaded.');setData(await response.json());}),fetch('/api/company/comparison').then(async response=>{if(!response.ok)throw new Error('Comparison results could not be loaded.');setComparison(await response.json());})]);const failed=results.find(result=>result.status==='rejected');setError(failed?.status==='rejected'?(failed.reason instanceof Error?failed.reason.message:'Results are unavailable.'):'');};
  useEffect(()=>{refresh();fetch('/api/company/status').then(r=>r.json()).then(value=>setMeta(value.metaAccess==='live'?'live':'paused')).catch(()=>undefined);},[]);
  useEffect(()=>{document.documentElement.classList.toggle('dark',dark);},[dark]);
  useEffect(()=>{const change=()=>{const id=location.hash.slice(1) as View;if(views.some(item=>item.id===id))setView(id);};addEventListener('hashchange',change);return()=>removeEventListener('hashchange',change);},[]);
  const rag=getRound(data,2),receipts=getRound(data,5);
  const isComparisonView=view==='benchmarks'||view==='savings';
  const navigate=(next:View)=>{setView(next);history.replaceState(null,'',`#${next}`);};
  return <MotionConfig reducedMotion={reduced?'always':'never'}><div className="gateway-shell min-h-screen">
    <header className="gw-header"><Wordmark/><span className="gw-product-label">The private AI gateway</span><div className="gw-header-actions"><span className={`gw-access ${meta}`}><i/>{meta==='live'?'Muse Spark connected':'Muse Spark paused'}</span><button className="gw-theme" onClick={()=>setDark(!dark)} aria-label={dark?'Use light theme':'Use dark theme'}>{dark?'☀':'◐'}</button></div></header>
    <main className={`gw-main ${view !== 'ask' ? 'gw-compact' : ''}`}>
      <section className="gw-landing" aria-label="Private gateway overview"><div className="gw-thesis"><span className="gw-eyebrow">Business knowledge. Kept close.</span><h1>Ask your company data privately.<br/><span>Pay less. Prove it.</span></h1><p>Your documents stay with local Llama. When a question needs Muse Spark, inspect the redacted handoff and its signed receipt.</p></div>{isComparisonView&&<p className="gw-study-context">Earlier company-data study · different questions and method</p>}<div className="gw-overview-rail">
        <div><span>Estimated saving vs all-cloud</span><strong>{formatPercent(rag?.summary.projectedSavingRate)}</strong><small>Pricing assumptions · includes local allocation</small></div>
        <div><span>Questions answered locally</span><strong>{formatPercent(rag?.summary.localAnswerRate)}</strong><small>{rag?`${formatCount(rag.summary.completed)} of ${formatCount(rag.summary.items)} synthetic questions`:'Testing round pending'}</small></div>
        <button onClick={()=>navigate('trust')}><span>Receipts verified</span><strong>{formatCount(receipts?.summary.signaturesVerified)}<em>{receipts?` / ${formatCount(receipts.summary.receipts)}`:''}</em></strong><small>{receipts?`${formatCount(receipts.summary.legacyUnchained)} legacy signatures · inspect coverage ↗`:'Receipt audit pending'}</small></button>
      </div></section>
      <div className="gw-measurement-line"><span><i/>{data?.manifest?'Measured locally. Cloud answers deferred.':'Waiting for measured results.'}</span><span>{data?.manifest?new Date(data.manifest.timestamp).toLocaleString('en-AU',{day:'numeric',month:'short',hour:'2-digit',minute:'2-digit'}):'Pending'}<button onClick={refresh} aria-label="Reload measured results">↻</button></span></div>
      {error&&<div className="gw-error" role="alert">{error} <button onClick={refresh}>Retry</button></div>}
      <nav className="gw-navigation" aria-label="Gateway views">{views.map(item=><button key={item.id} onClick={()=>navigate(item.id)} className={view===item.id?'active':''} aria-current={view===item.id?'page':undefined}><span>{item.label}</span><small>{item.description}</small>{view===item.id&&<motion.i layoutId="gw-nav" transition={{duration:reduced?0:.2}}/>}</button>)}</nav>
      <div hidden={view!=='ask'}><GatewayAsk onNavigateTrust={()=>navigate('trust')}/></div>
      <AnimatePresence mode="wait">{view!=='ask'&&<motion.div key={view} initial={{opacity:0,y:reduced?0:8}} animate={{opacity:1,y:0}} exit={{opacity:0}} transition={{duration:.18}}>{view==='savings'?<GatewaySavings data={data} comparison={comparison}/>:view==='trust'?<GatewayTrust data={data} onRefresh={refresh}/>:<GatewayBenchmarks data={data} comparison={comparison}/>}</motion.div>}</AnimatePresence>
      <footer className="gw-footer"><Wordmark/><p>Local first. Every handoff accountable.</p><span className="gw-source-records"><span>Earlier company-data study source: {data?.manifest?.sourceCommit?.slice(0,7)??'Pending'}</span>{isComparisonView&&<span>Comparison source: {comparison?.provenance?.gitCommit?.slice(0,7)??'Pending'}</span>}<span>Built during the Meta Global AI Developer Hackathon</span></span></footer>
    </main>
  </div></MotionConfig>;
}
