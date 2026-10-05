import { randomUUID } from 'node:crypto';

import { isCurrentProcess, processStartToken, recordedProcessLive } from '../delegation/process-liveness.ts';

/**
 * Who owns a run claim, and whether that owner can still be writing (#779, plan step 3).
 *
 * A claim in `run_claims` names the RunStore that holds a delegation family: a session id (one per
 * `RunStore.open`), its process id, and that process's start identity (`processStartToken`: the
 * Linux `/proc/<pid>/stat` start time scoped by boot id, or macOS `ps -o lstart`). Only a PROVEN
 * dead owner's claim may be taken over: its pid is gone, the pid now belongs to a process with a
 * different start identity, or — for our own pid, which can only be this process or a dead earlier
 * one — its session is not open here. Anything that cannot be proven dead counts as live, which is
 * what a claim with no start identity on a pid that exists is: there is nothing to compare it with.
 */

export interface ClaimOwner {
  session: string;
  pid: number;
  /** Null only where the platform cannot read a start identity. */
  startToken: string | null;
}

/** The sessions open in this process: the only way to tell two stores in one process apart. */
const openSessions = new Set<string>();
let ownStartToken: string | null | undefined;

/** A fresh owner identity for one store, live until `closeClaimSession`. */
export function openClaimSession(): ClaimOwner {
  ownStartToken ??= processStartToken(process.pid) ?? null;
  const owner = { session: randomUUID(), pid: process.pid, startToken: ownStartToken };
  openSessions.add(owner.session);
  return owner;
}

/** The store behind `session` is gone: any claim it left behind is now provably dead. */
export function closeClaimSession(session: string): void {
  openSessions.delete(session);
}

/** Whether the owner of `claim` may still be writing. False only when it is proven gone. */
export function claimOwnerLive(claim: ClaimOwner): boolean {
  const entry = { pid: claim.pid, ...(claim.startToken === null ? {} : { startToken: claim.startToken }) };
  if (claim.pid === process.pid) return isCurrentProcess(entry) && openSessions.has(claim.session);
  return recordedProcessLive(entry);
}
