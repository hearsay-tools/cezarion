import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { expect, it, vi } from 'vitest';
import { acquireTestEnvLease, identity } from '../../../.ai/scripts/test-env-lease.mjs';
import { processStartToken } from './detached-process.ts';
import { hasLinuxPython, singleThreadZombie, threadHoldingPort } from './linux-zombie.testkit.ts';

const scope = vi.hoisted(() => ({ pid: undefined as number | undefined }));
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs')>();
  return { ...fs, readdirSync: (...args: Parameters<typeof fs.readdirSync>) =>
    args[0] === '/proc' && scope.pid !== undefined ? [String(scope.pid)] : fs.readdirSync(...args) };
});

it.runIf(hasLinuxPython)('identity keeps a zombie leader with a live thread', async () => {
  const holder = await threadHoldingPort();
  try { expect(identity(holder.pid).start).toBe(processStartToken(holder.pid)); }
  finally { await holder.stop(); }
});

it.runIf(hasLinuxPython)('a live thread in a zombie-led group retains the lease', async () => {
  const holder = await threadHoldingPort();
  const root = mkdtempSync(join(tmpdir(), 'cez-thread-lease-'));
  scope.pid = holder.pid;
  try {
    const initial = await acquireTestEnvLease(root); initial.release();
    const db = new DatabaseSync(join(root, '.ai/qa/test-env-lease.sqlite'));
    try {
      db.prepare('INSERT INTO holders (id, token, pid, start, pgid) VALUES (?, ?, ?, ?, ?)')
        .run('dead-leader', 'old', 2147483000, null, holder.pid);
      await expect(acquireTestEnvLease(root, { timeoutMs: 50 })).rejects.toThrow(/timed out/i);
    } finally { db.close(); }
  } finally { scope.pid = undefined; await holder.stop(); rmSync(root, { recursive: true, force: true }); }
});

it.runIf(process.platform === 'linux')('a single-thread zombie is dead and its group releases the lease', async () => {
  const zombie = await singleThreadZombie();
  const root = mkdtempSync(join(tmpdir(), 'cez-zombie-lease-'));
  scope.pid = zombie.pid;
  try {
    expect(identity(zombie.pid).dead).toBe(true);
    const initial = await acquireTestEnvLease(root); initial.release();
    const db = new DatabaseSync(join(root, '.ai/qa/test-env-lease.sqlite'));
    try {
      db.prepare('INSERT INTO holders (id, token, pid, start, pgid) VALUES (?, ?, ?, ?, ?)')
        .run('zombie', 'old', zombie.pid, null, zombie.pid);
      const next = await acquireTestEnvLease(root, { timeoutMs: 5000 }); next.release();
    } finally { db.close(); }
  } finally { scope.pid = undefined; await zombie.stop(); rmSync(root, { recursive: true, force: true }); }
});
