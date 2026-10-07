/**
 * One retry schedule for the cleanup loops that have no other wake source (hearsay-tools/cezarion#879):
 * worker destroy, terminal scratch and orphaned-generation reprobes. Each stays at its fast cadence
 * for `fastCount` attempts, so a holder that exits soon is noticed soon, then doubles up to `capMs`
 * and stays there. None ever stops: cezar has no exit callback for a process it did not spawn.
 */
export type Backoff = { fastMs: number; fastCount: number; capMs: number };

export const DESTROY_BACKOFF: Backoff = { fastMs: 60_000, fastCount: 5, capMs: 3_600_000 };
export const SCRATCH_BACKOFF: Backoff = { fastMs: 60_000, fastCount: 5, capMs: 3_600_000 };
/** The orphan reprobe kept 15 s for its first 15 minutes before #879; that window is unchanged. */
export const ORPHAN_BACKOFF: Backoff = { fastMs: 15_000, fastCount: 60, capMs: 3_600_000 };
/** For the batched reprobes: ids that probe together keep probing together, so they share a scan. */
export const noJitter = () => 0;
/** Scheduled destroy attempts after which the cockpit says the cleanup needs attention: the first capped delay. */
export const DESTROY_ATTENTION_ATTEMPTS = 10;

/** Delay before the next attempt, after `attempt` consecutive failed attempts. Past the fast window
 * the delay is stretched by up to 10 %, never shortened, so stuck items spread out and a capped
 * delay is never under `capMs`. */
export function retryDelayMs(attempt: number, backoff: Backoff, random: () => number = Math.random): number {
  const n = Math.max(0, Math.floor(attempt));
  if (n < backoff.fastCount) return backoff.fastMs;
  return Math.min(backoff.capMs, backoff.fastMs * 2 ** (n - backoff.fastCount + 1)) * (1 + 0.1 * random());
}
