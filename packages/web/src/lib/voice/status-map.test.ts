import {
  RUN_STATUS,
  WAIT_KIND,
  WAIT_PHASE,
  WORKER_OUTCOME_STATUS,
} from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
// @vitest-environment node

import { openHumanWait } from '@/test/run-summary-fixture'
import { timerWait, workerWait } from '@/test/wait-fixtures'
import { describe, expect, it } from 'vitest'

import { VOICE_STATUS_IDS, type VoiceStatus } from '@open-mercato/cezar-api-client/contract/voice'
import type { RunRecord, RunSummary } from '@open-mercato/cezar-api-client'
import { deriveAttention } from '@/lib/attention'
import { voiceRun } from './fixture.testkit'
import { voiceStatusMatches } from './status-map'

const root = { role: 'root', permissions: [], receipts: [] }

/** One run that sits in each status, built from the real record shapes the dot reads. */
const FIXTURES: Record<VoiceStatus, Partial<RunRecord>> = {
  // A shown question: the open human wait the card raised (hearsay-tools/cezarion#1236).
  'needs-you': { status: RUN_STATUS.running, waits: [openHumanWait(3)] } as Partial<RunRecord>,
  working: { status: RUN_STATUS.running },
  finished: { status: RUN_STATUS.done },
  archived: { status: RUN_STATUS.done, archived: true },
  'needs-review': { status: RUN_STATUS.review },
  'needs-permission': { status: RUN_STATUS.running, hasPendingPermission: true },
  failed: { status: RUN_STATUS.failed },
  running: { status: RUN_STATUS.running },
  'waiting-for-ci': { status: RUN_STATUS.waiting, waits: [{ ...timerWait(), kind: WAIT_KIND.pr }] } as Partial<RunRecord>,
  monitoring: { status: RUN_STATUS.waiting, waits: [timerWait()] } as Partial<RunRecord>,
  'waiting-for-capacity': {
    status: RUN_STATUS.waiting,
    delegation: root,
    waits: [workerWait({ phase: WAIT_PHASE.resolved })],
  } as Partial<RunRecord>,
  queued: { status: RUN_STATUS.queued },
  // A usage-limit hold: `waiting` with a resume booked (hearsay-tools/cezarion#1236).
  scheduled: { status: RUN_STATUS.waiting, autoResumeAt: '2026-07-14T12:00:00.000Z' },
  'waiting-on-workers': { status: RUN_STATUS.waiting, delegation: root, waits: [workerWait()] } as Partial<RunRecord>,
  done: { status: RUN_STATUS.done },
  cancelled: { status: RUN_STATUS.cancelled },
  unread: { status: RUN_STATUS.done, finishedAt: '2026-07-14T11:00:00.000Z' },
}

describe('voiceStatusMatches', () => {
  it('matches every status', () => {
    for (const id of VOICE_STATUS_IDS) {
      expect(voiceStatusMatches(id, voiceRun(FIXTURES[id])), id).toBe(true)
    }
  })

  it('covers every contract id', () => {
    const sample: RunSummary = voiceRun()
    for (const id of VOICE_STATUS_IDS) {
      expect(typeof voiceStatusMatches(id, sample), id).toBe('boolean')
    }
  })

  it('statuses overlap', () => {
    const failedUnread = voiceRun({ status: RUN_STATUS.failed, finishedAt: '2026-07-14T11:00:00.000Z' })
    expect(voiceStatusMatches('failed', failedUnread)).toBe(true)
    expect(voiceStatusMatches('finished', failedUnread)).toBe(true)
    expect(voiceStatusMatches('unread', failedUnread)).toBe(true)
    expect(voiceStatusMatches('done', failedUnread)).toBe(false)
  })

  it('a scheduled resume is not failed and sits under Working', () => {
    const scheduled = voiceRun(FIXTURES.scheduled)
    expect(voiceStatusMatches('scheduled', scheduled)).toBe(true)
    expect(voiceStatusMatches('failed', scheduled)).toBe(false)
    expect(voiceStatusMatches('working', scheduled)).toBe(true)
    expect(voiceStatusMatches('finished', scheduled)).toBe(false)
  })

  it('a read finished run does not match unread', () => {
    const read = voiceRun({ status: RUN_STATUS.done, finishedAt: '2026-07-14T11:00:00.000Z', seenAt: '2026-07-14T12:00:00.000Z' })
    expect(voiceStatusMatches('unread', read)).toBe(false)
  })

  it('archived runs match archived only by the flag', () => {
    expect(voiceStatusMatches('archived', voiceRun({ archived: false }))).toBe(false)
    expect(voiceStatusMatches('archived', voiceRun({ archived: true }))).toBe(true)
  })
})

// hearsay-tools/cezarion#1496: the status ids that read the dot now read its rung id instead of
// its label. Each row is one label the dot can show and the ids it answered to on `main` at
// e10fcebb0, so a rung that maps to another id fails here. Merge and command waits answer to none:
// `waiting-for-ci` matched only the label `waiting for CI`.
describe('voiceStatusMatches by attention label', () => {
  const RUNG_IDS: readonly VoiceStatus[] = [
    'needs-permission', 'failed', 'needs-review', 'running', 'waiting-for-ci', 'monitoring',
    'waiting-for-capacity', 'queued', 'scheduled', 'waiting-on-workers', 'done', 'cancelled',
  ]
  const at = '2026-07-14T12:00:00.000Z'
  const asWorker = (summary: RunSummary): RunSummary => ({ ...summary, delegation: { role: 'worker', parentRunId: 'parent' } as RunSummary['delegation'] })
  const rows: ReadonlyArray<[string, RunSummary, readonly VoiceStatus[]]> = [
    ['needs permission', voiceRun({ status: RUN_STATUS.running, hasPendingPermission: true }), ['needs-permission']],
    ['failed', voiceRun({ status: RUN_STATUS.failed }), ['failed']],
    ['needs you', voiceRun({ status: RUN_STATUS.waiting }), []],
    ['needs review', voiceRun({ status: RUN_STATUS.review }), ['needs-review']],
    ['running', voiceRun({ status: RUN_STATUS.running }), ['running']],
    ['usage limit', voiceRun({ status: RUN_STATUS.waiting, autoResumeAt: at }), ['scheduled']],
    ['waiting on 2 workers', voiceRun({ status: RUN_STATUS.waiting, delegation: root, waits: [workerWait({ workerIds: ['a', 'b'] })] } as Partial<RunRecord>), ['waiting-on-workers']],
    ['waiting on workers', voiceRun({ status: RUN_STATUS.waiting, delegation: root, waits: [workerWait({ workerIds: ['a'], outcomes: [{ workerId: 'a', status: WORKER_OUTCOME_STATUS.done, observedAt: at }] })] } as Partial<RunRecord>), ['waiting-on-workers']],
    ['waiting on worker replies', voiceRun({ status: RUN_STATUS.waiting, delegation: root, waits: [workerWait({ workerIds: [], requestIds: ['r'], requestOutcomes: [] })] } as Partial<RunRecord>), ['waiting-on-workers']],
    ['waiting on parent reply', asWorker(voiceRun({ status: RUN_STATUS.waiting, waits: [workerWait({ workerIds: [], requestIds: ['r'], requestOutcomes: [] })] } as Partial<RunRecord>)), ['waiting-on-workers']],
    ['waiting for CI', voiceRun({ status: RUN_STATUS.waiting, waits: [{ ...timerWait(), kind: WAIT_KIND.pr, until: 'checks' }] } as Partial<RunRecord>), ['waiting-for-ci']],
    ['waiting for merge', voiceRun({ status: RUN_STATUS.waiting, waits: [{ ...timerWait(), kind: WAIT_KIND.pr, until: 'merge' }] } as Partial<RunRecord>), []],
    ['waiting for a command', voiceRun({ status: RUN_STATUS.waiting, waits: [{ ...timerWait(), kind: WAIT_KIND.process, pid: 4242 }] } as Partial<RunRecord>), []],
    ['monitoring', voiceRun({ status: RUN_STATUS.waiting, waits: [timerWait()] } as Partial<RunRecord>), ['monitoring']],
    ['waiting for capacity', voiceRun({ status: RUN_STATUS.waiting, delegation: root, waits: [workerWait({ phase: WAIT_PHASE.resolved })] } as Partial<RunRecord>), ['waiting-for-capacity']],
    ['queued', voiceRun({ status: RUN_STATUS.queued }), ['queued']],
    ['done', voiceRun({ status: RUN_STATUS.done }), ['done']],
    ['cancelled', voiceRun({ status: RUN_STATUS.cancelled }), ['cancelled']],
  ]

  it.each(rows)('a run the dot labels %j answers to the same ids as on main', (label, summary, ids) => {
    expect(deriveAttention(summary).label).toBe(label)
    expect(RUNG_IDS.filter((id) => voiceStatusMatches(id, summary))).toEqual(ids)
  })
})
