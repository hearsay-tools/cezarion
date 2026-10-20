import type { Wait } from '@open-mercato/cezar-api-client'

/**
 * Wait-list entries for cockpit fixtures. A park is an entry in the run's `waits`
 * (spec 2026-10-17-unified-waits): a worker wait since hearsay-tools/cezarion#1235, and the
 * monitoring park, the agent's timer, since hearsay-tools/cezarion#1301.
 */

/** The agent's open wait on one worker; `requestIds` with empty `workerIds` waits on replies. */
export function workerWait(over: Record<string, unknown> = {}): Wait {
  return {
    kind: 'worker', id: '00000000-0000-4000-8000-0000000000e1', source: 'agent', via: 'cez-worker-wait',
    registeredAt: '2026-09-05T00:00:00.000Z', deadline: '2026-09-06T00:00:00.000Z', phase: 'open', turnId: 'turn-1',
    timeoutSeconds: 600, workerIds: ['00000000-0000-4000-8000-000000000001'], revisions: [], outcomes: [],
    ...over,
  } as Wait
}

/** The agent's open monitoring-line timer: the run reads `monitoring`. */
export function timerWait(over: Record<string, unknown> = {}): Wait {
  return {
    kind: 'timer', id: '00000000-0000-4000-8000-0000000000d1', source: 'agent', via: 'monitoring-line',
    registeredAt: '2026-09-05T00:00:00.000Z', deadline: '2026-09-05T00:05:00.000Z', phase: 'open', turnId: 'turn-1', seconds: 300,
    ...over,
  } as Wait
}
