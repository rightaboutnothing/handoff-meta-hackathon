import { mkdir, open, readFile, rename, rmdir, unlink, lstat } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

const busy = () => Object.assign(new Error('Comparison lock is busy or its owner cannot be proven dead'), { code: 'COMPARISON_LOCK_BUSY' });
export function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'ESRCH' ? false : null; }
}
/** Atomic directory ownership; nonempty dead-owner tombstones prevent two stale
 * reclaimers from moving/deleting a newly acquired lock. Keep tombstones local. */
export async function acquireRunLock(lockPath, { owner = {}, isAlive = processIsAlive, attempts = 1, delayMs = 20, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)) } = {}) {
  lockPath = path.resolve(lockPath);
  await mkdir(path.dirname(lockPath), { recursive: true });
  const record = { ...owner, pid: process.pid, token: randomUUID(), createdAt: new Date().toISOString() };
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await mkdir(lockPath);
      const handle = await open(path.join(lockPath, 'owner.json'), 'wx', 0o600);
      try { await handle.writeFile(JSON.stringify(record)); await handle.sync(); } finally { await handle.close(); }
      let released = false;
      return async () => {
        if (released) return;
        let current; try { current = JSON.parse(await readFile(path.join(lockPath, 'owner.json'), 'utf8')); } catch { return; }
        if (current.token !== record.token) return;
        const releasedPath = `${lockPath}.released-${record.token}`;
        await rename(lockPath, releasedPath);
        released = true;
        await unlink(path.join(releasedPath, 'owner.json')); await rmdir(releasedPath);
      };
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      let contents, previous;
      try {
        const info = await lstat(lockPath);
        if (!info.isDirectory() || info.isSymbolicLink()) throw busy();
        contents = await readFile(path.join(lockPath, 'owner.json'), 'utf8'); previous = JSON.parse(contents);
        if (!/^[a-zA-Z0-9-]{1,100}$/.test(previous.token ?? '') || await isAlive(previous.pid) !== false) throw busy();
        if (await readFile(path.join(lockPath, 'owner.json'), 'utf8') !== contents) throw busy();
        // A second reclaimer targeting this token hits a nonempty directory.
        await rename(lockPath, `${lockPath}.stale-${previous.token}`);
        attempt--; continue;
      } catch (recoveryError) {
        if (recoveryError.code === 'ENOENT') {
          try { await lstat(lockPath); } catch (missing) { if (missing.code === 'ENOENT') { attempt--; continue; } throw missing; }
          // An owner may still be writing owner.json. A crashed empty lock is
          // ambiguous and stays closed rather than being guessed stale.
        }
        if (!(recoveryError instanceof SyntaxError) && !['COMPARISON_LOCK_BUSY', 'ENOENT', 'EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(recoveryError.code)) throw recoveryError;
      }
      if (attempt + 1 < attempts) await sleep(delayMs);
    }
  }
  throw busy();
}
