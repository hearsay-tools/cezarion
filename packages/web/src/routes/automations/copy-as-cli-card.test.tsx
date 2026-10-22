import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ReactElement } from 'react'
import { MemoryRouter } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { CopyAsCliCard } from './copy-as-cli-card'
import { fromDefinition } from './editor-draft'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

const draft = fromDefinition({
  name: 'Nightly',
  kind: 'schedule',
  schedule: { type: 'daily', hour: 4, minute: 0 },
  task: { prompt: "Bump what's stale", workflow: 'quick-task', worktree: true, autonomous: false },
})
/** Mounted where the editor lives: under a project, so the line names this cockpit and project. */
const renderInProject = (ui: ReactElement) => render(<MemoryRouter initialEntries={['/p/my-proj/automations/a1']}>{ui}</MemoryRouter>)
const address = `CEZ_COCKPIT_URL='${window.location.origin}' CEZ_PROJECT_ID='my-proj' `
const line = address + "cez automation add --name 'Nightly' --cron '0 4 * * *' --workflow 'quick-task' --no-autonomous --prompt 'Bump what'\\''s stale'"

describe('CopyAsCliCard', () => {
  it('prints the line and copies it, saying so', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    renderInProject(<CopyAsCliCard draft={draft} />)
    expect(screen.getByRole('heading', { name: 'Copy as CLI' })).not.toBeNull()
    expect(screen.getByText(line)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(line))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).not.toBeNull())
  })

  it('says so when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    renderInProject(<CopyAsCliCard draft={draft} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/could not copy/i))
  })

  // hearsay-tools/cezarion#1465.
  it('once emits --at --tz --latest-start', () => {
    const once = fromDefinition({ name: 'Check', kind: 'schedule', schedule: { type: 'once', at: '2030-01-15T09:00', timeZone: 'Europe/Warsaw', latestStartMinutes: 360 }, task: { prompt: 'Go', workflow: 'quick-task', worktree: true } })
    renderInProject(<CopyAsCliCard draft={once} />)
    expect(screen.getByText(`${address}cez automation add --name 'Check' --at '2030-01-15T09:00' --tz 'Europe/Warsaw' --latest-start '6h' --workflow 'quick-task' --prompt 'Go'`)).not.toBeNull()
  })

  it('falls back to the JSON form for what flags cannot say', () => {
    renderInProject(<CopyAsCliCard draft={{ ...draft, description: 'Nightly bumps' }} />)
    expect(screen.getByText((text) => text.startsWith(`${address}cez automation create --json '`))).not.toBeNull()
  })
})
