import { mkdir, rmdir, stat, utimes } from 'node:fs/promises';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
export class LockBusyError extends Error {}

/** npm libnpmexec's concurrency.lock protocol: mkdir, 1s heartbeat, 60s stale mtime. */
export async function withDirectoryLock<T>(path: string, operation: (assertOwned: () => Promise<void>, signal: AbortSignal) => Promise<T>, waitMs = 15_000): Promise<T> {
  const started = Date.now();
  while (true) {
    if (Date.now() - started > waitMs) throw new LockBusyError('update lock is busy; retry shortly');
    try { await mkdir(path); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const current = await stat(path).catch(() => undefined);
      if (current && Date.now() - current.mtimeMs > 60_000) {
        await rmdir(path).catch(() => undefined);
      }
      if (Date.now() - started > waitMs) throw new LockBusyError('update lock is busy; retry shortly');
      await sleep(Math.min(100, Math.max(1, waitMs - (Date.now() - started))));
    }
  }
  const acquired = await stat(path);
  const controller = new AbortController();
  let expectedMtime = Math.round(acquired.mtimeMs / 1000);
  let compromised = false;
  const rawCheck = async () => {
    if (compromised) throw new Error('update lock ownership changed');
    const current = await stat(path).catch(() => undefined);
    if (!current || current.ino !== acquired.ino || Math.round(current.mtimeMs / 1000) !== expectedMtime) {
      compromised = true;
      controller.abort();
      throw new Error('update lock ownership changed');
    }
  };
  let heartbeat = Promise.resolve();
  const assertOwned = async () => { await heartbeat; await rawCheck(); };
  const timer = setInterval(() => {
    heartbeat = heartbeat.then(async () => {
      try {
        await rawCheck();
        const next = Math.round(Date.now() / 1000);
        await utimes(path, next, next);
        expectedMtime = next;
      } catch { compromised = true; controller.abort(); }
    });
  }, 1000);
  timer.unref?.();
  try {
    const result = await operation(assertOwned, controller.signal);
    await assertOwned();
    return result;
  } finally {
    clearInterval(timer);
    await heartbeat;
    if (!compromised) await rmdir(path).catch(() => undefined);
  }
}
