import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const roots: string[] = [];
const TEST_TIMEOUT_MS = 30_000;

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'cez-chk-'));
  roots.push(root);
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@l', 'commit', '--allow-empty', '-q', '-m', 'b'], { cwd: root });
  const store = RunStore.open(join(root, '.ai/cezar'));
  return { root, store, manager: new RunManager(store, root) };
}

async function waitFor(pred: () => boolean, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const pidOf = (file: string) => Number(readFileSync(file, 'utf8').trim());

function startCheck(f: ReturnType<typeof fixture>, command: string) {
  const run = f.manager.startRun({ name: 'chk', source: 'built-in', steps: [{ id: 'c', command }] }, { task: 't', worktree: false });
  return run.id;
}

afterEach(() => { for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true }); });

describe('Stop on a workflow check (#496)', () => {
  it('kills a check that ignores SIGTERM and confirms the group is gone', async () => {
    const f = fixture();
    const pidFile = join(f.root, 'pid');
    const id = startCheck(f, `trap '' TERM; echo $$ > ${pidFile}; while true; do sleep 0.1; done`);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 'check start');
    const pid = pidOf(pidFile);
    const t0 = Date.now();
    expect(f.manager.cancel(id)).toBe(true);
    expect(f.manager.cancel(id)).toBe(true); // repeated Stop is safe
    await waitFor(() => !f.manager.isActive(id), 'run to release');
    expect(alive(pid)).toBe(false);
    expect(Date.now() - t0).toBeLessThan(12_000);
    expect(f.store.getRun(id)?.status).toBe('cancelled');
  }, TEST_TIMEOUT_MS);

  it('kills descendants that hold the output pipes open', async () => {
    const f = fixture();
    const pidFile = join(f.root, 'child');
    const id = startCheck(f, `(trap '' TERM; while true; do sleep 0.1; done) & echo $! > ${pidFile}; wait`);
    await waitFor(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim() !== '', 'child start');
    const child = pidOf(pidFile);
    f.manager.cancel(id);
    await waitFor(() => !f.manager.isActive(id), 'run to release');
    expect(alive(child)).toBe(false);
  }, TEST_TIMEOUT_MS);

  it('preserves exit status and output of a normal check', async () => {
    const f = fixture();
    const id = startCheck(f, 'echo hello; echo oops >&2; exit 3');
    await waitFor(() => !f.manager.isActive(id), 'run to finish');
    const ev = f.store.readEvents(id).find((e) => e.type === 'check-output') as { text: string; exitCode: number } | undefined;
    expect(ev?.exitCode).toBe(3);
    expect(ev?.text).toContain('hello');
    expect(ev?.text).toContain('oops');
    expect(f.store.getRun(id)?.status).toBe('failed');
  }, TEST_TIMEOUT_MS);
});
