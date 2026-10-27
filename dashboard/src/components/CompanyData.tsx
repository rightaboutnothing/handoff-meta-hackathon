import { useEffect, useRef, useState } from 'react';
import { SvgCharacter } from './Character';
import type { CharacterAnimator, HandoffEvent } from '../types';
import './CompanyData.css';

type Citation = { file: string; chunkId: string; location: string; hash: string };
type GatewayResult = {
  status: string; route: string; answer: string; confidence: number; retrievalQuality: number; reason: string;
  citations: Citation[]; retrievalChunks: number;
  outbound: { question: string; chunks: { id: string; text: string; hash: string }[] };
  metrics: { latencyMs: number; tokensSentToCloud: number; outboundChunks: number; piiItemsRedacted: number; guardBlocks: number; receiptVerified: boolean; actualCostUsd: number | null; cloudDeliveryUnknown?: boolean; cloudCostUnknown?: boolean; allCloudCostUsdAssumption: number; projectedHandoffCostUsd: number };
  receipt?: { signature: string; fingerprint: string; payload: { status: string; inputHash: string; actualChunksSent: number | null; attemptedChunks?: number; delivery?: string; chunks: { chunkId: string; hash: string }[] } };
};
type IndexStatus = { ready: boolean; chunks?: number; files?: number; piiItemsRedacted?: number; embeddingModel?: { model: string } };
type Pricing = { museInputPerMillionUsd: number; museOutputPerMillionUsd: number; expectedOutputTokens: number; localPerQueryUsd: number };
type EvaluationSummary = {
  items: number; scored: number; deferred: number; errors: number;
  answerAccuracy: number | null; citationAccuracy: number | null;
  localAnswerRate: number; handoffRate: number; medianLatencyMs: number; p95LatencyMs: number;
  receiptsIssued: number; receiptsVerified: number;
  estimatedHandoffPer1000Usd: number; estimatedAllCloudPer1000Usd: number; estimatedLocalAllowancePer1000Usd: number;
};
type Evaluation = {
  questionCount: number; offlineMeta: boolean; seed: number;
  summary: { rag: EvaluationSummary };
  pricingAssumptions: Pricing;
  historicalBaseline?: { name: string; medianLatencyMs: number; handoffRate: number; comparisonWarning: string };
};
const money = (value: number, decimals = 2) => '$' + value.toFixed(decimals);
const percentage = (value: number | null) => value === null ? 'Deferred' : `${(value * 100).toFixed(1)}%`;
const seconds = (value: number) => `${(value / 1000).toFixed(2)}s`;
const samples = ['What is the warranty on the AF-100?', 'Who should I contact about a warranty claim?', 'How should Acme prepare for a new international market?'];

export function CompanyData() {
  const [folder, setFolder] = useState('demo_data');
  const [question, setQuestion] = useState(samples[0]);
  const [index, setIndex] = useState<IndexStatus>({ ready: false });
  const [metaAccess, setMetaAccess] = useState('paused');
  const [busy, setBusy] = useState('');
  const [message, setMessage] = useState('');
  const [events, setEvents] = useState<HandoffEvent[]>([]);
  const [result, setResult] = useState<GatewayResult | null>(null);
  const [evaluation, setEvaluation] = useState<Evaluation | null>(null);
  const [pricing, setPricing] = useState<Pricing | null>(null);
  const llama = useRef<CharacterAnimator>(null), guard = useRef<CharacterAnimator>(null), muse = useRef<CharacterAnimator>(null);
  const active = events.at(-1);

  const refreshStatus = async () => {
    const response = await fetch('/api/company/status');
    const data = await response.json();
    if (!response.ok) throw new Error(data.error || 'The local gateway is unavailable');
    setIndex(data.index); setMetaAccess(data.metaAccess); setPricing(data.pricing);
  };
  useEffect(() => {
    refreshStatus().catch(error => setMessage(error.message));
    fetch('/rag-evaluation.json')
      .then(async response => response.ok ? await response.json() as Evaluation : null)
      .then(value => { if (value?.summary?.rag) setEvaluation(value); })
      .catch(() => undefined);
  }, []);
  useEffect(() => {
    llama.current?.setState(active?.actor === 'local' && busy === 'ask' ? 'think' : result?.route === 'local' ? 'confident' : 'idle');
    guard.current?.setState(active?.type === 'blocked' ? 'block' : active?.actor === 'guard' && busy === 'ask' ? 'think' : result?.receipt ? 'confident' : 'idle');
    muse.current?.setState(active?.actor === 'cloud' && busy === 'ask' ? 'think' : result?.route === 'cloud' ? 'answer' : 'idle');
  }, [active, busy, result]);

  const ingest = async () => {
    setBusy('ingest'); setMessage('Reading, redacting and embedding on this machine…');
    try {
      const response = await fetch('/api/company/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ folder }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Ingest failed');
      setIndex(data); setResult(null); setEvents([]);
      setMessage(`Indexed ${data.files} files and ${data.chunks} chunks locally. Recognized PII items redacted: ${data.piiItemsRedacted}.`);
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Ingest failed'); }
    finally { setBusy(''); }
  };
  const ask = async () => {
    setBusy('ask'); setResult(null); setEvents([]); setMessage('Searching your local documents…');
    try {
      const response = await fetch('/api/company/ask', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ question }) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.error || 'Question failed'); }
      if (!response.body) throw new Error('Streaming is unavailable');
      const reader = response.body.getReader(), decoder = new TextDecoder();
      let pending = '';
      while (true) {
        const { value, done } = await reader.read();
        pending += decoder.decode(value, { stream: !done });
        const messages = pending.split('\n\n'); pending = messages.pop() || '';
        for (const part of messages) {
          if (!part.startsWith('data: ')) continue;
          const data = JSON.parse(part.slice(6));
          if (data.error) throw new Error(data.error);
          if (data.event) { setEvents(previous => [...previous, data.event]); setMessage(data.event.caption); }
          if (data.result) setResult(data.result);
        }
        if (done) break;
      }
    } catch (error) { setMessage(error instanceof Error ? error.message : 'Question failed'); }
    finally { setBusy(''); }
  };
  const handoff = result?.route === 'cloud';
  const deferred = result?.status === 'deferred_cloud';
  const deliveryUnknown = result?.metrics.cloudDeliveryUnknown || result?.receipt?.payload.status === 'request_failed' || result?.receipt?.payload.delivery === 'unknown';
  const proposalOnly = result?.receipt?.payload.status === 'deferred';
  const blockedBeforeCloud = result?.route === 'blocked_local' && !result.receipt;
  const evidence = result?.outbound.chunks ?? [];
  const projectedHandoff = blockedBeforeCloud ? 0 : result?.metrics.projectedHandoffCostUsd;
  const measured = evaluation?.summary.rag;
  const displayPricing = result ? pricing : evaluation?.pricingAssumptions ?? pricing;
  const costHandoff = result ? projectedHandoff === undefined ? undefined : projectedHandoff * 1000 : measured?.estimatedHandoffPer1000Usd;
  const costAllCloud = result ? result.metrics.allCloudCostUsdAssumption * 1000 : measured?.estimatedAllCloudPer1000Usd;
  const deliveryDescription = deliveryUnknown
    ? 'The request failed and delivery could not be confirmed. The payload may have reached the provider.'
    : proposalOnly
      ? 'Proposed redacted payload below. No cloud request was made.'
      : evidence.length
        ? 'Redacted text prepared for this cloud request. The signed record identifies the chunks and delivery status.'
        : 'No company data was handed off to the cloud for this request.';
  const costDescription = deliveryUnknown
    ? 'Delivery and any provider charge are unconfirmed. Zero spend is not asserted.'
    : proposalOnly
      ? 'Projected handoff cost assumes this deferred request is eventually sent. No Meta request was made.'
      : result && (result.metrics.outboundChunks > 0 || handoff)
        ? 'API amounts shown are projections. Consult provider usage and billing for incurred charges.'
        : 'No cloud API request was made for this result.';

  return <div className="company-view">
    <section className="company-intro"><div><span className="eyebrow">The private AI gateway</span><h1>Your knowledge.<br />On your terms.</h1><p>Ask questions over company documents with local Llama. Only the questions that need Muse Spark approach the safety boundary.</p></div><div className="company-index"><span className={index.ready ? 'index-dot ready' : 'index-dot'} /><strong>{index.ready ? 'Local index ready' : 'Start with your documents'}</strong><span>{index.files ?? 0} files · {index.chunks ?? 0} chunks</span><small>{index.embeddingModel?.model || 'Embeddings stay on this machine'}</small></div></section>

    {evaluation && measured && <section className="company-measured" aria-label="Measured synthetic company evaluation">
      <div className="company-measured-heading"><span className="eyebrow">Measured on synthetic company data</span><span>{evaluation.offlineMeta ? 'Offline Meta · no Meta calls' : 'Live Meta evaluation'} · seed {evaluation.seed}</span></div>
      <div className="company-measured-values">
        <div><span>Evaluation questions</span><strong>{measured.items}</strong><small>{measured.scored} scored · {measured.deferred} deferred{measured.errors ? ` · ${measured.errors} errors` : ''}</small></div>
        <div><span>Median latency</span><strong>{seconds(measured.medianLatencyMs)}</strong><small>p95 {seconds(measured.p95LatencyMs)}</small></div>
        <div><span>Answered locally</span><strong>{percentage(measured.localAnswerRate)}</strong><small>{percentage(measured.handoffRate)} need a handoff</small></div>
        <div><span>Answer accuracy</span><strong>{percentage(measured.answerAccuracy)}</strong><small>Conditional on {measured.scored} scored answers</small></div>
        <div><span>Citation precision</span><strong>{percentage(measured.citationAccuracy)}</strong><small>Against expected source chunks</small></div>
        <div><span>Verified receipts</span><strong>{measured.receiptsVerified}<em> / {measured.receiptsIssued}</em></strong><small>{evaluation.offlineMeta ? 'Deferred handoff proposals' : 'Signed boundary records'}</small></div>
      </div>
      <p className="company-measured-note">{evaluation.offlineMeta ? 'Latency measures local processing and handoff preparation; deferred cloud completion is excluded. ' : ''}Accuracy and citation precision exclude deferred items. Source: results/rag-summary.md.</p>
      {evaluation.historicalBaseline && <p className="company-historical">Finkd reference: {(evaluation.historicalBaseline.medianLatencyMs / 1000).toFixed(1)}s median · {percentage(evaluation.historicalBaseline.handoffRate)} handoffs. {evaluation.historicalBaseline.comparisonWarning}</p>}
    </section>}

    <section className="company-controls" aria-label="Company data controls">
      <div className="company-ingest"><label htmlFor="company-folder">1. Index a local folder</label><div><input id="company-folder" value={folder} onChange={e => setFolder(e.target.value)} placeholder="C:\\Company\\Documents" /><button type="button" onClick={ingest} disabled={!!busy || !folder.trim()}>{busy === 'ingest' ? 'Indexing…' : 'Ingest folder'}</button></div><small>.txt · .md · .pdf · .csv · .docx · Demo data is entirely synthetic.</small></div>
      <form className="company-question" onSubmit={e => { e.preventDefault(); ask(); }}><label htmlFor="company-question">2. Ask your company data</label><div><input id="company-question" value={question} onChange={e => setQuestion(e.target.value)} maxLength={8000} /><button type="submit" className="company-ask" disabled={!!busy || !index.ready || !question.trim()}>{busy === 'ask' ? 'Working locally…' : 'Ask Handoff →'}</button></div><div className="company-samples">{samples.map((sample, i) => <button type="button" key={sample} onClick={() => setQuestion(sample)} disabled={!!busy}>{['Product lookup', 'Contact & privacy', 'Needs more context'][i]}</button>)}</div></form>
    </section>

    <section className="company-flow" aria-label="Live private gateway flow">
      <div className="company-flow-heading"><span className="eyebrow">Live local execution</span><span className="company-access">Muse Spark · {metaAccess === 'live' ? 'access enabled' : 'access paused'}</span></div>
      <div className="company-actors"><div className="company-actor"><SvgCharacter ref={llama} kind="llama" label="Llama" /><strong>Search & answer</strong><span>Llama 3.1 8B · local documents</span></div><span className={'company-connector ' + (active?.actor === 'guard' ? 'active' : '')} aria-hidden="true">→</span><div className="company-actor company-guard"><SvgCharacter ref={guard} kind="guard" label="Llama Guard" compact /><strong>The safety boundary</strong><span>PII redaction · outbound & inbound Guard</span></div><span className={'company-connector ' + (handoff ? 'active' : '')} aria-hidden="true">→</span><div className="company-actor"><SvgCharacter ref={muse} kind="spark" label="Muse Spark" cloudModel="muse-spark-1.3" /><strong>Only when needed</strong><span>Muse Spark · minimum redacted evidence</span></div></div>
      <div className="company-live-status" role="status"><span className={busy ? 'working' : ''} />{message || 'Index a folder, then ask a question to watch the real flow.'}</div>
      {events.length > 0 && <details className="company-events"><summary>{events.length} recorded flow events</summary><ol>{events.map(event => <li key={event.id}><time>{(event.at / 1000).toFixed(2)}s</time><strong>{event.actor}</strong><span>{event.caption}</span></li>)}</ol></details>}
    </section>

    {result && <section className="company-answer-grid" aria-label="Gateway answer and boundary record">
      <article className="company-answer">
        <div className="company-card-header"><span className="eyebrow">{result.route === 'local' ? 'Answered locally' : handoff ? 'Muse Spark answer' : deliveryUnknown ? 'Cloud delivery unknown' : deferred ? 'Cloud answer deferred' : 'Blocked locally'}</span><span>{(result.metrics.latencyMs / 1000).toFixed(2)}s</span></div>
        <h2>{result.route === 'local' ? 'An answer from your documents' : deliveryUnknown ? 'The cloud request could not be confirmed.' : proposalOnly ? 'The boundary is ready. Access is paused.' : 'Your gateway decision'}</h2>
        <p className="company-answer-text">{result.answer}</p>
        <div className="company-answer-stats"><span>Local confidence <b>{Math.round(result.confidence * 100)}%</b></span><span>Retrieval quality <b>{result.retrievalQuality.toFixed(2)}</b></span><span>PII occurrences processed <b>{result.metrics.piiItemsRedacted}</b></span></div>
        <p className="company-reason">{result.reason}</p><h3>Source citations</h3>
        {result.citations.length ? <ul className="company-citations">{result.citations.map(c => <li key={c.chunkId}><strong>{c.file}</strong><span>{c.location} · {c.chunkId}</span></li>)}</ul> : <p className="company-fineprint">{deferred ? 'No confirmed cloud answer is available to cite.' : 'No source citations were returned.'}</p>}
      </article>
      <article className="company-boundary-record">
        <div className="company-card-header"><span className="eyebrow">Boundary transparency</span><span className={'receipt-badge ' + (result.metrics.receiptVerified ? 'verified' : '')}>{result.receipt ? result.metrics.receiptVerified ? '✓ Receipt verified' : 'Unverified receipt' : 'Stayed local'}</span></div>
        <h2>{deliveryUnknown ? 'Delivery unknown · cloud usage unconfirmed' : `${result.metrics.outboundChunks} chunks sent · ${result.metrics.tokensSentToCloud} cloud tokens`}</h2>
        <p>{deliveryDescription}</p>
        {evidence.length > 0 && <details className="company-payload"><summary>{proposalOnly ? 'Inspect proposed redacted text' : deliveryUnknown ? 'Inspect attempted redacted payload' : 'Inspect redacted outbound text'}</summary><pre>{JSON.stringify(result.outbound, null, 2)}</pre></details>}
        {result.receipt && <details className="company-receipt"><summary>Signed receipt · {result.receipt.payload.status}</summary><dl>
          <dt>Delivery</dt><dd>{deliveryUnknown ? `Unknown; ${result.receipt.payload.attemptedChunks ?? evidence.length} chunks attempted` : proposalOnly ? 'Deferred proposal; no request made' : `${result.receipt.payload.actualChunksSent ?? 'Unknown'} chunks sent`}</dd>
          <dt>Input SHA-256</dt><dd>{result.receipt.payload.inputHash}</dd><dt>Local trust anchor</dt><dd>{result.receipt.fingerprint}</dd><dt>Ed25519 signature</dt><dd>{result.receipt.signature}</dd>
        </dl><ul>{result.receipt.payload.chunks.map(chunk => <li key={chunk.chunkId}><strong>{chunk.chunkId}</strong><code>{chunk.hash}</code></li>)}</ul></details>}
        <small className="company-fineprint">A valid signature binds this local record. It does not establish provider delivery or billing. Deferred records describe proposals; failed requests can have unknown delivery. PII detection is rules based and needs review for real data.</small>
      </article>
    </section>}

    <section className="company-cost" aria-label="Cost comparison per 1000 queries">
      <div><span className="eyebrow">Assumed cost per 1,000 questions</span><h2>Keep routine questions local.</h2><p>{result ? 'Projection using this question repeated 1,000 times. ' : measured ? `Projection using the ${measured.items}-question synthetic evaluation mix. ` : 'Ask a question to estimate its boundary cost. '}{displayPricing ? `Input ${money(displayPricing.museInputPerMillionUsd)}/M tokens · output ${money(displayPricing.museOutputPerMillionUsd)}/M tokens · ${displayPricing.expectedOutputTokens} output tokens. ` : 'Pricing configuration is unavailable. '}These are assumptions, not verified Meta pricing.</p></div>
      <div className="company-cost-values"><div><span>{result ? 'Handoff cloud API · projected' : 'Handoff · API + local allocation'}</span><strong>{costHandoff !== undefined ? money(costHandoff, result ? 2 : 4) : '—'}</strong></div><div><span>All-cloud · full retrieved context</span><strong>{costAllCloud !== undefined ? money(costAllCloud, result ? 2 : 4) : '—'}</strong></div></div>
      <small>{result
        ? `${pricing ? `Local allocation assumption: ${money(pricing.localPerQueryUsd * 1000)} per 1,000 questions, additional to the API projection shown. ` : ''}${costDescription}`
        : measured
          ? `Handoff includes ${money(measured.estimatedLocalAllowancePer1000Usd)} per 1,000 questions for assumed electricity and hardware allocation; all-cloud shows assumed API cost. Deferred handoffs are priced as if eventually sent. This is a projection, not an observed cloud bill. `
          : ''} {evaluation ? 'The matched experiment is available in results/rag-summary.md.' : 'Evaluation results appear after handoff eval-rag.'}</small>
    </section>
  </div>;
}
