import { WAIT_LIMIT } from '@open-mercato/cezar-contract/waits';
import type { RunRecord } from './store.ts';

export class WaitCapacityError extends Error {
  constructor() {
    super(`open wait limit reached (${WAIT_LIMIT})`);
    this.name = 'WaitCapacityError';
  }
}

/** Replacing a known entry consumes no additional capacity. */
export function assertWaitCapacity(run: Pick<RunRecord, 'waits'>, waitId?: string): void {
  const waits = run.waits ?? [];
  if (waitId !== undefined && waits.some(wait => wait.id === waitId)) return;
  if (waits.filter(wait => wait.phase === 'open').length >= WAIT_LIMIT) throw new WaitCapacityError();
}
