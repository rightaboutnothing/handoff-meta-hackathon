import { createHash } from 'node:crypto';

export const CLOUD_CATEGORY_ALLOWLIST = Object.freeze([
  'reasoning', 'knowledge', 'instruction-following', 'safety-boundary', 'privacy',
  'company-data single-doc', 'company-data multi-doc',
  'company-data-single-doc', 'company-data-multi-doc',
]);
const categories = new Set(CLOUD_CATEGORY_ALLOWLIST);
const registries = new WeakMap();
const forbidden = /harmful|red[-_ ]?team|poison|strongreject/i;

function safetyKind(item) { return item?.safety?.kind ?? item?.safetyKind ?? item?.safety; }
function explicitSafe(item) {
  return safetyKind(item) === 'safe' && (item?.safety?.cloudEligible ?? item?.cloudEligible) === true;
}
export function isCloudEligible(item) {
  if (!item || !item.id || !categories.has(item.category) || !explicitSafe(item)) return false;
  if (item.harmful || item.redTeam || item.poisoning || item.localOnly) return false;
  return ![item.suite, item.category, safetyKind(item), item.type].some(value => forbidden.test(String(value ?? '')));
}
function identity(item) {
  return JSON.stringify({ id: item.id, suite: item.suite, category: item.category,
    safetyKind: safetyKind(item), cloudEligible: item?.safety?.cloudEligible ?? item?.cloudEligible,
    harmful: !!item.harmful, redTeam: !!item.redTeam, poisoning: !!item.poisoning, localOnly: !!item.localOnly,
    promptHash: createHash('sha256').update(String(item.prompt ?? '')).digest('hex') });
}
/** Snapshot the trusted dataset manifest before any routing/control can alter an item. */
export function createCloudPolicyRegistry(items) {
  const records = new Map();
  for (const item of items) {
    if (!item.id || records.has(item.id)) throw new Error('Cloud policy registry requires unique item IDs');
    records.set(item.id, { identity: identity(item), eligible: isCloudEligible(item) });
  }
  const registry = Object.freeze({ count: records.size });
  registries.set(registry, records);
  return registry;
}
/** Called inside each cloud client, even for cloud-only and Guard OFF controls. */
export function assertCloudEligible(item, registry) {
  const record = registries.get(registry)?.get(item?.id);
  if (!record?.eligible || record.identity !== identity(item) || !isCloudEligible(item)) {
    const error = new Error('Cloud boundary denied: item is local-only, unregistered, or its manifest metadata changed');
    error.code = 'LOCAL_ONLY_ITEM';
    throw error;
  }
  return true;
}
