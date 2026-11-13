import type { Home } from '../home/home.ts';
import { testHome } from '../home/test-home.testkit.ts';
import {
  RUN_STATUS,
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_SOURCE,
  WAIT_VIA,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { openTestRunStore } from '../runs/run-store-open.testkit.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { defaultWorkspaceConfig } from '../workspace/config.ts';
import { createFixtureManager, drainFixtureManagers, managerDisposed } from '../workflows/fixture-claude.testkit.ts';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, expect, vi } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { CredentialRegistry, type Caller } from './credentials.ts';
import { DelegationService, type DelegationProject, type WorkerCleanupFactory } from './service.ts';

export async function waitForOwnedWork(manager: RunManager, store: RunStore): Promise<void> {
  // A manager a restart disposed owns nothing any more: the recovered one does (#779).
  if (managerDisposed(manager)) return;
  // Root runs have no worker execution proof; fixture tracking drains those.
  // Every worker id: a manager may still hold a worker whose record already settled (#779).
  for (const id of store.listWorkerIds().filter(id => manager.isActive(id))) {
    manager.cancel(id);
    if (!await manager.awaitRunTermination(id, 8_000)) throw new Error(`Worker did not terminate: ${id}`);
  }
}

export async function removeAfterOwnedWork(root: string, ownedWork: Promise<void>): Promise<void> {
  await ownedWork;
  rmSync(root, { recursive: true, force: true });
}

/**
 * Every automatic (scheduled) full destroy attempt the service starts from here on, as the promise
 * of its settlement (hearsay-tools/cezarion#1109). Ticks that skip an unchanged destroy start none.
 * A test that waits for a background retry to finish awaits the attempt itself: what one full
 * attempt costs is real Git, `/proc` scans and the mutation-lock keeper, and a wall-clock window
 * sized for an idle host is shorter than that attempt at load ~90.
 */
/** An open worker wait in the list, as `cez worker wait` registers one from an executing parent
 *  (hearsay-tools/cezarion#1235, #1301): no session is needed to seed it. Returns its id. */
export function seedWorkerWait(store: RunStore, parentId: string, workerIds: string[]): string {
  const id = randomUUID(); const now = Date.now();
  store.commitWait(parentId, { kind: WAIT_KIND.worker, id, source: WAIT_SOURCE.agent, via: WAIT_VIA['cez-worker-wait'], registeredAt: new Date(now).toISOString(),
    deadline: new Date(now + 600_000).toISOString(), timeoutSeconds: 600, phase: WAIT_PHASE.open, turnId: 'turn-1', mode: 'all',
    workerIds, revisions: workerIds.map(workerId => ({ workerId, revision: 0 })), outcomes: [] });
  return id;
}

type CleanupInternals = {
  destroyRetryTimers: Map<string, Map<string, NodeJS.Timeout>>;
  destroyAttempt: (project: DelegationProject, workerId: string, check: () => RunRecord, mode: 'manual' | 'scheduled') => Promise<unknown>;
};

/** The single typed test read of the service's project cleanup instances. */
export function workerCleanupInternals(service: DelegationService): Iterable<CleanupInternals> {
  return (Reflect.get(service, 'cleanups') as Map<string, CleanupInternals>).values();
}

export function scheduledDestroyAttempts(service: DelegationService): Array<Promise<unknown>> {
  const started: Array<Promise<unknown>> = [];
  for (const target of workerCleanupInternals(service)) {
    const original = target.destroyAttempt.bind(target);
    target.destroyAttempt = (...args) => {
      const attempt = original(...args);
      // Settled either way: a thrown attempt is still the one the test waited for.
      if (args[3] === 'scheduled') started.push(attempt.then(result => result, (error: unknown) => error));
      return attempt;
    };
  }
  return started;
}

let repositoryTemplate: { root: string; sha: string } | undefined;

/** Copy only the empty base repository; stores and worktrees always belong to each fixture. */
function copyServiceRepository(destination: string): string {
  if (!repositoryTemplate) {
    const root = mkdtempSync(join(tmpdir(), 'cez-service-template-'));
    try {
      execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
      // Auto-gc detaches after commit and writes into `.git` while recursive removal walks it.
      execFileSync('git', ['config', 'gc.auto', '0'], { cwd: root });
      execFileSync('git', ['config', 'maintenance.auto', 'false'], { cwd: root });
      execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '--allow-empty', '-qm', 'base'], { cwd: root });
      const sha = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
      repositoryTemplate = { root, sha };
    } catch (error) {
      rmSync(root, { recursive: true, force: true });
      throw error;
    }
  }
  cpSync(repositoryTemplate.root, destination, { recursive: true });
  return repositoryTemplate.sha;
}

afterAll(() => {
  if (repositoryTemplate) rmSync(repositoryTemplate.root, { recursive: true, force: true });
});

export function fixture(cleanup?: WorkerCleanupFactory, home: Home = testHome()): { root: string; sha: string; store: RunStore; manager: RunManager; parent: RunRecord; credentials: CredentialRegistry; caller: Caller; token: string; service: DelegationService; holdAdmission(): Promise<void>; releaseAdmission(): Promise<void>; close(): Promise<void> } {
  const root = mkdtempSync(join(tmpdir(), 'cez-delegation-service-'));
  const sha = copyServiceRepository(root);
  const store = openTestRunStore(join(root, '.ai/cezar'), { keepLive: true });
  // Scheduler admission is held so acceptance is durable before execution starts.
  let admissionHeld = true;
  const semaphore = new WorkspaceSemaphore({ home, initial: { maxParallel: 0 }, load: async () => ({ ...defaultWorkspaceConfig().resources, ...(admissionHeld ? { maxParallel: 0 } : {}) }) });
  const manager = createFixtureManager(store, root, { home, semaphore });
  const admissionReads = vi.spyOn(semaphore, 'maxParallel');
  const parent = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', runner: 'claude', model: 'opus', effort: 'high', steps: [] });
  setRunStatus(store, parent.id, RUN_STATUS.running, { worktreePath: root, delegation: { role: 'root', permissions: ['spawn', 'inspect', 'steer', 'stop', 'destroy', 'diff', 'wait'], receipts: [] } });
  const credentials = new CredentialRegistry();
  const token = credentials.issue('project', parent.id, randomUUID());
  const caller = credentials.authenticate(token)!;
  vi.spyOn(manager, 'delegationExecutionSettings').mockReturnValue({ cwd: root, runner: 'claude', model: 'opus', effort: 'high', agentProfile: 'default', accountBinding: { provider: 'claude', profileId: 'default', homePath: root, claudeLayout: { kind: 'relocated' } } });
  const service = new DelegationService(cleanup);
  const spawn = service.spawn.bind(service);
  vi.spyOn(service, 'spawn').mockImplementation(async (...args) => {
    const existingWorkers = new Set(store.listWorkerIds());
    const readsBefore = admissionReads.mock.calls.length;
    const result = await spawn(...args);
    if (admissionHeld && store.getRun(result.workerId)?.status === 'queued') {
      // bound: the requested pump awaits repository discovery before reading capacity.
      await vi.waitFor(() => expect(admissionReads.mock.calls.length).toBeGreaterThan(existingWorkers.has(result.workerId) ? 0 : readsBefore), { timeout: 10_000 });
      expect(semaphore.busy()).toBe(0);
    }
    return result;
  });
  const unregister = service.registerProject({ home, id: 'project', root, store, manager });
  return { root, sha, store, manager, parent, credentials, caller, token, service,
    async holdAdmission() { admissionHeld = true; await semaphore.refresh(); },
    async releaseAdmission() { admissionHeld = false; await semaphore.refresh(); await semaphore.release(); },
    async close() {
      unregister();
      credentials.close();
      await removeAfterOwnedWork(root, waitForOwnedWork(manager, store).then(() => drainFixtureManagers(root)).then(() => store.close()));
    } };
}
