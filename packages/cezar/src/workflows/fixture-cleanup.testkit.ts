import { rmSync } from 'node:fs';
import type { AgentSession } from '../core/agent-runner.ts';
import type { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';

const fixtures = new Map<string, Array<{ manager: RunManager; store: RunStore; pending: Map<Promise<unknown>, string>; sessions: Set<AgentSession> }>>();

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
      void result.then(() => pending.delete(result), () => pending.delete(result));
      return result;
    };
  }
  const originalSession = engine.trackWorkerSessionResult!.bind(manager);
  engine.trackWorkerSessionResult = (...input: unknown[]) => {
    const [id, session] = input as [string, AgentSession];
    sessions.add(session);
    const closed = originalSession(id, session);
    pending.set(closed, 'session');
    void closed.then(() => { pending.delete(closed); sessions.delete(session); });
    return closed;
  };
  const group = fixtures.get(root) ?? [];
  group.push({ manager, store, pending, sessions });
  fixtures.set(root, group);
  return manager;
}

/** Stop parked sessions, wait for actual work, then dispose/flush. A timeout
 * leaves the directory intact; rm errors are never caught or retried. */
export async function drainFixtureManagers(root: string, timeoutMs = 8_000): Promise<void> {
  const group = fixtures.get(root) ?? [];
  const deadline = Date.now() + timeoutMs;
  const interrupted = new Set<AgentSession>();
  const cancelled = new Map<RunManager, Set<string>>();
  // Queued records and synthetic ActiveRun entries are not process ownership.
  // With no outstanding promise/session, dispose can clear them synchronously.
  while (group.some(({ pending, sessions }) => pending.size > 0 || sessions.size > 0)) {
    for (const { manager, store, sessions } of group) {
      const ids = cancelled.get(manager) ?? new Set<string>();
      cancelled.set(manager, ids);
      // Every id: a manager may still hold a run whose record already settled (#779).
      for (const id of store.listRunIds()) if (manager.isActive(id) && !ids.has(id)) {
        ids.add(id);
        manager.cancel(id);
      }
      for (const session of sessions) {
        if (!interrupted.has(session)) { interrupted.add(session); session.interrupt(); }
      }
    }
    if (Date.now() >= deadline) throw new Error(`Fixture still owns work: ${root}; ${group.flatMap(({ pending }) => [...pending.values()]).join(", ")}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  for (const { manager, store } of group) { manager.dispose(); store.flush(); }
  fixtures.delete(root);
}

export async function removeFixtureRepo(root: string, timeoutMs?: number): Promise<void> {
  await drainFixtureManagers(root, timeoutMs);
  rmSync(root, { recursive: true, force: true });
}
