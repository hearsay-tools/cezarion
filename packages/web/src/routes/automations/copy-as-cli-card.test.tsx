import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
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
const line = "cez automation add --name 'Nightly' --cron '0 4 * * *' --workflow 'quick-task' --no-autonomous --prompt 'Bump what'\\''s stale'"

describe('CopyAsCliCard', () => {
  it('prints the line and copies it, saying so', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText } })
    render(<CopyAsCliCard draft={draft} />)
    expect(screen.getByRole('heading', { name: 'Copy as CLI' })).not.toBeNull()
    expect(screen.getByText(line)).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(writeText).toHaveBeenCalledWith(line))
    await waitFor(() => expect(screen.getByRole('button', { name: 'Copied' })).not.toBeNull())
  })

  it('says so when the clipboard refuses', async () => {
    vi.stubGlobal('navigator', { ...navigator, clipboard: { writeText: vi.fn(async () => { throw new Error('denied') }) } })
    render(<CopyAsCliCard draft={draft} />)
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    await waitFor(() => expect(screen.getByRole('status').textContent).toMatch(/could not copy/i))
  })

  it('falls back to the JSON form for what flags cannot say', () => {
    render(<CopyAsCliCard draft={{ ...draft, description: 'Nightly bumps' }} />)
    expect(screen.getByText(/^cez automation create --json '/)).not.toBeNull()
  })
})
