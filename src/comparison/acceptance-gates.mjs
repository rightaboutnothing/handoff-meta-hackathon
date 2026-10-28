import { createHash } from 'node:crypto';
import { isCloudEligible } from './policy.mjs';
import { validateCitations } from './citations.mjs';

export const ACCEPTANCE_GATE_VERSION = 'stage3-citation-source-truncation-gates-v1';
export const DEV_PARTITION_VERSION = 'stage3-dev-item-roles-v1';
export const DEV_ROLE_FRACTIONS = Object.freeze({ fit: .4, select: .1, calib: .4, audit: .1 });
const finite = value => typeof value === 'number' && Number.isFinite(value);
const number = (value, fallback = 0) => finite(value) ? value : fallback;
const clamp = value => Math.max(0, Math.min(1, number(value)));
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const unique = values => [...new Set(values)];
const company = item => /^company-data(?:[ -]|$)/.test(String(item?.category ?? ''));
export const acceptanceSlice = item => company(item) ? 'company' : 'general';
const rawAnswerOf = row => row?.rawAnswer ?? row?.raw ?? null;
const rawCheckOf = row => row?.rawCheck ?? null;
const outputCount = raw => raw?.tokens?.output;
const lengthStop = raw => ['length', 'max_tokens', 'max_output_tokens', 'token_limit'].includes(String(raw?.done_reason ?? raw?.doneReason ?? raw?.finish_reason ?? raw?.finishReason ?? raw?.stop_reason ?? '').toLowerCase());

function answerLimit(row, explicit) {
  const configured = row?.cohort === 'plain50' || row?.variant === 'plain' ? 384 : 768;
  const requested = rawAnswerOf(row)?.settings?.maxTokens;
  return Math.min(768, configured, finite(explicit) && explicit > 0 ? explicit : 768, finite(requested) && requested > 0 ? requested : 768);
}
function trustedCalculator(row, prepared) {
  const answer = row.answer ?? {}, raw = rawAnswerOf(row), byId = new Map((prepared?.chunks ?? []).map(chunk => [chunk.chunkId, chunk]));
  const tool = byId.get(answer.toolId);
  if (!tool || tool.verifiedLocalTool !== true || raw?.isToolResult !== true || raw.modelId !== 'deterministic-local-calculator') return false;
  const provenance = tool.provenance ?? answer.toolProvenance;
  if (!provenance || provenance.questionHash !== digest(prepared.question)) return false;
  const sources = provenance.sources ?? [];
  if (!sources.length && provenance.questionOnly !== true) return false;
  return sources.every(source => {
    const chunk = byId.get(source.chunkId);
    return chunk && chunk.verifiedLocalTool !== true && source.hash === (chunk.hash ?? digest(chunk.text));
  });
}

/** Runtime gates accept only answer-time model/tool metadata and retrieved
 * evidence. Oracle source lists, score labels and benchmark answers are ignored. */
export function evaluateAcceptanceGate(item, row = {}, prepared = {}, { answerCap = 768, selfCheckCap = 128, retrievalQualityThreshold = .35 } = {}) {
  if (!Number.isInteger(answerCap) || answerCap < 1 || answerCap > 768 || !Number.isInteger(selfCheckCap) || selfCheckCap < 1 || selfCheckCap > 128) throw new Error('Acceptance caps must be within the declared 768/128 limits');
  const safe = isCloudEligible(item), slice = acceptanceSlice(item);
  if (!safe) return { version: ACCEPTANCE_GATE_VERSION, eligible: false, localOnly: true, route: 'local_only_safety', slice, reasons: ['manifest_local_only'], checks: { manifestSafe: false } };
  const answer = row.answer ?? {}, check = answer.selfCheck ?? {}, raw = rawAnswerOf(row), rawCheck = rawCheckOf(row), toolVerified = trustedCalculator(row, prepared);
  const citationAudit = validateCitations(answer.citations ?? [], prepared, { requireCitations: slice === 'company' });
  const originalAudit = answer.citationAudit;
  const currentCap = answerLimit(row, answerCap), answerUsageKnown = toolVerified || finite(outputCount(raw)), checkUsageKnown = finite(outputCount(rawCheck));
  const answerTruncated = !toolVerified && (row.answerCapHit === true || lengthStop(raw) || finite(outputCount(raw)) && outputCount(raw) >= currentCap);
  const selfCheckTruncated = lengthStop(rawCheck) || checkUsageKnown && outputCount(rawCheck) >= selfCheckCap;
  const completeness = prepared.completeness?.score ?? row.runtimeCompleteness?.score;
  const claims = answer.claimAudit ?? row.claimAudit;
  const factualClaims = Array.isArray(claims?.claims) ? claims.claims.filter(claim => claim.factual === true) : [];
  const eachClaimValid = factualClaims.length > 0 && factualClaims.every(claim => {
    const audit = validateCitations(claim.citations ?? [], prepared, { requireCitations: true });
    return audit.grounded && audit.remainingInvalidCount === 0 && audit.rejectedIds.length === 0 && (claim.citationAudit?.remainingInvalidCount ?? 0) === 0;
  });
  const reasons = [], checks = {
    manifestSafe: true,
    executionAvailable: !row.error && !['error', 'unavailable', 'pending'].includes(row.status),
    answerParsed: answer.parseValid === true,
    selfCheckParsed: answer.selfCheckParseValid === true && check.parseValid !== false,
    selfCheckConfidenceValid: finite(check.confidence) && check.confidence >= 0 && check.confidence <= 1,
    answerUsageKnown, selfCheckUsageKnown: checkUsageKnown,
    answerNotTruncated: !answerTruncated, selfCheckNotTruncated: !selfCheckTruncated,
    citationAuditRecorded: Boolean(originalAudit),
    citationIdsValidated: citationAudit.remainingInvalidCount === 0 && citationAudit.rejectedIds.length === 0 && citationAudit.malformedCount === 0,
    noUnrepairedCitationErrors: Boolean(originalAudit) && originalAudit.remainingInvalidCount === 0 && (originalAudit.rejectedIds?.length ?? 0) === 0 && (originalAudit.malformedCount ?? 0) === 0,
    selfCheckSupported: check.evidenceSupported === true,
    selfCheckComplete: check.answerComplete === true,
    selfCheckNoIssues: Array.isArray(check.issues) && check.issues.every(issue => issue === 'none'),
    codeAssistanceFlagClear: answer.needsCloud === false,
    evidenceComplete: slice !== 'company' || finite(completeness) && completeness >= 1,
    bestMatchSufficient: slice !== 'company' || finite(prepared.bestMatchScore ?? prepared.retrievalScore) && (prepared.bestMatchScore ?? prepared.retrievalScore) >= retrievalQualityThreshold,
    companyCitationsPresent: slice !== 'company' || citationAudit.citations.length > 0 && !citationAudit.missingRequired,
    companyClaimsComplete: slice !== 'company' || Boolean(claims) && claims.complete === true && number(claims.factualClaimCount) > 0 && claims.factualClaimCount === factualClaims.length && claims.coveredClaimCount === claims.factualClaimCount && claims.missingClaimCount === 0 && eachClaimValid,
  };
  const codes = { executionAvailable: 'execution_unavailable', answerParsed: 'answer_parse_failure', selfCheckParsed: 'self_check_parse_failure', selfCheckConfidenceValid: 'invalid_self_check_confidence', answerUsageKnown: 'answer_usage_unknown', selfCheckUsageKnown: 'self_check_usage_unknown', answerNotTruncated: 'answer_truncated', selfCheckNotTruncated: 'self_check_truncated', citationAuditRecorded: 'citation_audit_missing', citationIdsValidated: 'citation_id_not_retrieved', noUnrepairedCitationErrors: 'unrepaired_citation_error', selfCheckSupported: 'self_check_unsupported', selfCheckComplete: 'self_check_incomplete', selfCheckNoIssues: 'self_check_issue', codeAssistanceFlagClear: 'code_requires_assistance', evidenceComplete: 'incomplete_sources', companyCitationsPresent: 'company_citations_missing', companyClaimsComplete: 'claim_citations_incomplete' };
  for (const [name, value] of Object.entries(checks)) if (!value) reasons.push(codes[name] ?? name);
  return { version: ACCEPTANCE_GATE_VERSION, eligible: reasons.length === 0, localOnly: false, route: reasons.length ? 'escalate' : 'eligible_for_calibrated_acceptance', slice, reasons, checks,
    answerCap: currentCap, selfCheckCap, answerTruncated, selfCheckTruncated, calculatorVerified: toolVerified,
    evidenceCompleteness: slice === 'company' && finite(completeness) ? completeness : null,
    evidenceCompletenessApplicable: slice === 'company', validCitationCount: citationAudit.citations.length,
    limitation: 'Runtime inferred source completeness and structural claim citations are required; oracle source references and semantic correctness are not available to this gate.' };
}

/** Explicit feature allowlist. Never serialize the item, prepared question,
 * references, labels, IDs or model output text into learned features. */
export function extractAcceptanceFeatures(item, row = {}, prepared = {}, suppliedGate) {
  const gate = suppliedGate ?? evaluateAcceptanceGate(item, row, prepared), answer = row.answer ?? {}, check = answer.selfCheck ?? {}, claims = answer.claimAudit ?? row.claimAudit;
  const sourceChunks = (prepared.chunks ?? []).filter(chunk => chunk.verifiedLocalTool !== true), raw = rawAnswerOf(row), rawCheck = rawCheckOf(row), slice = acceptanceSlice(item);
  return {
    confidence: clamp(check.confidence ?? answer.confidence),
    retrievalScore: clamp(prepared.bestMatchScore ?? prepared.retrievalScore ?? prepared.quality ?? answer.features?.retrievalScore),
    evidenceCompleteness: slice === 'company' ? clamp(prepared.completeness?.score ?? row.runtimeCompleteness?.score) : 0,
    evidenceCompletenessApplicable: Number(slice === 'company'),
    sourceDocCount: unique(sourceChunks.map(chunk => chunk.file).filter(Boolean)).length,
    hasValidCitations: gate.checks?.citationIdsValidated === true && (slice !== 'company' || gate.checks?.companyCitationsPresent === true),
    citationCount: number(gate.validCitationCount),
    claimCoverage: slice === 'company' ? clamp(claims?.coverage) : 0,
    claimCoverageApplicable: Number(slice === 'company'),
    calculatorVerified: gate.calculatorVerified === true,
    answerTokens: number(outputCount(raw)), selfCheckTokens: number(outputCount(rawCheck)),
    answerCapFraction: gate.calculatorVerified ? 0 : number(outputCount(raw)) / (gate.answerCap ?? 768),
    selfCheckCapFraction: number(outputCount(rawCheck)) / (gate.selfCheckCap ?? 128),
    answerCharacterCount: typeof answer.answer === 'string' ? answer.answer.length : 0,
    needsCloud: answer.needsCloud !== false, gatePassed: gate.eligible === true,
    category: String(item.category ?? 'unclassified'), slice,
  };
}

/** Randomized ITEM roles within each slice, conditional on a fixed finite dev
 * frame. Groups may cross roles; disclose that fact instead of claiming source-
 * group independence. No test items or IDs are admitted. */
export function partitionDevItems(items, { seed = 20261027, roles = DEV_ROLE_FRACTIONS, expectedDevIds, purpose = DEV_PARTITION_VERSION } = {}) {
  const roleNames = ['fit', 'select', 'calib', 'audit'];
  if (!Array.isArray(items) || !items.length || !Number.isInteger(seed)) throw new Error('A nonempty dev frame and integer seed are required');
  if (JSON.stringify(Object.keys(roles)) !== JSON.stringify(roleNames) || roleNames.some(name => !finite(roles[name]) || roles[name] <= 0) || Math.abs(roleNames.reduce((sum, name) => sum + roles[name], 0) - 1) > 1e-12) throw new Error('Roles must be ordered fit/select/calib/audit with positive fractions summing to one');
  if (items.some(item => !item?.id || !['dev', 'dev-train'].includes(item.split))) throw new Error('Partition accepts dev/dev-train items only; test data is forbidden');
  const ids = items.map(item => item.id); if (new Set(ids).size !== ids.length) throw new Error('Dev IDs must be unique');
  const expected = expectedDevIds ? new Set(expectedDevIds) : null;
  if (expected && (expected.size !== expectedDevIds.length || expectedDevIds.length !== ids.length || ids.some(id => !expected.has(id)))) throw new Error('Partition frame differs from the exact registered dev IDs');
  const assignments = {}, roleIds = Object.fromEntries(roleNames.map(name => [name, []])), slices = {};
  for (const slice of ['company', 'general']) {
    const selected = items.filter(item => acceptanceSlice(item) === slice).sort((a, b) => digest([seed, purpose, slice, a.id]).localeCompare(digest([seed, purpose, slice, b.id])) || a.id.localeCompare(b.id));
    const counts = {}; let used = 0;
    for (const name of roleNames.slice(0, -1)) { counts[name] = Math.floor(selected.length * roles[name]); used += counts[name]; }
    counts.audit = selected.length - used;
    let at = 0;
    for (const name of roleNames) for (const item of selected.slice(at, at += counts[name])) { assignments[item.id] = name; roleIds[name].push(item.id); }
    const groups = new Map(); for (const item of selected) { const group = item.groupId ?? item.id; if (!groups.has(group)) groups.set(group, new Set()); groups.get(group).add(assignments[item.id]); }
    slices[slice] = { items: selected.length, groups: groups.size, roles: Object.fromEntries(roleNames.map(name => [name, { items: counts[name], groups: new Set(selected.filter(item => assignments[item.id] === name).map(item => item.groupId ?? item.id)).size }])),
      sharedGroups: [...groups.values()].filter(value => value.size > 1).length,
      groupRoleOverlap: [...groups].filter(([, value]) => value.size > 1).map(([groupId, value]) => ({ groupId, roles: [...value].sort() })).sort((a, b) => a.groupId.localeCompare(b.groupId)) };
  }
  return { version: DEV_PARTITION_VERSION, seed, purpose, samplingUnit: 'item', inputSplit: 'dev-train only', roles: { ...roles }, assignments, roleIds, slices,
    devIdsHash: digest([...ids].sort()), assignmentHash: digest(Object.entries(assignments).sort(([a], [b]) => a.localeCompare(b))),
    guaranteeScope: 'Randomized finite dev-item frame conditional on the frozen fit/selection policy; not source-group-disjoint and not a future-family certificate.',
    allItemsAssigned: Object.keys(assignments).length === items.length };
}
