import { mkdir, open, readFile, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export class CloudBudgetError extends Error {
  constructor(message) { super(message); this.code = 'CLOUD_BUDGET_EXHAUSTED'; }
}
function totals(state) {
  const attempts = Object.values(state.attempts);
  const reservedUsd = attempts.filter(a => a.state !== 'settled').reduce((s, a) => s + a.upperBoundUsd, 0);
  const meteredUsd = attempts.filter(a => a.state === 'settled').reduce((s, a) => s + a.meteredUsd, 0);
  const providerKnown = attempts.filter(a => a.state === 'settled' && Number.isFinite(a.providerReportedCostUsd));
  const providerReportedKnownUsd = providerKnown.reduce((s, a) => s + a.providerReportedCostUsd, 0);
  const unknownProviderCostAttempts = attempts.length - providerKnown.length;
  return { capUsd: state.capUsd, meteredUsd, reservedUsd, committedUsd: meteredUsd + reservedUsd,
    providerReportedCostUsd: unknownProviderCostAttempts ? null : providerReportedKnownUsd,
    providerReportedKnownUsd, unknownProviderCostAttempts, attempts: attempts.length,
    exhausted: !!state.overrun || meteredUsd + reservedUsd >= state.capUsd,
    assumptions: true, budgetSemantics: 'Usage priced at config assumptions plus outstanding upper-bound reservations; provider invoice is separate' };
}
/** A cross-process lock protects durable per-attempt reservations and resumptions. */
export function createCloudBudget({ directory, capUsd = Number(process.env.CLOUD_BUDGET_USD) } = {}) {
  if (!Number.isFinite(capUsd) || capUsd <= 0) throw new CloudBudgetError('Set CLOUD_BUDGET_USD above 0 before a cloud tier');
  if (!directory) throw new Error('Cloud budget requires a durable checkpoint directory');
  const file = path.join(directory, 'cloud-budget.json');
  const lock = `${file}.lock`;
  async function transaction(fn) {
    await mkdir(directory, { recursive: true });
    let handle;
    for (let attempt = 0; attempt < 300; attempt++) {
      try { handle = await open(lock, 'wx'); break; }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
    }
    if (!handle) throw new CloudBudgetError('Budget checkpoint lock is busy; no cloud request dispatched');
    try {
      let state;
      try { state = JSON.parse(await readFile(file, 'utf8')); }
      catch (error) { if (error.code !== 'ENOENT') throw error; state = { schemaVersion: 1, capUsd, attempts: {} }; }
      if (state.capUsd !== capUsd) throw new CloudBudgetError('Resumed budget cap differs from checkpoint; preserve the original cap');
      const result = await fn(state);
      const temporary = `${file}.${randomUUID()}.tmp`;
      const output = await open(temporary, 'wx');
      try { await output.writeFile(`${JSON.stringify(state, null, 2)}\n`); await output.sync(); }
      finally { await output.close(); }
      await rename(temporary, file);
      return result;
    } finally { await handle.close(); await unlink(lock); }
  }
  return {
    async reserve({ requestId = randomUUID(), cloudId, upperBoundUsd }) {
      if (!Number.isFinite(upperBoundUsd) || upperBoundUsd < 0) throw new Error('Invalid reservation upper bound');
      return transaction(state => {
        if (state.attempts[requestId]) throw new CloudBudgetError('Attempt already reserved; retry with a new attempt ID');
        if (state.overrun || totals(state).committedUsd + upperBoundUsd > state.capUsd + 1e-12) throw new CloudBudgetError('Cloud cap reached before dispatch');
        state.attempts[requestId] = { requestId, cloudId, upperBoundUsd, state: 'reserved', reservedAt: new Date().toISOString() };
        return { requestId, upperBoundUsd, ...totals(state) };
      });
    },
    async settle(requestId, { meteredUsd, providerReportedCostUsd = null, usageKnown = true } = {}) {
      return transaction(state => {
        const attempt = state.attempts[requestId];
        if (!attempt) throw new Error('Cannot settle an unreserved cloud attempt');
        if (attempt.state === 'settled') throw new Error('Cloud attempt already settled');
        if (!usageKnown || !Number.isFinite(meteredUsd) || meteredUsd < 0) { attempt.state = 'unknown'; return totals(state); }
        const charge = Math.max(meteredUsd, Number.isFinite(providerReportedCostUsd) ? providerReportedCostUsd : 0);
        if (charge > attempt.upperBoundUsd + 1e-12) {
          state.overrun = true;
          Object.assign(attempt, { state: 'settled', meteredUsd: charge, providerReportedCostUsd, overrun: true, settledAt: new Date().toISOString() });
          return { ...totals(state), overrun: true };
        }
        Object.assign(attempt, { state: 'settled', meteredUsd: charge, providerReportedCostUsd, settledAt: new Date().toISOString() });
        return totals(state);
      });
    },
    async markUnknown(requestId) { return transaction(state => { if (!state.attempts[requestId]) throw new Error('Unknown cloud attempt'); if (state.attempts[requestId].state !== 'settled') state.attempts[requestId].state = 'unknown'; return totals(state); }); },
    async status() { return transaction(state => totals(state)); },
  };
}
