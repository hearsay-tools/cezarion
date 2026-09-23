import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { runOwnedNpm } from './npm-process.ts';

const roots: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

it('reports ownership loss when a lock abort follows npm timeout but precedes child exit', async () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-npm-timeout-abort-')); roots.push(root);
  const script = join(root, 'npm.cjs'); const ready = join(root, 'ready');
  writeFileSync(script, `const fs=require('node:fs');
fs.writeFileSync(${JSON.stringify(ready)},String(process.pid));
process.on('SIGTERM',()=>{}); setInterval(()=>{},100);`);
  const controller = new AbortController();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  const run = runOwnedNpm(process.execPath, [script], {}, controller.signal);
  const readyDeadline = Date.now() + 2_000;
  while (Date.now() < readyDeadline && !existsSync(ready)) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
  expect(existsSync(ready)).toBe(true);
  const pid = Number(readFileSync(ready, 'utf8'));
  try {
    await vi.advanceTimersByTimeAsync(120_000);
    controller.abort();
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run).rejects.toThrow('update lock ownership changed');
    expect(() => process.kill(pid, 0)).toThrow();
  } finally {
    try { process.kill(pid, 'SIGKILL'); } catch { /* already reaped */ }
  }
});
