import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import type { PlanEntry } from '@open-mercato/cezar-api-client'

import thinkingEditWriteTodo from '../../../../cezar/src/core/__fixtures__/claude/thinking-edit-write-todo.expected.json'
import { PlanList, planCounts } from './plan-dock'

afterEach(cleanup)

/** The golden claude `plan.updated` snapshot (thinking-edit-write-todo) — the exact entry
 *  shapes the R2 mapper is pinned to: completed / in_progress / pending, each with an
 *  `activeForm`. Never hand-invented. */
const GOLDEN: PlanEntry[] = (thinkingEditWriteTodo as Array<{ type: string; entries?: PlanEntry[] }>).find(
  (event) => event.type === 'plan.updated',
)!.entries!

describe('planCounts — the odometer math', () => {
  it('counts completed over total (the golden snapshot is 1/3)', () => {
    expect(planCounts(GOLDEN)).toEqual({ done: 1, total: 3 })
  })

  // opencode's `cancelled` — work dropped on purpose. Counting it would strand the
  // odometer below N/N for the rest of the run.
  it('leaves cancelled entries out of the denominator, so a plan can still read done', () => {
    expect(
      planCounts([
        { content: 'a', status: 'completed' },
        { content: 'b', status: 'completed' },
        { content: 'c', status: 'cancelled' },
      ]),
    ).toEqual({ done: 2, total: 2 })
  })

  it('an all-cancelled plan is 0/0, not a division by the dropped work', () => {
    expect(planCounts([{ content: 'a', status: 'cancelled' }])).toEqual({ done: 0, total: 0 })
  })
})

describe('PlanList', () => {
  it('renders nothing for an emptied plan (full replacement can clear it)', () => {
    render(<PlanList entries={[]} />)
    expect(document.querySelector('[data-slot="plan-list"]')).toBeNull()
  })

  it('renders the three row states of the golden snapshot', () => {
    render(<PlanList entries={GOLDEN} />)
    const rows = [...document.querySelectorAll('[data-slot="plan-item"]')]
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'in_progress', 'pending'])
    expect(rows.map((row) => row.textContent)).toEqual([
      'Patch middleware redirect',
      'Run testsin progress', // content + the "in progress" tag
      'Update changelog',
    ])
    expect(rows[0]!.className).toContain('line-through')
    expect(rows[1]!.querySelector('[data-slot="plan-tag"]')?.textContent).toBe('in progress')
    expect(rows[1]!.querySelector('svg')?.getAttribute('class')).toContain('animate-pulse')
    expect(rows[2]!.querySelector('[data-slot="plan-tag"]')).toBeNull()
  })

  // Regression: an opencode `cancelled` todo used to be dropped by the mapper and
  // never reached the dock at all. It must render — struck through, out of the score.
  it('renders a cancelled row struck through and keeps it out of the odometer', () => {
    render(
      <PlanList
        entries={[
          { content: 'Ship the fix', status: 'completed' },
          { content: 'Rework the parser', status: 'cancelled' },
        ]}
      />,
    )
    const rows = [...document.querySelectorAll('[data-slot="plan-item"]')]
    expect(rows.map((row) => row.getAttribute('data-status'))).toEqual(['completed', 'cancelled'])
    expect(rows.map((row) => row.textContent)).toEqual(['Ship the fix', 'Rework the parser'])
    expect(rows[1]!.className).toContain('line-through')
    expect(rows[1]!.querySelector('[data-slot="plan-tag"]')).toBeNull()

    // Pin the ⊘ by its own slash path: asserting only "not animate-pulse" would
    // also pass for the pending ○, i.e. it would survive deleting the glyph.
    const cancelledIcon = rows[1]!.querySelector('svg')!
    expect(cancelledIcon.querySelector('path')?.getAttribute('d')).toBe('m8.5 15.5 7-7')
    expect(cancelledIcon.getAttribute('class')).not.toContain('animate-pulse')
  })
})
