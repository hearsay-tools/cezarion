import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export async function runTickWriterFixture(source: (path: string) => string, signal: AbortSignal,
  onSpawn?: (child: ChildProcess, root: string) => void): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'cez-tick-write-'));
  const path = join(root, 'ticks');
  const child = spawn(process.execPath, ['--eval', source(path)], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  const closed = new Promise<void>(resolve => child.once('close', () => resolve()));
  child.once('spawn', () => onSpawn?.(child, root));
  const reap = async () => {
    child.kill('SIGKILL');
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      // e2e-wait: process-deadline — bound acknowledgement of forced child cleanup
      const overdue = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('tick writer did not close after SIGKILL')), 1000); });
      await Promise.race([closed, overdue]);
    } finally { clearTimeout(timer); }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      const dispose = () => {
        child.off('message', onMessage);
        child.off('error', onError);
        child.off('exit', onExit);
        signal.removeEventListener('abort', onAbort);
      };
      const onMessage = () => { dispose(); resolve(); };
      const onError = (error: Error) => { dispose(); reject(error); };
      const onExit = () => onError(new Error('writer exited before truncating'));
      const onAbort = () => onError(signal.reason ?? new Error('tick observation aborted'));
      child.once('message', onMessage);
      child.once('error', onError);
      child.once('exit', onExit);
      signal.addEventListener('abort', onAbort, { once: true });
      if (signal.aborted) onAbort();
    });
    await reap();
    assert.throws(() => process.kill(child.pid!, 0), 'writer is reaped before reading ticks');
    return await readFile(path, 'utf8');
  } finally {
    try { await reap(); }
    finally { await rm(root, { recursive: true, force: true }); }
  }
}
