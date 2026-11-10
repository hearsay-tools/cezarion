import type { Wait } from '@open-mercato/cezar-contract/waits';
import { WAIT_PHASES } from '../workflows/run-states.ts';
import { reportStoreViolation } from './run-exits.ts';
import type { RunRecord } from './store.ts';

/** Check the entry a store write puts in place; an undeclared write still lands. */
export function checkWaitWrite(run: Pick<RunRecord, 'waits' | 'lastWaits'>, entry: Wait): void {
  const prior = run.waits?.find(wait => wait.id === entry.id);
  const from = prior?.phase ?? (run.lastWaits?.some(wait => wait.id === entry.id) ? 'settled' : 'new');
  if (prior ? WAIT_PHASES[prior.phase].some(row => row.to === entry.phase) : from === 'new' && entry.phase === 'open') return;
  reportStoreViolation(`undeclared wait transition: ${entry.kind} wait ${entry.id} from ${from} to ${entry.phase} (declare it in workflows/run-states.ts WAIT_PHASES)`);
}
