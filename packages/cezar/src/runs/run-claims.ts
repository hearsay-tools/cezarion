import { randomUUID } from 'node:crypto';

import { isCurrentProcess, processStartToken, recordedProcessLive } from '../delegation/process-liveness.ts';
import type { RunDatabase } from './run-database.ts';

/**
 * Claim owners carry store session, PID and process start identity. Only a proven dead owner can
 * be replaced; unknown identity on a live PID remains live.
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

/** Every run whose family a store other than `owner` claims — alive, or dead with a live run left
 *  to recover (cleanup keeps their scratch: it is theirs, or recovery's once someone adopts them).
 *  A dead owner's claim on a family with nothing live is no claim (see `RunStore.runOwnership`). */
export function foreignClaimedRunIds(db: RunDatabase | null, owner: ClaimOwner | undefined): string[] {
  if (!db || !owner) return [];
  const kept = new Set(db.listClaims().filter((claim) => claim.session !== owner.session &&
    (claimOwnerLive(claim) || db.familyHasLive(claim.family))).map((claim) => claim.family));
  return kept.size === 0 ? [] : db.listForeignClaimedIds(owner.session).filter((row) => kept.has(row.family)).map((row) => row.id);
}

/** Families a live store other than `owner` claims: a headless `cez run`, another binary, or a
 *  second store of this process. A project migration fence waits until none remains. */
export function liveForeignClaimCount(db: RunDatabase | null, owner: ClaimOwner | undefined): number {
  if (!db || !owner) return 0;
  return db.listClaims().filter((claim) => claim.session !== owner.session && claimOwnerLive(claim)).length;
}
