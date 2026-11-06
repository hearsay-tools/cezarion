import { testHome } from '../home/test-home.testkit.ts';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { RUN_STATUS, STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { createFixtureManager, fixtureWorkSettled, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { scopeFixtureProcesses } from '../delegation/process-scope.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, vi } from 'vitest';
import { managerDisposed } from './fixture-cleanup.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { planOwnedWorkspace } from '../delegation/workspace.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { RunManager } from './run.ts';

/** Hang guard for the waits below: each ends the moment its condition holds, so the bound only ends a hang. */
export const HANG_GUARD_MS = 15_000;

export const until = async (predicate: () => boolean) => vi.waitFor(() => expect(predicate()).toBe(true), { timeout: 15_000, interval: 10 });
export function gate() { let release!: () => void; const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release }; }

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.
export let root: string, store: RunStore, manager: RunManager, parent: RunRecord;
export const releases: Array<() => void> = [];
export function useWorkerDestroyFixture(): void {
  beforeEach(() => {
    scopeFixtureProcesses();
    vi.stubEnv('CEZ_DRY_RUN', '1'); vi.stubEnv('CEZ_AUTONAME', '0');
    // Workers ignore the no-wait nudge and reach their plain park (hearsay-tools/cezarion#1234).
    vi.stubEnv('CEZ_MOCK_NUDGE_REPLY', 'plain');
    root = mkdtempSync(join(tmpdir(), 'cez-worker-destroy-'));
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
    execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
    execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
    store = RunStore.open(join(root, '.ai/cezar'), { keepLive: true });
    manager = createFixtureManager(store, root, { home: testHome(), semaphore: new WorkspaceSemaphore({ home: testHome(), initial: { maxParallel: 1 } }) });

    parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    setRunStatus(store, parent.id, RUN_STATUS.waiting, { delegation: { role: 'root', permissions: ['spawn'], receipts: [] } });
  });
  afterEach(async () => {
    for (const release of releases.splice(0)) release();
    // A test that restarted disposed this manager and closed this store: nothing to cancel here.
    if (!managerDisposed(manager)) for (const run of store.listRuns()) manager.cancel(run.id);
    await fixtureWorkSettled(root);
    await until(() => store.listRuns().every(run => !manager.isActive(run.id)));
    await drainFixtureManagers(root);
    manager.dispose(); store.flush(); vi.restoreAllMocks(); vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  }, 30_000);
}
export async function worker(task = 'mock:hold') {
    const id = randomUUID(); const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
    const workspace = await planOwnedWorkspace(root, id, sha);
    return store.createOwnedRun({ title: 'worker', task, workflow: 'quick-task', runner: 'claude', steps: [{ id: 'task', name: 'Task', kind: STEP_KIND.agent }] }, parent.id, randomUUID(), {
      role: 'worker', permissions: [], parentRunId: parent.id, workspace,
    }, 'a'.repeat(64));
  }
export function workspace(run: RunRecord) { if (run.delegation?.role !== 'worker') throw Error('fixture'); return run.delegation.workspace; }
export function destroy(run: RunRecord) {
    if (run.delegation?.role !== 'worker') throw Error('fixture');
    store.commitDelegation([{ id: run.id, delegation: { ...run.delegation, destroy: { requestedAt: new Date().toISOString(), phase: 'requested', remaining: ['process', 'worktree', 'branch'] } } }]);
  }
export function replaceWorkerDestroyManager(value: RunManager): void { manager = value; }
