import { createHash } from 'node:crypto';
import { validateCitations } from './citations.mjs';

const normalize = text => String(text ?? '').trim().replace(/^\s*(?:[-*•]|\d+[.)])\s+/, '').trim();
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const aggregate = (claims, required, rawAudit) => {
  const factual = claims.filter(claim => claim.factual), covered = factual.filter(claim => claim.citations.length > 0 && claim.citationAudit.remainingInvalidCount === 0);
  return { method: 'local-per-assertion-citation-coverage-v1', required, factualClaimCount: factual.length, coveredClaimCount: covered.length,
    missingClaimCount: factual.length - covered.length, coverage: factual.length ? covered.length / factual.length : null,
    complete: !required || factual.length > 0 && covered.length === factual.length,
    invalidClaimCount: factual.filter(claim => claim.citationAudit.hadInvalidIds).length,
    claims, citationAudit: rawAudit,
    limitation: 'Deterministic sentence/clause coverage and identifier validity. A valid identifier does not prove the source entails the claim or that all required facts were answered.' };
};

export function isFactualAssertion(text) {
  const value = normalize(text).replace(/\[\[PII_[^\]]+\]\]/g, 'opaque placeholder');
  if (!value || /^(?:answer|calculation|result|sources?|citations?|summary|notes?)\s*:?$/i.test(value)) return false;
  if (/^#{1,6}\s+/.test(value) && !/\b(?:is|are|costs?|takes?|requires?|has|have)\b/i.test(value)) return false;
  if (/^(?:i (?:cannot|can't|do not have)|(?:the )?(?:provided |supplied |retrieved )?evidence (?:is |does not |doesn't )|(?:not enough|insufficient|missing) (?:evidence|information|data)|cannot (?:determine|calculate)|not specified in (?:the )?(?:provided|supplied|retrieved))/i.test(value)) return false;
  return /[A-Za-z0-9]/.test(value);
}

/** Split measurable assertions, preserving decimals. This is a conservative
 * structural check, not a semantic factuality/entailment classifier. */
export function assertionSegments(text) {
  return String(text ?? '').split(/\.(?!\d)(?=\s|$)|[!?;\r\n]+|,\s+(?=(?:and\s+)?(?:the|it|each|freight|shipping|stock|warranty|total|delivery|replacement|price|cost)\b)|\s+(?:and|but|whereas)\s+(?=(?:the|it|each|freight|shipping|stock|warranty|total|delivery|replacement|price|cost)\b)/i).map(normalize).filter(Boolean);
}

function markerParts(text, prepared) {
  const ids = new Set((prepared.chunks ?? []).map(chunk => chunk.chunkId)), markers = [];
  const masked = String(text ?? '').replace(/\[\[PII_[^\]\r\n]+\]\]|\[([^\]\r\n]+)\]/g, (marker, body) => {
    if (body === undefined) return marker;
    const label = /^(?:cite|source|chunk)\s*[:#]\s*(.*)$/i.exec(body.trim()), candidate = (label ? label[1] : body).trim();
    if (!label && !ids.has(candidate) && !/^[A-Za-z0-9][A-Za-z0-9_.:/\\#-]*[-_.:/\\#][A-Za-z0-9_.:/\\#-]*$/.test(candidate)) return marker;
    const index = markers.push(candidate) - 1; return `\uE000${index}\uE001`;
  });
  return { masked, markers };
}
const markerToken = /\uE000(\d+)\uE001/g;
function cleanMarkers(text) { return String(text).replace(markerToken, '').trim(); }

export function auditInlineClaimCitations(text, prepared, { required = true } = {}) {
  const { masked, markers } = markerParts(text, prepared), units = assertionSegments(masked), rawClaims = [];
  for (let unit of units) {
    // A citation immediately following a full stop belongs to the preceding
    // assertion, never silently to a later sentence.
    const leading = /^\s*((?:\uE000\d+\uE001\s*)+)/.exec(unit);
    if (leading && rawClaims.length) {
      for (const match of leading[1].matchAll(markerToken)) rawClaims.at(-1).rawCitations.push(markers[Number(match[1])]);
      unit = unit.slice(leading[0].length);
    }
    const rawCitations = [...unit.matchAll(markerToken)].map(match => markers[Number(match[1])]), body = normalize(cleanMarkers(unit));
    if (!body) { if (rawClaims.length) rawClaims.at(-1).rawCitations.push(...rawCitations); continue; }
    rawClaims.push({ text: body, rawCitations });
  }
  const claims = rawClaims.map(claim => { const citationAudit = validateCitations(claim.rawCitations, prepared, { requireCitations: false }); return { text: claim.text, factual: isFactualAssertion(claim.text), citations: citationAudit.citations, citationAudit }; });
  const rawAudit = validateCitations(markers, prepared, { requireCitations: required });
  const renderedAnswer = claims.map(claim => `${claim.text}${claim.citations.length ? ` ${claim.citations.map(citation => `[cite: ${citation.chunkId}]`).join(' ')}` : ''}`).join('\n');
  return { ...aggregate(claims, required, rawAudit), answer: masked.replace(markerToken, '').replace(/[ \t]+(?=\n|$)/g, '').trim(), renderedAnswer };
}

export function auditStructuredClaimCitations(rawClaims, prepared, { required = true } = {}) {
  let malformed = !Array.isArray(rawClaims); const entries = malformed ? [] : rawClaims;
  const claims = [], allRaw = [];
  for (const entry of entries) {
    const valid = entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.text === 'string' && Array.isArray(entry.citations) && Object.keys(entry).every(key => ['text', 'citations'].includes(key));
    if (!valid) { malformed = true; allRaw.push(null); claims.push({ text: '', factual: true, citations: [], citationAudit: validateCitations([null], prepared, { requireCitations: false }) }); continue; }
    const embedded = markerParts(entry.text, prepared), embeddedBody = embedded.masked.replace(markerToken, '').trim(), sourceIds = [...entry.citations, ...embedded.markers];
    allRaw.push(...sourceIds);
    const citationAudit = validateCitations(sourceIds, prepared, { requireCitations: false });
    for (const text of assertionSegments(embeddedBody)) claims.push({ text, factual: isFactualAssertion(text), citations: citationAudit.citations, citationAudit });
  }
  const rawAudit = validateCitations(allRaw, prepared, { requireCitations: required }), audit = aggregate(claims, required, rawAudit);
  const body = entries.filter(entry => typeof entry?.text === 'string').map(entry => markerParts(entry.text, prepared).masked.replace(markerToken, '').trim()).filter(Boolean);
  const rendered = entries.filter(entry => typeof entry?.text === 'string').map(entry => {
    const embedded = markerParts(entry.text, prepared), validated = validateCitations([...(Array.isArray(entry.citations) ? entry.citations : []), ...embedded.markers], prepared, { requireCitations: false });
    return `${embedded.masked.replace(markerToken, '').trim()}${validated.citations.length ? ` ${validated.citations.map(citation => `[cite: ${citation.chunkId}]`).join(' ')}` : ''}`;
  });
  return { ...audit, malformed, complete: audit.complete && !malformed, answer: body.join('\n'), renderedAnswer: rendered.join('\n') };
}

/** Trusted calculator evidence is created only from the local tool's object,
 * after all operand-source IDs are checked against the retrieved allowlist. */
export function attachToolEvidence(prepared, toolResult) {
  if (toolResult?.status !== 'computed' || !Array.isArray(toolResult.calculations) || !toolResult.calculations.length || !Array.isArray(toolResult.claims) || !toolResult.claims.length) throw new Error('A fully computed local result with atomic claims is required');
  const sourceIds = [...new Set(toolResult.sourceChunkIds ?? [])], byId = new Map((prepared.chunks ?? []).map(chunk => [chunk.chunkId, chunk]));
  const questionOperands = calculation => Array.isArray(calculation.operands) && calculation.operands.length > 0 && calculation.operands.every(operand => operand?.origin === 'question' && Array.isArray(operand.sourceChunkIds) && operand.sourceChunkIds.length === 0 && typeof operand.value === 'number' && Number.isFinite(operand.value));
  const questionOnly = sourceIds.length === 0 && ['percentage', 'scalar', 'unit-conversion'].includes(toolResult.arithmeticIntent) && toolResult.calculations.every(questionOperands);
  if (!sourceIds.length && !questionOnly || sourceIds.some(id => !byId.has(id))) throw new Error('Calculator operands must cite retrieved source IDs or an allowlisted question-only calculation');
  for (const calculation of toolResult.calculations) {
    if (calculation.result != null && typeof calculation.result === 'number' && !Number.isFinite(calculation.result)) throw new Error('Calculator result must be finite');
    const inputs = calculation.sourceChunkIds ?? sourceIds;
    if (!Array.isArray(inputs) || !inputs.length && !questionOnly || inputs.some(id => !sourceIds.includes(id))) throw new Error('Calculation has an unverified operand source');
  }
  const provenance = { questionHash: digest(prepared.question), questionOnly, arithmeticIntent: toolResult.arithmeticIntent ?? null, toolId: toolResult.toolId ?? 'deterministic-local-calculator', calculations: toolResult.calculations,
    sources: sourceIds.map(id => ({ chunkId: id, hash: byId.get(id).hash ?? digest(byId.get(id).text) })) };
  const toolId = `calc:${digest(provenance)}`, claims = toolResult.claims.map(claim => {
    if (typeof claim?.text !== 'string' || !claim.text.trim()) throw new Error('Calculator claims must be nonempty text');
    const inputs = [...new Set(claim.sourceChunkIds ?? sourceIds)];
    if (!inputs.length && !questionOnly || inputs.some(id => !sourceIds.includes(id))) throw new Error('Calculator claim has an unverified operand source');
    return { text: claim.text, citations: [toolId, ...inputs] };
  });
  const text = `VERIFIED LOCAL CALCULATOR RESULT\n${claims.map(claim => claim.text).join('\n')}\n${questionOnly ? 'All numeric operands are supplied in the question. No company source document is required.' : `INPUT SOURCE IDS: ${sourceIds.join(', ')}`}`;
  const chunk = { chunkId: toolId, file: 'local-tools/calculator', location: 'deterministic local computation', text, hash: digest(text), sourceChunkIds: sourceIds, provenance,
    verifiedLocalTool: true, kind: 'local_calculator' };
  const augmented = { ...prepared, chunks: [...(prepared.chunks ?? []).filter(existing => existing.chunkId !== toolId), chunk] };
  return { prepared: augmented, toolId, claims, answerText: claims.map(claim => claim.text).join('\n'), provenance, chunk };
}
