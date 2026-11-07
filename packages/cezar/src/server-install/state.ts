import type { Home } from '../home/home.ts';
import { existsSync, readdirSync } from 'node:fs';
import { HomeOutsideWriteError, HomeStore, readHomeFile } from '../home/store.ts';
import { assertHomeWritable } from '../home/install-marker.ts';
import { basename } from 'node:path';
import {
  DEFAULT_SERVER_INSTANCE,
  serverInstancesDir,
  serverLockPath,
  serverStatePath,
} from '../paths.ts';
import { freshServerState, serverStateSchema, type ServerState, type StepOutcome } from './types.ts';

/**
 * Installation ledger and single-writer lock. Corrupt reads degrade to fresh state; atomic 0600
 * writes preserve uninstall’s artifact evidence.
 */

/** Load a host-level instance record, degrading to a fresh record on any error. */
export function loadServerState(instance: string = DEFAULT_SERVER_INSTANCE, home: Home): ServerState {
  const path = serverStatePath(instance, home);
  let raw: string;
  try {
    raw = readHomeFile(path);
  } catch {
    return freshServerState();
  }
  try {
    const parsed = serverStateSchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // malformed JSON — fall through to fresh
  }
  return freshServerState();
}

/**
 * Every instance recorded on this host, newest schema first: the `default`
 * record (`server.json`) plus each named record under `server-instances/`.
 * Used to auto-pick a free loopback port for a new instance and to let
 * uninstall/deploy resolve which instance to act on. Never throws — an
 * unreadable dir or a corrupt file is simply skipped.
 */
export function listServerInstances(home: Home): Array<{ instance: string; state: ServerState }> {
  const out: Array<{ instance: string; state: ServerState }> = [];
  if (existsSync(serverStatePath(DEFAULT_SERVER_INSTANCE, home))) {
    out.push({ instance: DEFAULT_SERVER_INSTANCE, state: loadServerState(DEFAULT_SERVER_INSTANCE, home) });
  }
  let entries: string[] = [];
  try {
    entries = readdirSync(serverInstancesDir(home));
  } catch {
    entries = [];
  }
  for (const file of entries) {
    if (!file.endsWith('.json')) continue;
    const instance = basename(file, '.json');
    out.push({ instance, state: loadServerState(instance, home) });
  }
  return out;
}

/**
 * The next free loopback port for a NEW instance, scanning from `startAt`
 * (4321, the default cockpit port) upward past every port already recorded by
 * another instance. Deterministic (recorded-state only, no network probe) so it
 * stays unit-testable; the operator can always override it with `--port`.
 */
export function nextFreeInstancePort(startAt = 4321, home: Home): number {
  const used = new Set(listServerInstances(home).map((i) => i.state.primaryPort));
  let port = startAt;
  while (used.has(port)) port++;
  return port;
}

/** Atomically persist state as `0600`, creating its dir (`0700`) if needed. */
export function saveServerState(state: ServerState, instance: string = DEFAULT_SERVER_INSTANCE, home: Home): void {
  const path = serverStatePath(instance, home);
  new HomeStore(home).writeJson(path, state);
}

/**
 * Delete a named instance's state file (used after a complete uninstall so it
 * stops reserving its port and drops out of `listServerInstances`). The
 * `default` record is left in place — that is the legacy single-host file, and
 * its absence vs. an empty-but-present record has historically meant the same
 * thing, so we don't change that behavior. Best-effort; never throws.
 */
export function deleteServerState(instance: string, home: Home): void {
  if (instance === DEFAULT_SERVER_INSTANCE) return;
  assertHomeWritable(home.root);
  try {
    new HomeStore(home).replace(serverStatePath(instance, home), null);
  } catch (error) {
    if (error instanceof HomeOutsideWriteError) console.warn(`[cez] ${error.message}; instance state was kept`);
    // non-fatal — an empty record left behind is harmless
  }
}

/** A step is resolved (needs no run on resume) when it is done or skipped. */
export function isResolved(outcome: StepOutcome | undefined): boolean {
  return outcome?.status === 'done' || outcome?.status === 'skipped';
}

/**
 * First step id in `orderedIds` that is not yet resolved — the resume point.
 * `undefined` means every step is resolved (install complete).
 */
export function firstIncompleteStep(orderedIds: readonly string[], state: ServerState): string | undefined {
  return orderedIds.find((id) => !isResolved(state.steps[id]));
}

export class LockHeldError extends Error {}

/**
 * Acquire the exclusive install lock. Throws `LockHeldError` if a *live*
 * process already holds it; a stale lock (dead pid) is reclaimed. Returns a
 * release function.
 */
export function acquireLock(instance: string = DEFAULT_SERVER_INSTANCE, home: Home): () => void {
  const path = serverLockPath(instance, home);
  const store = new HomeStore(home);
  return store.transaction(() => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        store.createExclusive(path, Buffer.from(`${process.pid}\n`));
        return lockRelease(store, path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        const holder = readLockPid(path);
        if (holder !== null && holder !== process.pid && isProcessAlive(holder)) {
          throw new LockHeldError(`another server-install/uninstall is already running (pid ${holder}). If that is wrong, remove ${path} and retry.`);
        }
        // Same historical reclaim retry: stale, unreadable, or our own lock.
        try { store.replace(path, null); } catch { /* The exclusive retry decides. */ }
      }
    }
    throw new LockHeldError(`could not acquire ${path} — another server-install/uninstall grabbed it first; retry in a moment.`);
  }, [path]);
}

function lockRelease(store: HomeStore, path: string): () => void {
  let released = false;
  return () => {
    if (released) return;
    assertHomeWritable(store.root);
    released = true;
    try {
      store.transaction(() => { if (readLockPid(path) === process.pid) store.replace(path, null); }, [path]);
    } catch (error) {
      if (error instanceof HomeOutsideWriteError) console.warn(`[cez] ${error.message}; install lock was kept`);
      // Release has always been best-effort.
    }
  };
}

function readLockPid(path: string): number | null {
  try {
    const pid = Number.parseInt(readHomeFile(path).trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // ESRCH = no such process; EPERM = alive but not ours (still alive)
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}
