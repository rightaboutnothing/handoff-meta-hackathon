import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';
import { SvgCharacter } from './Character';
import type { CharacterAnimator, HandoffEvent } from '../types';
import { formatCount, formatLatency, formatPercent } from '../gatewayTypes';
import './GatewayAsk.css';

interface Result {
  runId: string; status: string; route: string; answer: string; confidence: number; reason: string;
  citations: {file: string; chunkId: string; location: string}[];
  metrics: {latencyMs: number; tokensSentToCloud: number; outboundChunks: number; piiItemsRedacted: number; guardBlocks: number; receiptVerified: boolean; cloudDeliveryUnknown?: boolean};
  receipt?: {signature: string; fingerprint: string; payload: {status: string; inputHash: string; chunks: {chunkId: string; hash: string}[]}; chain?: {sequence: number; entryHash: string; previousEntryHash: string}};
  boundary?: {input: string | null; inputHash: string; disposition: 'proposed' | 'sent' | 'unknown'};
  receiptVerification?: {signature: boolean; payload: boolean; chain: boolean; sequence: number};
}
interface Index {ready: boolean; files?: number; chunks?: number; embeddingModel?: {model: string}}
const examples=[
  {label:'A product detail',question:'What is the warranty on the AF-100?'},
  {label:'Across documents',question:'For an AF200 warranty claim, what evidence and service response should the customer expect?'},
  {label:'A harder question',question:'Build a multi-period cash-flow risk model for winning the Northshore Trial. Handle unknown conversion probability, payment timing and capacity without fabricating forecasts.'},
];
export function GatewayAsk({onNavigateTrust}:{onNavigateTrust():void}) {
  const [question,setQuestion]=useState(examples[0].question),[folder,setFolder]=useState('demo_data');
  const [index,setIndex]=useState<Index>({ready:false}),[busy,setBusy]=useState('');
  const [notice,setNotice]=useState(''),[error,setError]=useState('');
  const [events,setEvents]=useState<HandoffEvent[]>([]),[result,setResult]=useState<Result|null>(null);
  const [panel,setPanel]=useState<'payload'|'receipt'>('payload');
  const llama=useRef<CharacterAnimator>(null),guard=useRef<CharacterAnimator>(null),muse=useRef<CharacterAnimator>(null);
  const event=events.at(-1),proposed=result?.boundary?.disposition==='proposed';
  const verified=!!(result?.receiptVerification?.signature&&result.receiptVerification.payload&&result.receiptVerification.chain);
  useEffect(()=>{fetch('/api/company/status').then(r=>r.json()).then(data=>setIndex(data.index)).catch(()=>setError('Start the local dashboard server to connect your documents.'));},[]);
  useEffect(()=>{
    llama.current?.setState(busy==='ask'&&event?.actor==='local'?'think':result?.route==='local'?'confident':'idle');
    guard.current?.setState(event?.type==='blocked'?'block':busy==='ask'&&event?.actor==='guard'?'think':verified?'confident':'idle');
    muse.current?.setState(busy==='ask'&&event?.actor==='cloud'?'think':result?.route==='cloud'?'answer':'idle');
  },[busy,event,result,verified]);
  const ingest=async()=>{
    setBusy('ingest');setError('');setNotice('Reading, redacting and embedding locally…');
    try{const response=await fetch('/api/company/ingest',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({folder})});const data=await response.json();if(!response.ok)throw new Error(data.error);setIndex(data);setResult(null);setEvents([]);setNotice(`Indexed ${data.files} files into ${data.chunks} local chunks.`);}
    catch(error){setError(error instanceof Error?error.message:'Local ingest failed.');setNotice('');}finally{setBusy('');}
  };
  const ask=async()=>{
    setBusy('ask');setError('');setResult(null);setEvents([]);setNotice('Searching the documents on this machine…');
    try{
      const response=await fetch('/api/company/ask',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({question})});
      if(!response.ok){const body=await response.json();throw new Error(body.error||'The gateway is unavailable.');}
      if(!response.body)throw new Error('The live response stream is unavailable.');
      const reader=response.body.getReader(),decoder=new TextDecoder();let pending='';
      for(;;){const {value,done}=await reader.read();pending+=decoder.decode(value,{stream:!done});const messages=pending.split('\n\n');pending=messages.pop()||'';
        for(const message of messages){if(!message.startsWith('data: '))continue;const data=JSON.parse(message.slice(6));if(data.error)throw new Error(data.error);if(data.event){setEvents(previous=>[...previous,data.event]);setNotice(data.event.caption);}if(data.result){setResult(data.result);setPanel('payload');}}
        if(done)break;
      }
    }catch(error){setError(error instanceof Error?error.message:'The local gateway could not finish this question.');setNotice('');}finally{setBusy('');}
  };
  return <section className="ga-view" aria-label="Ask your company data">
    <div className="ga-workspace-head"><div><span className="gw-eyebrow">Ask</span><h2>A question. A private path to the answer.</h2></div><details className="ga-index"><summary><i className={index.ready?'ready':''}/>{index.ready?`${formatCount(index.files)} files on this machine`:'Connect a local folder'}<span>⌄</span></summary><div><label htmlFor="ga-folder">Local folder path</label><input id="ga-folder" value={folder} onChange={e=>setFolder(e.target.value)}/><button onClick={ingest} disabled={!!busy||!folder.trim()}>{busy==='ingest'?'Indexing locally…':'Ingest folder'}</button><small>{formatCount(index.chunks)} chunks · {index.embeddingModel?.model||'Embeddings pending'}<br/>Synthetic demo only. Real data stays in ignored local storage.</small></div></details></div>
    <div className="ga-workspace"><div className="ga-main">
      <form className="ga-question" onSubmit={e=>{e.preventDefault();ask();}}><label htmlFor="ga-question">What would you like to know?</label><textarea id="ga-question" rows={2} maxLength={8000} value={question} onChange={e=>setQuestion(e.target.value)} disabled={busy==='ask'}/><div><span><i/>Searching local company documents</span><button className="gw-primary" type="submit" disabled={!!busy||!index.ready||!question.trim()}>{busy==='ask'?'Working locally…':'Ask Handoff'}<b aria-hidden="true">↗</b></button></div></form>
      <div className="ga-examples"><span>Try a question</span>{examples.map(example=><button key={example.label} disabled={!!busy} onClick={()=>setQuestion(example.question)}>{example.label}<span>↗</span></button>)}</div>
      <div className="ga-flow" aria-label="Live Llama, Guard and Muse Spark flow"><div className="ga-flow-heading"><span>ON YOUR MACHINE</span><span>THE BOUNDARY</span><span>CLOUD · ONLY IF NEEDED</span></div><div className="ga-actors">
        <div className={`ga-actor ${busy==='ask'&&event?.actor==='local'?'active':''}`}><SvgCharacter ref={llama} kind="llama" label="Llama"/><span>Search & answer locally</span></div><div className={`ga-link ${event?.actor==='guard'?'active':''}`}><b>→</b></div>
        <div className={`ga-actor ga-guard ${busy==='ask'&&event?.actor==='guard'?'active':''}`}><SvgCharacter ref={guard} kind="guard" label="Llama Guard" compact/><span>{proposed?'Outbound safe · inbound pending':result?.route==='local'?'No boundary crossing':'Redact & screen both ways'}</span></div><div className={`ga-link ${event?.actor==='cloud'?'active':''}`}><b>→</b></div>
        <div className={`ga-actor ga-muse ${result?.route==='cloud'?'active':''}`}><SvgCharacter ref={muse} kind="spark" label="Muse Spark" cloudModel="muse-spark-1.3"/><span>{proposed?'Handoff deferred':'Minimum redacted evidence'}</span></div>
      </div><div className="ga-caption" role="status"><span className={busy?'working':''}/>{notice||'Ready to search your local documents.'}</div>
      {events.length>0&&<details className="ga-events"><summary>Inspect the live flow · {formatCount(events.length)} events</summary><ol>{events.map(item=><li key={item.id}><time>{formatLatency(item.at)}</time><b>{item.actor}</b><span>{item.caption}</span></li>)}</ol></details>}</div>
      {error&&<p className="gw-error" role="alert">{error}</p>}
      {result&&<motion.article className="ga-answer" initial={{opacity:0,y:5}} animate={{opacity:1,y:0}}><div className="ga-answer-label"><span>{result.route==='local'?'Answered by local Llama':proposed?'Cloud answer deferred':result.route==='cloud'?'Answered by Muse Spark':'Kept at the boundary'}</span><span>{formatLatency(result.metrics.latencyMs)}</span></div><p>{result.answer}</p><div className="ga-citations">{result.citations.map(citation=><div key={citation.chunkId}><span>↗</span><div><strong>{citation.file}</strong><small>{citation.location} · {citation.chunkId}</small></div></div>)}</div><div className="ga-answer-foot"><span>Local confidence {formatPercent(result.confidence)}</span><span>{formatCount(result.metrics.piiItemsRedacted)} PII occurrences processed</span><small>Placeholders restored locally before display.</small></div></motion.article>}
    </div><aside className="ga-boundary" aria-label="Redacted request and receipt"><div className="ga-boundary-heading"><span className="gw-eyebrow">The handoff record</span><span className={`ga-receipt-badge ${verified?'verified':''}`}>{result?.receipt?verified?'✓ Verified':'Verification pending':result?'Stayed local':'Awaiting a question'}</span></div><h3>{proposed?'Prepared. Never sent.':result?.boundary?.disposition==='unknown'?'Delivery is unconfirmed.':result?.boundary?'Exactly what crossed.':result?'The answer stayed here.':'See what leaves. Prove what stayed.'}</h3><p>{proposed?'Muse Spark is paused. This is the exact redacted text prepared locally.':result?.boundary?.disposition==='unknown'?'The request failed; delivery and usage are unknown.':result?.boundary?'The retained text is checked against its signed input and chunk hashes.':result?'No cloud payload was needed.':'A cloud handoff shows its exact redacted text, source hashes and receipt here.'}</p>
      {result&&<div className="ga-boundary-counts"><div><strong>{result.metrics.cloudDeliveryUnknown?'Unknown':formatCount(result.metrics.outboundChunks)}</strong><span>chunks sent</span></div><div><strong>{result.metrics.cloudDeliveryUnknown?'Unknown':formatCount(result.metrics.tokensSentToCloud)}</strong><span>cloud tokens</span></div></div>}
      <div className="ga-panel-tabs" aria-label="Boundary record tabs"><button onClick={()=>setPanel('payload')} className={panel==='payload'?'active':''}>Redacted text</button><button onClick={()=>setPanel('receipt')} className={panel==='receipt'?'active':''}>Receipt</button></div>
      {panel==='payload'?result?.boundary?.input?<pre className="ga-payload">{result.boundary.input}</pre>:<div className="ga-empty"><span>⌁</span><strong>{result?'No handoff payload':'Your data starts local'}</strong><p>{result?'This question has no prepared cloud request.':'Only necessary, redacted evidence can approach the boundary.'}</p></div>:result?.receipt?<div className="ga-receipt-detail"><div className="ga-receipt-status"><i className={verified?'verified':''}/>{proposed?'Signed proposal · no request made':result.receipt.payload.status}</div><dl><dt>Verification</dt><dd>{result.receiptVerification?.signature?'Signature ✓':'Signature pending'} · {result.receiptVerification?.payload?'Payload hashes ✓':'Payload pending'} · {result.receiptVerification?.chain?'Chain ✓':'Chain pending'}</dd><dt>Chain position</dt><dd>{formatCount(result.receipt.chain?.sequence)}</dd><dt>Input SHA-256</dt><dd>{result.receipt.payload.inputHash}</dd><dt>Chain entry</dt><dd>{result.receipt.chain?.entryHash||'Pending'}</dd><dt>Ed25519 signature</dt><dd>{result.receipt.signature}</dd></dl>{result.receipt.payload.chunks.map(chunk=><div className="ga-receipt-chunk" key={chunk.chunkId}><strong>{chunk.chunkId}</strong><code>{chunk.hash}</code></div>)}</div>:<div className="ga-empty"><span>⌑</span><strong>{result?'A local answer needs no handoff receipt':'A signature for every handoff'}</strong><p>New records bind the exact prepared text and their position in the local chain.</p></div>}
      <button className="ga-trust-link" onClick={onNavigateTrust}>Explore the trust evidence <span>↗</span></button><small className="ga-boundary-note">A local signature proves record integrity, not provider delivery. Rules-based PII detection needs validation on real documents.</small>
    </aside></div>
  </section>;
}
