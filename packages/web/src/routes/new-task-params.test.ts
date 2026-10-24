// @vitest-environment node

import { describe, expect, it } from 'vitest'

import { newTaskPrefillHref, parseNewTaskParams, type NewTaskParams } from './new-task-params'

const empty: NewTaskParams = { skill: '', ref: '', auto: false, key: '' }

/** The saved-bookmarklet contract (spec 011) — protected by BACKWARD_COMPATIBILITY.md,
 *  and these links live in users' browsers, not in this repo. The cases below mirror
 *  `initFromQuery()` in web/app.js so the React `/new` accepts exactly what the legacy
 *  page did. */
describe('parseNewTaskParams', () => {
  const cases: Array<[name: string, search: string, expected: NewTaskParams]> = [
    ['no query at all', '', empty],
    [
      'the full bookmarklet link',
      '?skill=om-code-review&ref=https%3A%2F%2Fgithub.com%2Fo%2Fr%2Fpull%2F1&auto=1&key=s3cret',
      { skill: 'om-code-review', ref: 'https://github.com/o/r/pull/1', auto: true, key: 's3cret' },
    ],
    ['skill only (the "open the composer with this skill" bookmarklet)', '?skill=om-fix', { ...empty, skill: 'om-fix' }],
    // `task` is the older spelling of `ref`; app.js still accepts it, so must we.
    ['legacy `task` alias for `ref`', '?task=issue-12', { ...empty, ref: 'issue-12' }],
    ['`ref` wins over `task` when both are present', '?ref=a&task=b', { ...empty, ref: 'a' }],
    // Only the exact string `1` arms auto-start — anything else is a plain visit.
    ['auto=0 is not auto-start', '?auto=0', empty],
    ['auto=true is not auto-start', '?auto=true', empty],
    ['auto present but empty is not auto-start', '?auto=', empty],
    ['whitespace around skill/ref is trimmed', '?skill=%20om-fix%20&ref=%20x%20', { ...empty, skill: 'om-fix', ref: 'x' }],
    ['unknown params are ignored', '?skill=om-fix&nope=1', { ...empty, skill: 'om-fix' }],
    // Retired Inbox parameters are ignored on saved links.
    ['ignores the retired todo parameter', '?skill=om-fix&ref=fix+it&todo=t1', { ...empty, skill: 'om-fix', ref: 'fix it' }],
    ['ignores a whitespace-wrapped retired todo parameter', '?todo=%20t1%20', { ...empty }],
    ['preserves bookmarklet fields', '?skill=om-fix&auto=1&key=k', { ...empty, skill: 'om-fix', auto: true, key: 'k' }],
  ]

  for (const [name, search, expected] of cases) {
    it(name, () => {
      expect(parseNewTaskParams(search)).toEqual(expected)
    })
  }

  it('takes a URLSearchParams too (what useSearchParams hands the route)', () => {
    expect(parseNewTaskParams(new URLSearchParams('skill=om-fix&auto=1'))).toEqual({
      ...empty,
      skill: 'om-fix',
      auto: true,
    })
  })
})

/** The in-app half of the contract (#374). The rule that matters: a prefill link is inert —
 *  it can never arm the unattended start, whatever it carries. */
describe('newTaskPrefillHref', () => {
  it('emits only the params it was given', () => {
    expect(newTaskPrefillHref({ skill: 'om-fix', ref: 'fix it' })).toBe(
      '/new?skill=om-fix&ref=fix+it',
    )
    expect(newTaskPrefillHref({ ref: 'fix it' })).toBe('/new?ref=fix+it')
    expect(newTaskPrefillHref({})).toBe('/new')
  })

  it('NEVER emits auto/key (#355: no blind launch)', () => {
    const params = new URLSearchParams(
      newTaskPrefillHref({ skill: 'om-fix', ref: 'fix it' }).split('?')[1],
    )
    expect(params.has('auto')).toBe(false)
    expect(params.has('key')).toBe(false)
  })

  it('round-trips through the parser (in-app links use the same shape /new reads)', () => {
    const href = newTaskPrefillHref({ skill: 'om-fix', ref: 'fix it\nnow' })
    expect(parseNewTaskParams(href.split('?')[1] ?? '')).toEqual({
      ...empty,
      skill: 'om-fix',
      ref: 'fix it\nnow',
    })
  })
})
