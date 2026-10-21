// @vitest-environment node

import { openHumanWait } from '@/test/run-summary-fixture'
import { timerWait, workerWait } from '@/test/wait-fixtures'
import { describe, expect, it } from 'vitest'

import { VOICE_STATUS_IDS, type VoiceStatus } from '@open-mercato/cezar-api-client/contract/voice'
import type { RunRecord, RunSummary } from '@open-mercato/cezar-api-client'
import { voiceRun } from './fixture.testkit'
import { voiceStatusMatches } from './status-map'

const root = { role: 'root', permissions: [], receipts: [] }

/** One run that sits in each status, built from the real record shapes the dot reads. */
const FIXTURES: Record<VoiceStatus, Partial<RunRecord>> = {
  // A shown question: the open human wait the card raised (hearsay-tools/cezarion#1236).
  'needs-you': { status: 'running', waits: [openHumanWait(3)] } as Partial<RunRecord>,
  working: { status: 'running' },
  finished: { status: 'done' },
  archived: { status: 'done', archived: true },
  'needs-review': { status: 'review' },
  'needs-permission': { status: 'running', hasPendingPermission: true },
  failed: { status: 'failed' },
  running: { status: 'running' },
  'waiting-for-ci': { status: 'waiting', waits: [{ ...timerWait(), kind: 'ci' }] } as Partial<RunRecord>,
  monitoring: { status: 'waiting', waits: [timerWait()] } as Partial<RunRecord>,
  'waiting-for-capacity': {
    status: 'waiting',
    delegation: root,
    waits: [workerWait({ phase: 'resolved' })],
  } as Partial<RunRecord>,
  queued: { status: 'queued' },
  // A usage-limit hold: `waiting` with a resume booked (hearsay-tools/cezarion#1236).
  scheduled: { status: 'waiting', autoResumeAt: '2026-07-14T12:00:00.000Z' },
  'waiting-on-workers': { status: 'waiting', delegation: root, waits: [workerWait()] } as Partial<RunRecord>,
  done: { status: 'done' },
  cancelled: { status: 'cancelled' },
  unread: { status: 'done', finishedAt: '2026-07-14T11:00:00.000Z' },
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
    const failedUnread = voiceRun({ status: 'failed', finishedAt: '2026-07-14T11:00:00.000Z' })
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
    const read = voiceRun({ status: 'done', finishedAt: '2026-07-14T11:00:00.000Z', seenAt: '2026-07-14T12:00:00.000Z' })
    expect(voiceStatusMatches('unread', read)).toBe(false)
  })

  it('archived runs match archived only by the flag', () => {
    expect(voiceStatusMatches('archived', voiceRun({ archived: false }))).toBe(false)
    expect(voiceStatusMatches('archived', voiceRun({ archived: true }))).toBe(true)
  })
})
