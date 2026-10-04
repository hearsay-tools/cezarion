import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { processStartToken } from '../delegation/process-liveness.ts';
import type { PreviewHost } from '../preview/host.ts';
import type { RunStore } from '../runs/store.ts';
import { armPreview, sweepRegisteredPreviewLeftovers } from './project-context.ts';

/**
 * Crash leftovers of EVERY registered project are swept at boot (#781 final review, Important 2),
 * not only when a project's context is first built: a dev server left running in a project nobody
 * opens this session would otherwise hold its port for the whole session. Two rules from Task 7
 * still hold: a data dir is swept once per process, and nothing a live host owns is killed. A data
 * dir another live cockpit owns is that cockpit's, so it is not swept at all.
 */

const FIXTURE = fileURLToPath(new URL('../preview/__fixtures__/fake-dev-server.mjs', import.meta.url));
const roots: string[] = [];
const strays: ChildProcess[] = [];

afterEach(() => {
  for (const stray of strays.splice(0)) {
    try { process.kill(-stray.pid!, 'SIGKILL'); } catch { /* gone */ }
    try { stray.kill('SIGKILL'); } catch { /* gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function project(): { root: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), 'cez-boot-sweep-'));
  roots.push(root);
  return { root, dataDir: join(root, '.ai/cezar') };
}

/** A detached stand-in dev server with its pid record, as a crashed cezar leaves it. */
function leftover(dataDir: string, runId: string, port: number): ChildProcess {
  const child = spawn(process.execPath, [FIXTURE, '--port', '0', '--delay', '600000'], { detached: true, stdio: 'ignore' });
  strays.push(child);
  const dir = join(dataDir, 'preview', runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${port}.pid.json`), JSON.stringify({ pid: child.pid, pgid: child.pid, startToken: processStartToken(child.pid!) }));
  return child;
}

const exited = (child: ChildProcess) => new Promise<void>(resolve => (child.exitCode !== null || child.signalCode !== null ? resolve() : child.once('exit', () => resolve())));
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const noHost = undefined;

describe('sweepRegisteredPreviewLeftovers', () => {
  it("kills every registered project's leftovers at boot, skipping a missing root", async () => {
    const a = project();
    const b = project();
    const strayA = leftover(a.dataDir, 'run-a', 5173);
    const strayB = leftover(b.dataDir, 'run-b', 5174);
    const killed = await sweepRegisteredPreviewLeftovers([
      { root: a.root, status: 'ok' },
      { root: b.root, status: 'ok' },
      { root: join(a.root, 'gone'), status: 'missing' },
    ], noHost);
    expect(killed).toBe(2);
    await Promise.all([exited(strayA), exited(strayB)]);
  });

  it('sweeps a data dir once per process: a later context build does not sweep it again', async () => {
    const a = project();
    await sweepRegisteredPreviewLeftovers([{ root: a.root, status: 'ok' }], noHost);
    const later = leftover(a.dataDir, 'run-c', 5175);
    armPreview(new EventEmitter() as unknown as RunStore, a.dataDir, noHost);
    expect(await sweepRegisteredPreviewLeftovers([{ root: a.root, status: 'ok' }], noHost)).toBe(0);
    expect(alive(later.pid!)).toBe(true);
  });

  it('spares what the live host owns: its dev servers and its browsers', async () => {
    const a = project();
    const server = leftover(a.dataDir, 'run-live', 5176);
    const host = { ownsServer: (runId: string, port: number) => runId === 'run-live' && port === 5176, ownsBrowser: () => false } as unknown as PreviewHost;
    expect(await sweepRegisteredPreviewLeftovers([{ root: a.root, status: 'ok' }], host)).toBe(0);
    expect(alive(server.pid!)).toBe(true);
    expect(existsSync(join(a.dataDir, 'preview', 'run-live', '5176.pid.json'))).toBe(true);
  });

  it("leaves a data dir another live cockpit owns alone, and lets a later context build sweep it", async () => {
    const a = project();
    const server = leftover(a.dataDir, 'run-other', 5177);
    const cockpit = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1 << 30)'], { stdio: 'ignore' });
    strays.push(cockpit);
    const lock = join(a.dataDir, 'cockpit.lock');
    writeFileSync(lock, JSON.stringify({ pid: cockpit.pid, token: randomUUID(), startToken: processStartToken(cockpit.pid!), url: 'http://127.0.0.1:4999' }));
    expect(await sweepRegisteredPreviewLeftovers([{ root: a.root, status: 'ok' }], noHost)).toBe(0);
    expect(alive(server.pid!)).toBe(true);

    // That cockpit is gone and this process builds the project's context: now it is swept.
    cockpit.kill('SIGKILL');
    await exited(cockpit);
    rmSync(lock);
    armPreview(new EventEmitter() as unknown as RunStore, a.dataDir, noHost);
    await exited(server);
  });
});

describe('armPreview', () => {
  it("a deleted run's release that fails never becomes an unhandled rejection", async () => {
    const a = project();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const store = new EventEmitter();
      const host = { release: () => Promise.reject(new Error('boom')), ownsServer: () => false, ownsBrowser: () => false } as unknown as PreviewHost;
      armPreview(store as unknown as RunStore, a.dataDir, host);
      store.emit('deleted', 'run-x');
      await new Promise(resolve => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });
});
