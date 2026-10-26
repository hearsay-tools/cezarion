import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { RunContext } from './host.ts';

/**
 * A run's `preview.agent-browser` state across a crash (hearsay-tools/cezarion#784): the marker
 * `<dataDir>/preview/<runId>/agent-connected` exists from just before `connected` is appended until
 * just after `disconnected` is. A cezar killed with an agent connected leaves the marker, and the
 * next boot appends the missing `disconnected`, so the cockpit never lists a page no agent drives.
 */

const MARKER = 'agent-connected';

function markerPath(dataDir: string, runId: string): string {
  return join(dataDir, 'preview', runId, MARKER);
}

/** Before `connected` is appended: a crash after this line still leaves a marker to reconcile. */
export function markAgentConnected(dataDir: string, runId: string): void {
  try {
    mkdirSync(join(dataDir, 'preview', runId), { recursive: true });
    writeFileSync(markerPath(dataDir, runId), '');
  } catch { /* a read-only data dir: the state then lives only as long as this process */ }
}

/** After `disconnected` is appended. */
export function clearAgentMarker(dataDir: string, runId: string): void {
  try {
    rmSync(markerPath(dataDir, runId), { force: true });
  } catch { /* the next boot finds the marker and appends `disconnected` again */ }
}

/**
 * Appends `preview.agent-browser` for a run that exists, with its marker around it. Best effort: it
 * runs inside a socket's close, so a failed write never stops that cleanup, and a `disconnected` it
 * could not write keeps the marker for the next boot. Answers whether the event is written.
 */
export function recordAgentBrowser(ctx: Pick<RunContext, 'runId' | 'store' | 'dataDir'>, state: 'connected' | 'disconnected'): boolean {
  const { runId, store, dataDir } = ctx;
  try {
    const run = store.getRun(runId);
    if (run && state === 'connected') markAgentConnected(dataDir, runId);
    if (run) store.appendEvent(runId, { type: 'preview.agent-browser', state });
  } catch {
    return false;
  }
  if (state === 'disconnected') clearAgentMarker(dataDir, runId);
  return true;
}

/**
 * Boot: every marker this process does not own is a crash's. Its run gets the `disconnected` it
 * missed, then the marker goes; a crash between the two only appends `disconnected` again.
 * Synchronous, so it finishes before the agent's CDP route can accept a connection.
 */
export function reconcileAgentMarkers(dataDir: string, store: RunContext['store'], live: (runId: string) => boolean): number {
  let runIds: string[];
  try {
    runIds = readdirSync(join(dataDir, 'preview'));
  } catch {
    return 0;
  }
  let reconciled = 0;
  for (const runId of runIds) {
    if (!existsSync(markerPath(dataDir, runId)) || live(runId)) continue;
    if (recordAgentBrowser({ runId, store, dataDir }, 'disconnected')) reconciled += 1;
  }
  return reconciled;
}
