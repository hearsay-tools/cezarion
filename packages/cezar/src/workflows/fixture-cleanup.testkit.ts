import { rmSync } from 'node:fs';
import type { AgentSession } from '../core/agent-runner.ts';
import type { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { TrackedWork } from './run/tracked-work.ts';
import { runInternals } from './run-internals.testkit.ts';

const fixtures = new Map<string, { work: TrackedWork; managers: Array<{ manager: RunManager; store: RunStore }> }>();

/** Share ownership across managers, including simulated restart and recovery. */
export function createFixtureManager(...args: ConstructorParameters<typeof RunManager>): RunManager {
  const [store, root, options] = args;
  const group = fixtures.get(root) ?? { work: options?.work ?? new TrackedWork(), managers: [] };
  const manager = new RunManager(store, root, { ...options, work: group.work });
  group.managers.push({ manager, store });
  fixtures.set(root, group);
  return manager;
}

/** Whether a test already disposed `manager`, as a restart does to the process it replaces: its
 *  runs are then the recovered manager's, and its store may already be closed (#779). */
export function managerDisposed(manager: RunManager): boolean {
  return runInternals(manager).disposed;
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
