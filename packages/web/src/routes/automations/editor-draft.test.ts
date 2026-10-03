// @vitest-environment node

import { describe, expect, it } from 'vitest'
import type { AutomationDefinition } from '@open-mercato/cezar-api-client'

import { fromDefinition, toCreateBody, toUpdateBody, type AutomationDraft } from './editor-draft'

describe('fromDefinition', () => {
  it('starts a new draft as a paused daily 04:00 schedule that runs autonomously', () => {
    expect(fromDefinition()).toMatchObject({
      name: '',
      kind: 'schedule',
      schedule: { type: 'daily', hour: 4, minute: 0, day: 1, every: 6 },
      events: ['issue.opened'],
      intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25 },
      workflow: 'quick-task',
      autonomous: true,
      enabled: false,
    })
  })

  it('reads a stored definition, filling schedule defaults and keeping task keys it does not edit', () => {
    const stored = {
      id: 'a1', revision: 3, name: 'Digest', kind: 'schedule', enabled: true, schedule: { type: 'weekly', day: 3 },
      task: { prompt: 'Go', workflow: 'quick-task', effort: 'high', variants: 2 },
      createdAt: '', updatedAt: '',
    } as AutomationDefinition
    const draft = fromDefinition(stored)
    expect(draft.schedule).toEqual({ type: 'weekly', hour: 4, minute: 0, day: 3, every: 6 })
    expect(draft.enabled).toBe(true)
    expect(toUpdateBody(draft, 3).task).toMatchObject({ prompt: 'Go', effort: 'high', variants: 2 })
  })
})

describe('toCreateBody', () => {
  const schedule: AutomationDraft = {
    ...fromDefinition(), name: 'Weekly', description: 'Mondays', schedule: { type: 'weekly', hour: 7, minute: 30, day: 2, every: 6 },
    prompt: 'Summarise', runner: 'codex', model: 'gpt-x', autonomous: false, enabled: true,
  }
  const github: AutomationDraft = {
    ...fromDefinition(), name: 'Triage', kind: 'github', events: ['issue.opened', 'pull_request.opened'], intervalSeconds: 900,
    filters: { lookbackDays: 3, maxRecords: 10, anyLabels: ['bug'] }, prompt: 'Review {{github.url}}',
  }

  it('sends a schedule draft with no poll keys, and only the keys its shape uses', () => {
    const body = toCreateBody(schedule)
    expect(body).toMatchObject({ kind: 'schedule', enable: true, schedule: { type: 'weekly', hour: 7, minute: 30, day: 2 } })
    expect(body).not.toHaveProperty('events')
    expect(body).not.toHaveProperty('filters')
    expect(body).not.toHaveProperty('intervalSeconds')
    expect(body.schedule).not.toHaveProperty('every')
    expect(body.task).toEqual({ prompt: 'Summarise', workflow: 'quick-task', runner: 'codex', model: 'gpt-x', autonomous: false })
  })

  it('sends a github draft with no schedule', () => {
    const body = toCreateBody(github)
    expect(body).toMatchObject({ kind: 'github', events: ['issue.opened', 'pull_request.opened'], intervalSeconds: 900, filters: { anyLabels: ['bug'] } })
    expect(body).not.toHaveProperty('schedule')
  })

  it('sends the shape-specific keys: hours carries `every`, daily carries the time', () => {
    expect(toCreateBody({ ...schedule, schedule: { type: 'hours', hour: 4, minute: 0, day: 1, every: 8 } }).schedule).toEqual({ type: 'hours', every: 8 })
    expect(toCreateBody({ ...schedule, schedule: { type: 'daily', hour: 9, minute: 5, day: 1, every: 6 } }).schedule).toEqual({ type: 'daily', hour: 9, minute: 5 })
  })

  it('omits an empty description and an unset runner and model', () => {
    const body = toCreateBody({ ...schedule, description: '', runner: undefined, model: undefined })
    expect(body).not.toHaveProperty('description')
    expect(body.task).not.toHaveProperty('runner')
    expect(body.task).not.toHaveProperty('model')
  })

  it.each([['schedule', schedule], ['github', github]] as const)('round-trips a %s draft through fromDefinition', (_kind, draft) => {
    expect(fromDefinition(toCreateBody(draft))).toEqual(draft)
  })
})

describe('toUpdateBody', () => {
  it('echoes the revision it read and the enabled state it was given, and keeps the kind stable', () => {
    const draft: AutomationDraft = { ...fromDefinition(), name: 'X', prompt: 'p', enabled: true }
    const body = toUpdateBody(draft, 5)
    expect(body).toMatchObject({ kind: 'schedule', expectedRevision: 5, enabled: true })
    expect(body).not.toHaveProperty('enable')
    expect(body).not.toHaveProperty('events')
  })
  it('omits `schedule` for a github draft', () => {
    const body = toUpdateBody({ ...fromDefinition(), kind: 'github', name: 'G', prompt: 'p' }, 1)
    expect(body).not.toHaveProperty('schedule')
    expect(body).toMatchObject({ events: ['issue.opened'], intervalSeconds: 300 })
  })
})
