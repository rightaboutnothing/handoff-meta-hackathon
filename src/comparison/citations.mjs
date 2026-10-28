// Citation repair is a local identifier lookup, never a semantic/source guess.
// Preserve pre-repair errors so repairing an answer cannot hide model failures.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const string = value => typeof value === 'string' && value.length > 0;
const folded = value => value.toLowerCase();
function unwrap(value) {
  let result = value.trim(), previous;
  do {
    previous = result;
    if (/^`[^`]*`$/.test(result)) result = result.slice(1, -1).trim();
    else if (/^\[[^\[\]]*\]$/.test(result)) result = result.slice(1, -1).trim();
    else if (/^"[^"]*"$/.test(result) || /^'[^']*'$/.test(result)) result = result.slice(1, -1).trim();
  } while (result !== previous);
  return result;
}
const pathAlias = value => folded(unwrap(value).replaceAll('\\', '/').replace(/^\.\//, ''));
const baseName = value => value.replaceAll('\\', '/').split('/').at(-1);
function addAlias(map, alias, chunkId) {
  if (!string(alias)) return;
  const key = pathAlias(alias);
  if (!map.has(key)) map.set(key, new Set());
  map.get(key).add(chunkId);
}
function citationId(entry) {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
  const candidates = ['chunkId', 'id'].filter(key => own(entry, key)).map(key => entry[key]);
  // Conflicting/malformed identifier fields never silently select one source.
  if (!candidates.length || candidates.some(value => typeof value !== 'string') || new Set(candidates).size !== 1) return null;
  return candidates[0];
}

/** Validate against retrieved chunks only. options.requireCitations defaults to
 * true when evidence exists. Model-provided filenames/hashes are ignored. */
export function validateCitations(rawCitations, prepared, { requireCitations = Boolean(prepared?.chunks?.length) } = {}) {
  const chunks = Array.isArray(prepared?.chunks) ? prepared.chunks : [], byId = new Map(), ambiguous = new Set();
  for (const chunk of chunks) {
    if (!string(chunk?.chunkId)) continue;
    const prior = byId.get(chunk.chunkId);
    if (prior && JSON.stringify([prior.file, prior.location ?? null, prior.hash ?? null, prior.text ?? null]) !== JSON.stringify([chunk.file, chunk.location ?? null, chunk.hash ?? null, chunk.text ?? null])) ambiguous.add(chunk.chunkId);
    else byId.set(chunk.chunkId, chunk);
  }
  for (const id of ambiguous) byId.delete(id);
  const idAliases = new Map(), sourceAliases = new Map();
  for (const chunk of byId.values()) {
    const idKey = folded(chunk.chunkId);
    if (!idAliases.has(idKey)) idAliases.set(idKey, new Set());
    idAliases.get(idKey).add(chunk.chunkId);
    if (string(chunk.file)) { addAlias(sourceAliases, chunk.file, chunk.chunkId); addAlias(sourceAliases, baseName(chunk.file), chunk.chunkId); }
    for (const alias of [chunk.label, chunk.chunkLabel]) if (string(alias)) addAlias(sourceAliases, alias, chunk.chunkId);
  }
  const containerValid = rawCitations == null || Array.isArray(rawCitations) || typeof rawCitations === 'string' || Boolean(rawCitations && typeof rawCitations === 'object');
  const entries = rawCitations == null ? [] : Array.isArray(rawCitations) ? rawCitations : [rawCitations];
  const rawIds = [], invalidIds = [], rejectedIds = [], repaired = [], citations = [], seen = new Set(), repairSeen = new Set();
  let malformedCount = 0, duplicateCount = 0;
  for (const entry of entries) {
    const raw = citationId(entry);
    if (raw === null || !raw.trim()) { malformedCount += 1; continue; }
    rawIds.push(raw);
    let id = byId.has(raw) ? raw : null, reason = null;
    if (!id) {
      invalidIds.push(raw);
      const clean = unwrap(raw);
      if (byId.has(clean)) { id = clean; reason = 'formatting_only_exact_id'; }
      else {
        const aliases = idAliases.get(folded(clean));
        if (aliases?.size === 1) { id = [...aliases][0]; reason = 'case_only_unique_id'; }
        else if (!aliases && !ambiguous.has(clean)) {
          const sources = sourceAliases.get(pathAlias(clean));
          if (sources?.size === 1) { id = [...sources][0]; reason = 'unique_retrieved_source_alias'; }
        }
      }
    }
    if (!id) { rejectedIds.push(raw); continue; }
    if (reason && !repairSeen.has(`${raw}\0${id}`)) { repaired.push({ from: raw, to: id, reason }); repairSeen.add(`${raw}\0${id}`); }
    if (seen.has(id)) { duplicateCount += 1; continue; }
    seen.add(id);
    const chunk = byId.get(id);
    citations.push({ chunkId: id, file: chunk.file ?? null, location: chunk.location ?? null, hash: chunk.hash ?? null, valid: true });
  }
  const remainingInvalidCount = rejectedIds.length + malformedCount;
  return { citations, rawIds, invalidIds: [...new Set(invalidIds)], repaired, rejectedIds: [...new Set(rejectedIds)],
    hadInvalidIds: invalidIds.length > 0 || malformedCount > 0, remainingInvalidCount,
    grounded: citations.length > 0 && remainingInvalidCount === 0,
    missingRequired: requireCitations && citations.length === 0, malformedCount, duplicateCount, containerValid };
}
