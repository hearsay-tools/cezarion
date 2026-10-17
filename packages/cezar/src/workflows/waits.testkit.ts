import type { Wait } from '@open-mercato/cezar-contract';
import { isMonitoringTimer } from './waits.ts';

// hearsay-tools/cezarion#1233: a monitoring park's re-check is an open timer on the wait list.
// `monitoringWakeAt` became its deadline and `ActiveRun.monitoringWakeTimer` its armed timer.

export function monitoringTimerWait(run?: { waits?: Wait[] }): Wait | undefined {
  return run?.waits?.find(wait => wait.phase === 'open' && isMonitoringTimer(wait));
}

export function monitoringWakeOf(run?: { waits?: Wait[] }): string | undefined {
  return monitoringTimerWait(run)?.deadline;
}

/** The timer RunManager armed for the run's open monitoring timer wait. */
export function monitoringTimerOf(manager: object, runId: string): (NodeJS.Timeout & { _onTimeout(): void }) | undefined {
  const internal = manager as {
    store: { getRun(id: string): { waits?: Wait[] } | undefined };
    waitTimers: Map<string, { runId: string; timer: NodeJS.Timeout }>;
  };
  const id = monitoringTimerWait(internal.store.getRun(runId))?.id;
  return id ? internal.waitTimers.get(id)?.timer as (NodeJS.Timeout & { _onTimeout(): void }) | undefined : undefined;
}
