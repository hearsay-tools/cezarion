import { cleanup, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { NextRunsPreview } from './next-runs-preview'

afterEach(cleanup)
const daily = { type: 'daily', hour: 4, minute: 0, day: 1, every: 6 } as const

it('lists five upcoming runs in the zone, each with its distance', () => {
  // 2026-07-15 10:00 UTC is 12:00 in Warsaw: the next 04:00 is tomorrow.
  render(<NextRunsPreview schedule={daily} timeZone="Europe/Warsaw" now={Date.parse('2026-07-15T10:00:00Z')} />)
  const rows = within(screen.getByRole('list', { name: 'Next 5 runs' })).getAllByRole('listitem')
  expect(rows).toHaveLength(5)
  expect(rows[0]!.textContent).toBe('Thu 04:00in 16h')
  expect(rows[4]!.textContent).toBe('Mon 04:00in 4d')
})

it('puts the first run strictly after now, even when now is exactly an occurrence', () => {
  // 02:00Z is 04:00 Warsaw sharp: that instant has arrived, so the first row is the next day's.
  render(<NextRunsPreview schedule={daily} timeZone="Europe/Warsaw" now={Date.parse('2026-07-15T02:00:00Z')} />)
  const rows = within(screen.getByRole('list', { name: 'Next 5 runs' })).getAllByRole('listitem')
  expect(rows[0]!.textContent).toBe('Thu 04:00in 1d')
})

it('still shows five rows for a weekly schedule, whose runs are a week apart', () => {
  render(<NextRunsPreview schedule={{ type: 'weekly', hour: 9, minute: 0, day: 1, every: 6 }} timeZone="Europe/Warsaw" now={Date.parse('2026-07-15T10:00:00Z')} />)
  expect(within(screen.getByRole('list', { name: 'Next 5 runs' })).getAllByRole('listitem')).toHaveLength(5)
})
