import { describe, expect, it } from 'vitest'
import type { RunSummary } from '@open-mercato/cezar-api-client'
import { deriveAttention, type Attention } from '@/lib/attention'
import { metaStateWord, runRowMeta, runRowTitle } from '@/lib/run-row-meta'
import { summaryOf } from '@/test/run-summary-fixture'

const NOW = Date.parse('2026-07-14T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW - ms).toISOString()
const ahead = (ms: number) => new Date(NOW + ms).toISOString()

function run(over: Partial<RunSummary> = {}): RunSummary {
  return {
    ...summaryOf({
      id: 'r1',
      title: 'Task',
      workflow: 'default',
      task: 'task',
      status: 'done',
      createdAt: ago(60_000),
      tokensUsed: 0,
      archived: false,
      steps: [],
    }),
    ...over,
  }
}

/** Only `label` is read by the state word; the rest of an attention is the dot's business. */
const labelled = (label: string): Attention => ({ bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label })

/** The clock text the meta line prints for a time: the time alone on today's date, the date too otherwise. */
function clockText(at: string): string {
  const sameDay = new Date(at).toDateString() === new Date(NOW).toDateString()
  return new Intl.DateTimeFormat(undefined, sameDay ? { timeStyle: 'short' } : { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(at))
}

const timer = (at: string) => ({ kind: 'timer' as const, waitId: '00000000-0000-4000-8000-0000000000d1', at })
const commandWait = (deadline: string) => ({ kind: 'process' as const, waitId: '00000000-0000-4000-8000-0000000000d2', pid: 4242, deadline })

describe('metaStateWord (#617: the states the dot alone cannot say)', () => {
  const plain = run()

  it.each(['needs you', 'done', 'cancelled'])('says nothing for %s: the dot is the whole story', (label) => {
    expect(metaStateWord(labelled(label), null, plain, NOW)).toBeUndefined()
  })

  it.each(['failed', 'running', 'needs review', 'needs permission', 'waiting on 2 workers', 'waiting on worker replies', 'waiting on parent reply'])(
    'says the attention label for %s',
    (label) => {
      expect(metaStateWord(labelled(label), null, plain, NOW)).toBe(label)
    },
  )

  describe('queued', () => {
    it.each([
      [1, 'queued #1'],
      [2, 'queued #2'],
      [null, 'queued'],
    ])('with position %s reads %j', (position, word) => {
      expect(metaStateWord(labelled('queued'), position, plain, NOW)).toBe(word)
    })
  })

  describe('usage limit', () => {
    it.each([
      ['a resume time in the future', ahead(12 * 60_000), 'usage limit, resumes in 12m'],
      ['a resume time already due', ago(60_000), 'usage limit'],
      ['no resume time', undefined, 'usage limit'],
      ['an unreadable resume time', 'soon', 'usage limit'],
    ])('with %s', (_name, autoResumeAt, word) => {
      expect(metaStateWord(labelled('usage limit'), null, run({ autoResumeAt }), NOW)).toBe(word)
    })
  })

  describe('monitoring', () => {
    it.each([
      ['a timer wait with a readable time', timer(ahead(5 * 60_000)), `monitoring, next check ${clockText(ahead(5 * 60_000))}`],
      ['a timer wait with an unreadable time', timer('later'), 'monitoring'],
      ['a wait that is not a timer', commandWait(ahead(60_000)), 'monitoring'],
      ['no wait at all', undefined, 'monitoring'],
    ])('with %s', (_name, waitingOn, word) => {
      expect(metaStateWord(labelled('monitoring'), null, run({ waitingOn }), NOW)).toBe(word)
    })

    it('names the timer only for the monitoring label', () => {
      expect(metaStateWord(labelled('running'), null, run({ waitingOn: timer(ahead(5 * 60_000)) }), NOW)).toBe('running')
    })
  })

  describe('waiting for a command', () => {
    it.each([
      ['a process wait with a readable deadline', commandWait(ahead(30 * 60_000)), `waiting for a command, until ${clockText(ahead(30 * 60_000))}`],
      ['a process wait with an unreadable deadline', commandWait('later'), 'waiting for a command'],
      ['a wait that is not a process', timer(ahead(60_000)), 'waiting for a command'],
      ['no wait at all', undefined, 'waiting for a command'],
    ])('with %s', (_name, waitingOn, word) => {
      expect(metaStateWord(labelled('waiting for a command'), null, run({ waitingOn }), NOW)).toBe(word)
    })

    it('names the deadline only for that label', () => {
      expect(metaStateWord(labelled('running'), null, run({ waitingOn: commandWait(ahead(30 * 60_000)) }), NOW)).toBe('running')
    })
  })

  it('reads the label of a derived attention, not a literal', () => {
    const failed = run({ status: 'failed' })
    expect(metaStateWord(deriveAttention(failed), null, failed, NOW)).toBe('failed')
  })
})

describe('runRowMeta (#617, #729: what the meta line is made of)', () => {
  const base = { queuePosition: null, inWorkingGroup: false, scope: null, now: NOW }
  const meta = (over: Partial<Parameters<typeof runRowMeta>[0]> & { run: RunSummary }) =>
    runRowMeta({ attention: deriveAttention(over.run), ...base, ...over })

  describe('the age', () => {
    it('counts from creation while the run is unfinished', () => {
      expect(meta({ run: run({ status: 'running', createdAt: ago(5 * 60_000) }) }).age).toBe('5m')
    })

    it('counts from the finish once there is one', () => {
      expect(meta({ run: run({ createdAt: ago(3 * 3_600_000), finishedAt: ago(2 * 60_000) }) }).age).toBe('2m')
    })

    it('is empty for a queued row, whose position rides in the state word', () => {
      const queued = run({ status: 'queued' })
      expect(meta({ run: queued, queuePosition: 3 })).toMatchObject({ age: '', stateWord: 'queued #3' })
    })
  })

  describe('the state word', () => {
    it.each([
      ['a running row elsewhere', false, 'running', 'running'],
      ['a running row in the Working group, where the group says it', true, 'running', undefined],
      ['a row that is not running, in the Working group', true, 'monitoring', 'monitoring'],
    ])('for %s', (_name, inWorkingGroup, label, word) => {
      const attention = labelled(label)
      expect(meta({ run: run({ status: 'running' }), attention, inWorkingGroup }).stateWord).toBe(word)
    })

    it('is the state word of the attention', () => {
      const failed = run({ status: 'failed' })
      expect(meta({ run: failed }).stateWord).toBe(metaStateWord(deriveAttention(failed), null, failed, NOW))
    })
  })

  describe('the references', () => {
    // A row from the all-projects list carries its project even though `RunSummary` does not type it.
    const numbered = Object.assign(run({ prNumber: 594, issueNumber: 12 }), { projectId: 'own' })

    it('lists the pull request before the issue', () => {
      expect(meta({ run: numbered }).references.map((ref) => `${ref.kind} ${ref.number}`)).toEqual(['PR 594', 'Issue 12'])
    })

    it('belongs to the run\'s own project when the row has no explicit scope', () => {
      expect(meta({ run: numbered, scope: null }).references.map((ref) => ref.projectId)).toEqual(['own', 'own'])
    })

    it('belongs to the row\'s explicit scope, for a non-active project\'s row', () => {
      expect(meta({ run: numbered, scope: 'other' }).references.map((ref) => ref.projectId)).toEqual(['other', 'other'])
    })

    it('is empty for a run that references nothing', () => {
      expect(meta({ run: run() }).references).toEqual([])
    })
  })

  describe('the key that tells the line its content changed', () => {
    it('joins age, state word, references and the hand-off flag', () => {
      const keyed = run({ status: 'failed', createdAt: ago(5 * 60_000), finishedAt: ago(5 * 60_000), prNumber: 594, notify: true })
      expect(meta({ run: keyed }).key).toBe('5m|failed|PR-594-undefined|1')
    })

    it('has empty fields where the row has no state word, no reference and no hand-off', () => {
      expect(meta({ run: run({ finishedAt: ago(60_000) }) }).key).toBe('1m|||0')
    })

    it('lists every reference, in order', () => {
      const both = run({ finishedAt: ago(60_000), prNumber: 594, issueNumber: 12 })
      expect(meta({ run: both }).key).toBe('1m||PR-594-undefined,Issue-12-undefined|0')
    })

    it('changes with the state word', () => {
      const running = run({ status: 'running' })
      const failed = run({ status: 'failed', createdAt: running.createdAt })
      expect(meta({ run: running }).key).not.toBe(meta({ run: failed }).key)
    })
  })
})

describe('runRowTitle (#788, option C: the reference replaces the NNN: prefix)', () => {
  it('drops the prefix when the reference is the same number', () => {
    expect(runRowTitle(run({ title: '594: Fix the login bug', prNumber: 594 }))).toEqual({
      title: '594: Fix the login bug',
      displayTitle: 'Fix the login bug',
    })
  })

  it('keeps the prefix when the reference is another number: an issue that shipped as a different PR', () => {
    expect(runRowTitle(run({ title: '788: Fix the login bug', prNumber: 790 })).displayTitle).toBe('788: Fix the login bug')
  })

  it('keeps the prefix when the run has no reference', () => {
    expect(runRowTitle(run({ title: '594: Fix the login bug' })).displayTitle).toBe('594: Fix the login bug')
  })

  it('leaves a title with no prefix alone', () => {
    expect(runRowTitle(run({ title: 'fix: the login bug', prNumber: 594 })).displayTitle).toBe('fix: the login bug')
  })

  it('titles the row with the summary where there is one, and strips the prefix from that', () => {
    const titled = run({ title: 'raw', titleSummary: '594: Fix the login bug', titleOrigin: 'user', prNumber: 594 })
    expect(runRowTitle(titled)).toEqual({ title: '594: Fix the login bug', displayTitle: 'Fix the login bug' })
  })
})
