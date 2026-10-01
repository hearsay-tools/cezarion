import { describe, expect, it } from 'vitest'

import type { LogEntry } from '@open-mercato/cezar-api-client'

import { commitDayLabel, commitsToday, fetchedAgo, groupCommitsByDay } from './git-sections'

const commit = (hash: string, at: string, when: string): LogEntry => ({ hash, subject: hash, author: 'Ada', when, at })

describe('Recently on main day grouping', () => {
  it('files a commit made just after midnight under Today, whatever git rounds its relative age to', () => {
    // 00:10 today, read at 01:40: git's %cr says "2 hours ago" (it rounds 90 minutes up), which an
    // estimate turns into 23:40 yesterday. The absolute `at` keeps the commit on its own day.
    const now = new Date('2026-09-30T01:40:00').getTime()
    const log = [commit('after', '2026-09-30T00:10:00', '2 hours ago'), commit('before', '2026-09-29T23:50:00', '2 hours ago')]
    expect(groupCommitsByDay(log, now)).toEqual([
      { label: 'Today', commits: [log[0]] },
      { label: 'Yesterday', commits: [log[1]] },
    ])
    expect(commitsToday(log, now)).toBe(1)
  })

  it('labels older days by date, with the year once it is not this one', () => {
    const now = new Date('2026-09-30T12:00:00').getTime()
    expect(commitDayLabel('2026-09-27T09:00:00', now)).toBe('Sun, Sep 27')
    expect(commitDayLabel('2025-12-31T09:00:00', now)).toBe('Dec 31, 2025')
    expect(commitDayLabel('not a date', now)).toBe('Earlier')
  })
})

describe('fetchedAgo', () => {
  it('says how long ago the last fetch was, or that there never was one', () => {
    const now = new Date('2026-09-30T12:00:00Z').getTime()
    expect(fetchedAgo({ ref: 'origin/main', ahead: 0, behind: 0, fetchedAt: '2026-09-30T11:54:00Z' }, now)).toBe('fetched 6m ago')
    expect(fetchedAgo({ ref: 'origin/main', ahead: 0, behind: 0, fetchedAt: null }, now)).toBe('never fetched')
  })
})
