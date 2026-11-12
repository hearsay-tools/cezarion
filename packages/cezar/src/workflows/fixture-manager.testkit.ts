import { testHome } from '../home/test-home.testkit.ts';
import { rmSync } from 'node:fs';
import type { AgentSession, RunnerFactory } from '../core/agent-runner.ts';
import type { RunStore } from '../runs/store.ts';
import { runnersUnderTest } from '../core/runners-under-test.testkit.ts';
import { RunManager } from './run.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { acquireInertCiResources } from '../ci-wait/inert-ci-resources.testkit.ts';

const managerWork = new WeakMap<RunManager, TrackedWork>();
const disposedManagers = new WeakSet<RunManager>();

class FixtureManager extends RunManager {
  override dispose(): void {
    disposedManagers.add(this);
    super.dispose();
  }
}

const fixtures = new Map<string, { work: TrackedWork; managers: Array<{ manager: RunManager; store: RunStore }> }>();

/** What a fixture manager takes: every `RunManager` option, with `home`, `createRunner` and
 *  `acquireCiResources` optional. Without `acquireCiResources`, the manager has no CI supervisor. */
export type FixtureManagerOptions = Omit<ConstructorParameters<typeof RunManager>[2], 'home' | 'createRunner' | 'acquireCiResources'> & {
  home?: import('../home/home.ts').Home;
  createRunner?: RunnerFactory;
  acquireCiResources?: ConstructorParameters<typeof RunManager>[2]['acquireCiResources'];
};

/** Share ownership across managers, including simulated restart and recovery. Without a
 *  `createRunner`, the manager builds runners through the test file's `useRunners` choice. This
 *  module imports no adapter, so a per-runner test loads only its own; `fixture-cleanup.testkit.ts`
 *  chooses every adapter (hearsay-tools/cezarion#2939). */
export function createFixtureManager(...args: [store: RunStore, root: string, options?: FixtureManagerOptions]): RunManager {
  const [store, root, options] = args;
  const group = fixtures.get(root) ?? { work: options?.work ?? new TrackedWork(), managers: [] };
  const manager = new FixtureManager(store, root, {
    home: testHome(), createRunner: (backend, runnerOptions) => runnersUnderTest()(backend, runnerOptions), acquireCiResources: acquireInertCiResources,
    ...options, work: group.work,
  });
  managerWork.set(manager, group.work);
  group.managers.push({ manager, store });
  fixtures.set(root, group);
  return manager;
}

/** Whether a test already disposed `manager`, as a restart does to the process it replaces: its
 *  runs are then the recovered manager's, and its store may already be closed (#779). */
export function managerDisposed(manager: RunManager): boolean {
  return disposedManagers.has(manager);
}

/** The work registry owned by fixtures under this root, including recovered managers. */
export function fixtureWork(root: string | RunManager): TrackedWork {
  const work = typeof root === 'string' ? fixtures.get(root)?.work : managerWork.get(root);
  if (!work) throw new Error(typeof root === 'string' ? `No fixture owns work under ${root}` : 'No fixture owns work for unregistered manager');
  return work;
}

/** Wait until every engine call the fixtures under `root` observe has settled, cancelling and
 * disposing nothing: the fire-and-forget turn-end bookkeeping and the namer have then landed.
 * A parked session's work never settles, so call this once the runs are terminal; the test's own
 * timeout is the hang guard (hearsay-tools/cezarion#1316). */
export async function fixtureWorkSettled(root: string): Promise<void> {
  const registry = fixtures.get(root)?.work;
  for (;;) {
    const work = [...(registry?.pending.keys() ?? [])];
    if (!work.length) return;
    await Promise.allSettled(work);
  }
}

/** True when an owned operation settles within the bound. */
function nextSettlement(work: TrackedWork, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const finish = (progress: boolean) => { clearTimeout(timer); off(); resolve(progress); };
    const off = work.onSettle(() => finish(true));
    const timer = setTimeout(finish, ms, false);
  });
}

/** Stop parked sessions, wait for actual work, then dispose/flush. The drain waits on the owned
 * operations themselves, and `timeoutMs` restarts each time one settles, so it bounds one step,
 * not the whole teardown. A timeout leaves the directory intact; rm errors are never caught or
 * retried. A manager a test already disposed (a restart) has its sessions interrupted but cancels
 * nothing: it is the dead process. */
export async function drainFixtureManagers(root: string, timeoutMs = 8_000): Promise<void> {
  const fixture = fixtures.get(root);
  if (!fixture) return;
  const { work, managers: group } = fixture;
  let deadline = Date.now() + timeoutMs;
  const interrupted = new Set<AgentSession>();
  const cancelled = new Map<RunManager, Set<string>>();
  // Queued records and synthetic ActiveRun entries are not process ownership.
  // With no outstanding promise/session, dispose can clear them synchronously.
  while (work.pending.size > 0 || work.liveSessions.size > 0) {
    for (const { manager, store } of group) {
      const ids = cancelled.get(manager) ?? new Set<string>();
      cancelled.set(manager, ids);
      // Every id: a manager may still hold a run whose record already settled (#779).
      for (const id of managerDisposed(manager) ? [] : store.listRunIds()) if (manager.isActive(id) && !ids.has(id)) {
        ids.add(id);
        manager.cancel(id);
      }
      for (const session of work.liveSessions) {
        if (!interrupted.has(session)) { interrupted.add(session); session.interrupt(); }
      }
    }
    if (Date.now() >= deadline) throw new Error(`Fixture still owns work: ${root}; ${[...work.pending.values()].join(", ")}`);
    // bound: one owned operation, since the window restarts on each settlement. With 0.3 s added
    // to every git call, model-identity-wiring's teardown settled 17 operations in about 13.5 s and
    // the longest took 4.5 s; as a whole-drain deadline, 8 s failed there and on a loaded host
    // (hearsay-tools/cezarion#1323). It stays under the 30 s hookTimeout, so a stuck operation
    // fails with the names of the work still owned.
    if (await nextSettlement(work, deadline - Date.now())) deadline = Date.now() + timeoutMs;
  }
  for (const { manager, store } of group) { manager.dispose(); store.flush(); }
  fixtures.delete(root);
}

export async function removeFixtureRepo(root: string, timeoutMs?: number): Promise<void> {
  await drainFixtureManagers(root, timeoutMs);
  rmSync(root, { recursive: true, force: true });
}

/** Unused collaborators fail at the first accidental access, including after constructor changes. */
export function unused<T extends object>(name: string, used: Partial<T> = {}): T {
  return new Proxy(used as T, {
    get(target, key, receiver) {
      if (Reflect.has(target, key)) return Reflect.get(target, key, receiver);
      throw new Error(`unused collaborator ${name}.${String(key)}`);
    },
  });
}
