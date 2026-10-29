import type { RunManager } from './run.ts';
import { runInternals } from './run-internals.testkit.ts';
import type { TimerWaitEntry, Wait } from '@open-mercato/cezar-contract';
import { isMonitoringTimer } from './waits.ts';

// hearsay-tools/cezarion#1233: a monitoring park's re-check is an open timer on the wait list.
// `monitoringWakeAt` became its deadline and `ActiveRun.monitoringWakeTimer` its armed timer.

export function monitoringTimerWait(run?: { waits?: Wait[] | undefined }): TimerWaitEntry | undefined {
  return run?.waits?.find((wait): wait is TimerWaitEntry => wait.kind === 'timer' && wait.phase === 'open' && isMonitoringTimer(wait));
}

/** A CI or timer wait: the kinds with a deadline. */
export type TimedWait = Exclude<Wait, { kind: 'human' }>;

/** Narrows a registration the test made with a CI or timer request. */
export function timed(wait: Wait): TimedWait {
  if (wait.kind === 'human') throw new Error(`expected a CI or timer wait, got human wait ${wait.id}`);
  return wait;
}

export function monitoringWakeOf(run?: { waits?: Wait[] | undefined }): string | undefined {
  return monitoringTimerWait(run)?.deadline;
}

/** The timer RunManager armed for the run's open monitoring timer wait. */
export function monitoringTimerOf(manager: RunManager, runId: string): NodeJS.Timeout & { _onTimeout(): void } | undefined {
  const id = monitoringTimerWait(runInternals(manager).context.store.getRun(runId))?.id;
  return id ? runInternals(manager).waitWatches.waitTimers.get(id)?.timer as NodeJS.Timeout & { _onTimeout(): void } | undefined : undefined;
}
