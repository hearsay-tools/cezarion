import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { processStartToken, recordedProcessLive } from '../core/process-stat.ts';
import { privateDirectory } from './private-files.ts';
import { ownProcessStartToken } from './process-identity.ts';
import { assertHomeMetadata, assertHomePath } from './boundary.ts';

interface Claim { pid: number; startToken?: string | undefined; ticket: number }
const held = new Set<string>();
const pause = new Int32Array(new SharedArrayBuffer(4));

/** Claims need atomic visibility, not persistence. A crash makes the recorded owner stale. */
function publishClaim(path: string, claim: Claim): void {
  const stage = `${path}.tmp`;
  try {
    writeFileSync(stage, JSON.stringify(claim), { flag: 'wx', mode: 0o600 });
    renameSync(stage, path);
  } finally { rmSync(stage, { force: true }); }
}

/** Bound recovery after PID reuse when either side cannot supply a start token. */
function unconfirmedClaimExpired(mtimeMs: number, claim: Claim): boolean {
  if (Date.now() - mtimeMs <= 30_000) return false;
  return claim.startToken === undefined || processStartToken(claim.pid) === undefined;
}

function readClaim(path: string): Claim | undefined {
  let value: Claim;
  let mtimeMs: number;
  try {
    value = JSON.parse(readFileSync(path, 'utf8')) as Claim;
    mtimeMs = statSync(path).mtimeMs;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!Number.isSafeInteger(value.pid) || value.pid <= 0 || !Number.isSafeInteger(value.ticket) || value.ticket < 0) {
    throw new Error(`Invalid HomeStore lock claim: ${path}`);
  }
  if (recordedProcessLive(value) && !unconfirmedClaimExpired(mtimeMs, value)) return value;
  // A unique claim name cannot be reused by a later owner. Recovery never unlinks its lock.
  rmSync(path, { force: true });
  return;
}

/**
 * Short per-root lock, using atomic Lamport bakery claims in write.lock/. Unlike a shared
 * stale pid file, unique claims cannot be stolen by two simultaneous stale-lock reclaimers.
 * The callback is synchronous: no task in this process can wait on a lock across an await.
 */
export function withHomeLock<T>(root: string, operation: () => T): T {
  const canonical = assertHomePath(root, root);
  if (held.has(canonical)) return operation();
  assertHomeMetadata(root);
  privateDirectory(root);
  const directory = join(canonical, '.locks', 'write.lock');
  privateDirectory(directory);
  const name = `${process.pid}-${randomUUID()}.json`;
  const path = join(directory, name);
  const claim = { pid: process.pid, startToken: ownProcessStartToken(), ticket: 0 };
  const peers = () => readdirSync(directory).filter(entry => entry.endsWith('.json') && entry !== name);
  try {
    publishClaim(path, claim);
    let ticket = 1;
    for (const entry of peers()) ticket = Math.max(ticket, (readClaim(join(directory, entry))?.ticket ?? 0) + 1);
    claim.ticket = ticket;
    publishClaim(path, claim);
    const deadline = Date.now() + 10_000;
    for (;;) {
      const blocked = peers().some(entry => {
        const peer = readClaim(join(directory, entry));
        return peer && (peer.ticket === 0 || peer.ticket < ticket || (peer.ticket === ticket && entry < name));
      });
      if (!blocked) break;
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for HomeStore write.lock in ${root}`);
      Atomics.wait(pause, 0, 0, 10);
    }
    held.add(canonical);
    try { return operation(); } finally { held.delete(canonical); }
  } finally { rmSync(path, { force: true }); }
}
