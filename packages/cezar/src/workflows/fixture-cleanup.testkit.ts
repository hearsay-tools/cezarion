import { rmSync } from 'node:fs';
import type { AgentSession } from '../core/agent-runner.ts';
import type { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const fixtures = new Map<string, Array<{ manager: RunManager; store: RunStore; pending: Map<Promise<unknown>, string>; sessions: Set<AgentSession> }>>();
/** Per root: the drains waiting for the next owned operation to settle. */
const settled = new Map<string, Set<() => void>>();

/** Observe real work, including root runs (awaitRunTermination only tracks workers).
 * Keep ownership across dispose/recovery: dispose deliberately does not end sessions.
 * This belongs in fixtures, not in the production manager's lifecycle policy. */
export function createFixtureManager(...args: ConstructorParameters<typeof RunManager>): RunManager {
  const manager = new RunManager(...args);
  const [store, root] = args;
  const pending = new Map<Promise<unknown>, string>();
  const sessions = new Set<AgentSession>();
  const engine = manager as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;
  // Inactive Finish and watchdog adoption can write without any active session.
  for (const name of ['pump', 'execute', 'runContinuation', 'recordTurnEnd', 'saveWorktree', 'autoNameRun', 'enforceRetention', 'finishWorkerExecution', 'settleSuccess', 'settleRequestedRootFinish', 'rescueStalledQueue']) {
    const original = engine[name]!.bind(manager);
    engine[name] = (...input) => {
      const result = original(...input);
      pending.set(result, name);
      // The engine owns failure reporting; observe settlement without creating
      // an unhandled rejection or replacing the promise returned to its caller.
      const release = () => { pending.delete(result); wakeDrains(root); };
      void result.then(release, release);
      return result;
    };
  }
  const originalSession = engine.trackWorkerSessionResult!.bind(manager);
  engine.trackWorkerSessionResult = (...input: unknown[]) => {
    const [id, session] = input as [string, AgentSession];
    sessions.add(session);
    const closed = originalSession(id, session);
    pending.set(closed, 'session');
    void closed.then(() => { pending.delete(closed); sessions.delete(session); wakeDrains(root); });
    return closed;
  };
  const group = fixtures.get(root) ?? [];
  group.push({ manager, store, pending, sessions });
  fixtures.set(root, group);
  return manager;
}

/** Whether a test already disposed `manager`, as a restart does to the process it replaces: its
 *  runs are then the recovered manager's, and its store may already be closed (#779). */
export function managerDisposed(manager: RunManager): boolean {
  return (manager as unknown as { disposed: boolean }).disposed;
}

/** Wait until every engine call the fixtures under `root` observe has settled, cancelling and
 * disposing nothing: the fire-and-forget turn-end bookkeeping and the namer have then landed.
 * A parked session's work never settles, so call this once the runs are terminal; the test's own
 * timeout is the hang guard (hearsay-tools/cezarion#1316). */
export async function fixtureWorkSettled(root: string): Promise<void> {
  const group = fixtures.get(root) ?? [];
  for (;;) {
    const work = group.flatMap(({ pending }) => [...pending.keys()]);
    if (!work.length) return;
    await Promise.allSettled(work);
  }
}

function wakeDrains(root: string): void {
  for (const wake of settled.get(root) ?? []) wake();
}

/** True when an operation `root`'s fixtures own settles within `ms`, false when the window passes first. */
function nextSettlement(root: string, ms: number): Promise<boolean> {
  return new Promise(resolve => {
    const waiters = settled.get(root) ?? new Set<() => void>();
    settled.set(root, waiters);
    const finish = (progress: boolean) => { clearTimeout(timer); waiters.delete(wake); resolve(progress); };
    const wake = () => finish(true);
    const timer = setTimeout(finish, ms, false);
    waiters.add(wake);
  });
}

/** Stop parked sessions, wait for actual work, then dispose/flush. The drain waits on the owned
 * operations themselves, and `timeoutMs` restarts each time one settles, so it bounds one step,
 * not the whole teardown. A timeout leaves the directory intact; rm errors are never caught or
 * retried. A manager a test already disposed (a restart) has its sessions interrupted but cancels
 * nothing: it is the dead process. */
export async function drainFixtureManagers(root: string, timeoutMs = 8_000): Promise<void> {
  const group = fixtures.get(root) ?? [];
  let deadline = Date.now() + timeoutMs;
  const interrupted = new Set<AgentSession>();
  const cancelled = new Map<RunManager, Set<string>>();
  // Queued records and synthetic ActiveRun entries are not process ownership.
  // With no outstanding promise/session, dispose can clear them synchronously.
  while (group.some(({ pending, sessions }) => pending.size > 0 || sessions.size > 0)) {
    for (const { manager, store, sessions } of group) {
      const ids = cancelled.get(manager) ?? new Set<string>();
      cancelled.set(manager, ids);
      // Every id: a manager may still hold a run whose record already settled (#779).
      for (const id of managerDisposed(manager) ? [] : store.listRunIds()) if (manager.isActive(id) && !ids.has(id)) {
        ids.add(id);
        manager.cancel(id);
      }
      for (const session of sessions) {
        if (!interrupted.has(session)) { interrupted.add(session); session.interrupt(); }
      }
    }
    if (Date.now() >= deadline) throw new Error(`Fixture still owns work: ${root}; ${group.flatMap(({ pending }) => [...pending.values()]).join(", ")}`);
    // bound: one owned operation, since the window restarts on each settlement. With 0.3 s added
    // to every git call, model-identity-wiring's teardown settled 17 operations in about 13.5 s and
    // the longest took 4.5 s; as a whole-drain deadline, 8 s failed there and on a loaded host
    // (hearsay-tools/cezarion#1323). It stays under the 30 s hookTimeout, so a stuck operation
    // fails with the names of the work still owned.
    if (await nextSettlement(root, deadline - Date.now())) deadline = Date.now() + timeoutMs;
  }
  for (const { manager, store } of group) { manager.dispose(); store.flush(); }
  fixtures.delete(root);
  settled.delete(root);
}

export async function removeFixtureRepo(root: string, timeoutMs?: number): Promise<void> {
  await drainFixtureManagers(root, timeoutMs);
  rmSync(root, { recursive: true, force: true });
}
