import { summaryOf } from '@/test/run-summary-fixture'
import type { RunRecord, RunSummary } from '@open-mercato/cezar-api-client'

let seq = 0

/** One run summary for the voice tests; `createdAt` falls one minute per call so the sidebar
 *  order (newest first inside a rank) follows the order the tests build them in, newest last. */
export function voiceRun(over: Partial<RunRecord> = {}): RunSummary {
  seq += 1
  const minute = String(seq % 60).padStart(2, '0')
  const hour = String(Math.floor(seq / 60) % 24).padStart(2, '0')
  return summaryOf({
    id: `v${seq}`,
    title: `Task ${seq}`,
    workflow: 'default',
    task: `task ${seq}`,
    status: 'done',
    createdAt: `2026-07-14T${hour}:${minute}:00.000Z`,
    tokensUsed: 0,
    archived: false,
    steps: [],
    ...over,
  })
}
