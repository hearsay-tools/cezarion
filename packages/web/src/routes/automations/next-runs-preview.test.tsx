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

// hearsay-tools/cezarion#1465: a one-time schedule has one instant, in its own zone.
it('shows the single instant of a one-time schedule in its own zone', () => {
  const once = { type: 'once', hour: 4, minute: 0, day: 1, every: 6, at: '2026-10-29T09:00', timeZone: 'America/New_York' } as const
  render(<NextRunsPreview schedule={once} timeZone="Europe/Warsaw" now={Date.parse('2026-10-22T13:00:00Z')} />)
  expect(screen.getByRole('heading', { name: 'Runs once' })).not.toBeNull()
  expect(screen.getByText('Thu 29 Oct 2026 09:00')).not.toBeNull()
  expect(screen.getByText('in 7d')).not.toBeNull()
  expect(screen.getByText(/Times are in America\/New_York/)).not.toBeNull()
})

it('says when a one-time schedule\'s time has passed', () => {
  const once = { type: 'once', hour: 4, minute: 0, day: 1, every: 6, at: '2026-10-01T09:00', timeZone: 'UTC' } as const
  render(<NextRunsPreview schedule={once} timeZone="UTC" now={Date.parse('2026-10-22T13:00:00Z')} />)
  expect(screen.getByText('The due time has passed.')).not.toBeNull()
})
