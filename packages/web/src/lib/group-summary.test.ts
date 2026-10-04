// @vitest-environment node

import { summaryOf } from '@/test/run-summary-fixture'
import { describe, expect, it } from 'vitest'

import type { RunRecord, RunSummary } from '@open-mercato/cezar-api-client'
import { GROUP_FAMILIES, attentionFamily, familiesOfLabels, groupAge, groupFamilies, groupMetaParts, resumeLabel, referenceKey, sharedReferenceKeys } from '@/lib/group-summary'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
let seq = 0
function run(over: Partial<RunRecord> = {}): RunSummary {
  seq += 1
  return summaryOf({ id: `r${seq}`, title: 'Upstream ledger', workflow: 'default', task: 't', status: 'running', createdAt: ago(12 * 60_000), tokensUsed: 0, archived: false, steps: [], ...over })
}
const parked = (): Partial<RunRecord> => ({
  status: 'waiting',
  delegation: { role: 'root', permissions: [], receipts: [], wait: { id: 'w', workerIds: ['00000000-0000-4000-8000-000000000001'], deadline: '2026-09-06T00:00:00.000Z', phase: 'parked', outcomes: [] } },
} as Partial<RunRecord>)

describe('attentionFamily', () => {
  it.each([
    ['needs you', 'needs you'], ['needs review', 'needs review'], ['needs permission', 'needs permission'],
    ['failed', 'failed'], ['running', 'working'], ['monitoring', 'working'], ['waiting on 2 workers', 'working'],
    ['waiting on workers', 'working'], ['waiting on worker replies', 'working'], ['queued', 'queued'],
    ['scheduled', 'scheduled'], ['done', 'done'], ['cancelled', 'cancelled'],
  ])('%s → %s', (label, family) => {
    expect(attentionFamily(label)).toBe(family)
  })
})

describe('groupFamilies (the aggregate in words)', () => {
  it('one family', () => {
    expect(groupFamilies([run(), run()])).toEqual(['2 working'])
  })
  it('two families, in family order, not member order', () => {
    expect(groupFamilies([run(), run({ status: 'waiting' })])).toEqual(['1 needs you', '1 working'])
    expect(groupFamilies([run({ status: 'failed' }), run({ status: 'done', finishedAt: ago(1) })])).toEqual(['1 failed', '1 done'])
  })
  it('three families are capped at the first two', () => {
    expect(groupFamilies([run({ status: 'done' }), run({ status: 'review' }), run({ status: 'queued' })])).toEqual(['1 needs review', '1 queued'])
  })
  it('counts running, monitoring and waiting on workers as one working family — never "waiting"', () => {
    expect(groupFamilies([run(), run({ activity: 'monitoring' }), run(parked())])).toEqual(['3 working'])
    expect(groupFamilies([run({ status: 'waiting' }), run(parked())])).toEqual(['1 needs you', '1 working'])
  })
  it('puts cancelled after done, and counts scheduled apart from queued (a clock, not a slot)', () => {
    expect(groupFamilies([run({ status: 'cancelled' }), run({ status: 'done' })])).toEqual(['1 done', '1 cancelled'])
    expect(groupFamilies([run({ status: 'failed', autoResumeAt: ago(-60_000) }), run({ status: 'queued' })])).toEqual(['1 queued', '1 scheduled'])
  })
  it('counts needs permission apart from needs review (a tool approval is not a review)', () => {
    expect(familiesOfLabels(['needs review', 'needs permission'])).toEqual(['1 needs permission', '1 needs review'])
  })
  it('keeps the full family order', () => {
    expect(GROUP_FAMILIES).toEqual(['needs you', 'needs permission', 'needs review', 'failed', 'working', 'queued', 'scheduled', 'done', 'cancelled'])
    // Every pair a group can hold resolves in that order, whatever the member order.
    for (let i = 0; i < GROUP_FAMILIES.length; i++) for (let j = i + 1; j < GROUP_FAMILIES.length; j++) {
      expect(GROUP_FAMILIES.indexOf(GROUP_FAMILIES[i]!)).toBeLessThan(GROUP_FAMILIES.indexOf(GROUP_FAMILIES[j]!))
    }
    expect(groupFamilies([run({ status: 'done' }), run({ status: 'queued' }), run({ status: 'failed', autoResumeAt: ago(-60_000) })])).toEqual(['1 queued', '1 scheduled'])
  })
})

describe('shared references', () => {
  it.each(['prNumber', 'issueNumber'] as const)('does not share bare %s across projects', (field) => {
    const a = { ...run({ [field]: 711 }), projectId: 'cezarion' }
    const b = { ...run({ [field]: 711 }), projectId: 'toolkit-dev' }
    expect([...sharedReferenceKeys([a, b])]).toEqual([])
    expect(sharedReferenceKeys([a, { ...a, id: 'another-task' }]).size).toBe(1)
  })

  it('uses the explicit project scope for project-local records', () => {
    const members = [run({ issueNumber: 9 }), run({ issueNumber: 9 })]
    expect([...sharedReferenceKeys(members, 'cezarion')]).toEqual(['Issue#9@project:cezarion'])
    expect([...sharedReferenceKeys(members, 'toolkit-dev')]).toEqual(['Issue#9@project:toolkit-dev'])
  })

  it('scopes direct bare keys without changing URL identity', () => {
    const bare = { kind: 'PR', number: 711, projectId: 'cezarion' }
    expect(referenceKey(bare)).not.toBe(referenceKey({ ...bare, projectId: 'toolkit-dev' }))
    expect(referenceKey({ ...bare, url: 'https://GitHub.com/O/R/pull/711' })).toBe('PR#711@github.com/o/r')
  })

  const issue = { referencedIssueUrl: 'https://github.com/o/r/issues/425' }
  it('is the reference every member carries', () => {
    expect([...sharedReferenceKeys([run(issue), run(issue)])]).toEqual(['Issue#425@github.com/o/r'])
  })
  it('drops a reference only some members carry (each variant shows its own PR instead)', () => {
    const shared = sharedReferenceKeys([
      run({ ...issue, pullRequestUrl: 'https://github.com/o/r/pull/611' }),
      run({ ...issue, pullRequestUrl: 'https://github.com/o/r/pull/612' }),
    ])
    expect([...shared]).toEqual(['Issue#425@github.com/o/r'])
    expect([...sharedReferenceKeys([run({ pullRequestUrl: 'https://github.com/o/r/pull/611' }), run()])]).toEqual([])
  })
  // Review round 6: kind + number alone called two repositories' #7 the same reference.
  it('keeps the same number in two repositories apart', () => {
    expect([...sharedReferenceKeys([
      run({ pullRequestUrl: 'https://github.com/o/a/pull/7' }),
      run({ pullRequestUrl: 'https://github.com/o/b/pull/7' }),
    ])]).toEqual([])
    expect([...sharedReferenceKeys([
      run({ referencedIssueUrl: 'https://github.com/o/a/issues/7' }),
      run({ referencedIssueUrl: 'https://github.com/o/b/issues/7' }),
    ])]).toEqual([])
  })
  it('shares the same URL on every member, and a number-only reference by kind and number', () => {
    const pr = { pullRequestUrl: 'https://github.com/o/a/pull/7' }
    expect(sharedReferenceKeys([run(pr), run(pr)]).size).toBe(1)
    expect(sharedReferenceKeys([run({ issueNumber: 9 }), run({ issueNumber: 9 })]).size).toBe(1)
  })
})

describe('groupAge', () => {
  it('while every variant runs, is their shared start', () => {
    expect(groupAge([run({ createdAt: ago(12 * 60_000) }), run({ createdAt: ago(12 * 60_000) })], NOW)).toBe('12m')
  })
  it('once one finishes, is when the group last changed', () => {
    expect(groupAge([run({ createdAt: ago(3 * 3_600_000) }), run({ status: 'done', createdAt: ago(3 * 3_600_000), finishedAt: ago(2 * 3_600_000) })], NOW)).toBe('2h')
  })
})

describe('groupMetaParts', () => {
  it('joins only the parts that exist — no dangling separator', () => {
    const parts = groupMetaParts([run({ status: 'waiting' }), run()], NOW)
    expect(parts.families).toEqual(['1 needs you', '1 working'])
    expect(parts.age).toBe('12m')
    expect(parts.families.every(Boolean)).toBe(true)
  })
})

describe('resumeLabel (a scheduled run\'s meta word)', () => {
  it('says how long, under an hour', () => {
    expect(resumeLabel(new Date(NOW + 12 * 60_000 + 5_000).toISOString(), NOW)).toBe('resumes in 12m')
    expect(resumeLabel(new Date(NOW + 20_000).toISOString(), NOW)).toBe('resumes in 1m')
  })
  it('says when, from an hour out', () => {
    const at = new Date(NOW + 2 * 3_600_000)
    const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' }).format(at)
    expect(resumeLabel(at.toISOString(), NOW)).toBe(`resumes ${clock}`)
  })
  it('falls back to scheduled when the time is missing, invalid or already past', () => {
    expect(resumeLabel(undefined, NOW)).toBe('scheduled')
    expect(resumeLabel('not a date', NOW)).toBe('scheduled')
    expect(resumeLabel(ago(60_000), NOW)).toBe('scheduled')
  })
})
