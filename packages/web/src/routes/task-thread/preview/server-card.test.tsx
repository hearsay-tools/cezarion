import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { PreviewServerCard } from './server-card'
import type { ThreadPreviewServer } from '../thread-state'

const NOW = Date.parse('2026-10-02T10:06:00.000Z')

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(NOW)
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const entry = (extra: Partial<ThreadPreviewServer> = {}, server: Partial<ThreadPreviewServer['server']> = {}): ThreadPreviewServer => ({
  kind: 'preview-server',
  id: 'preview-server:5173',
  state: 'registered',
  stateAt: '2026-10-02T10:00:00.000Z',
  server: {
    port: 5173,
    command: 'npm run dev -- --port 5173 --strictPort --host 127.0.0.1',
    cwd: 'apps/web',
    label: 'web',
    registeredAt: '2026-10-02T10:00:00.000Z',
    answeredAtRegistration: false,
    ...server,
  },
  ...extra,
})

function renderCard(e: ThreadPreviewServer, inPreview = false) {
  const onOpen = vi.fn()
  render(<PreviewServerCard entry={e} inPreview={inPreview} onOpen={onOpen} />)
  return onOpen
}

const hint = "Runs npm ... in this task's worktree, on the host."

describe('PreviewServerCard (design 05)', () => {
  it('always shows the label, port, exact command and cwd', () => {
    renderCard(entry())
    expect(screen.getByText('web')).toBeTruthy()
    expect(screen.getByText(':5173')).toBeTruthy()
    expect(screen.getByText('npm run dev -- --port 5173 --strictPort --host 127.0.0.1')).toBeTruthy()
    expect(screen.getByText('apps/web')).toBeTruthy()
    expect(screen.getByText('cezar_preview_serve')).toBeTruthy()
    expect(screen.getByText('6m ago')).toBeTruthy()
  })

  it('omits the cwd row when the registration set none', () => {
    renderCard(entry({}, { cwd: undefined }))
    expect(screen.queryByText('cwd')).toBeNull()
  })

  it('registered: "registered · not started", Run and open, with the hint', () => {
    const onOpen = renderCard(entry())
    expect(screen.getByText('registered · not started')).toBeTruthy()
    expect(screen.getByText(hint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Run and open' }))
    expect(onOpen).toHaveBeenCalledWith({ port: 5173, run: true })
  })

  it('starting: Open, no run hint', () => {
    const onOpen = renderCard(entry({ state: 'starting' }))
    expect(screen.getByText('starting')).toBeTruthy()
    expect(screen.queryByText(hint)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith({ port: 5173, run: false })
  })

  it('up: "up · 6m" and Open', () => {
    const onOpen = renderCard(entry({ state: 'up' }))
    expect(screen.getByText('up · 6m')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith({ port: 5173, run: false })
  })

  it('up while the pane shows it: a disabled "In preview"', () => {
    const onOpen = renderCard(entry({ state: 'up' }), true)
    const button = screen.getByRole('button', { name: 'In preview' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onOpen).toHaveBeenCalledWith({ port: 5173, run: false })
    expect(screen.queryByRole('button', { name: 'Open' })).toBeNull()
  })

  it('answered at registration: neutral dot, "was running when registered", Open, never "up"', () => {
    const onOpen = renderCard(entry({}, { answeredAtRegistration: true }))
    expect(screen.getByText('was running when registered')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\bup\b/i)
    expect(document.querySelector('[data-slot="status-dot"]')?.getAttribute('data-tone')).toBe('neutral')
    expect(screen.queryByText(hint)).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    expect(onOpen).toHaveBeenCalledWith({ port: 5173, run: false })
  })

  it('an adopted server reads like an answered one, never "up"', () => {
    renderCard(entry({ state: 'adopted' }))
    expect(screen.getByText('was running when registered')).toBeTruthy()
    expect(document.body.textContent).not.toMatch(/\bup\b/i)
  })

  it('stalled: "stalled · port silent 2 min" and View', () => {
    const onOpen = renderCard(entry({ state: 'stalled' }))
    expect(screen.getByText('stalled · port silent 2 min')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'View' }))
    expect(onOpen).toHaveBeenCalledWith({ port: 5173, run: false })
  })

  it('exited: the exit code, Start again and the hint', () => {
    const onOpen = renderCard(entry({ state: 'exited', exitCode: 1 }))
    expect(screen.getByText('exited · code 1')).toBeTruthy()
    expect(screen.getByText(hint)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    expect(onOpen).toHaveBeenCalledWith({ port: 5173, run: true })
  })

  it('exited without a code (killed by a signal) says just "exited"', () => {
    renderCard(entry({ state: 'exited' }))
    expect(screen.getByText('exited')).toBeTruthy()
  })

  it('stopped after idle: "stopped after 15 min idle", Start again and the hint', () => {
    renderCard(entry({ state: 'stopped', reason: 'idle' }))
    expect(screen.getByText('stopped after 15 min idle')).toBeTruthy()
    expect(screen.getByText(hint)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start again' })).toBeTruthy()
  })

  it('stopped by the user: "stopped" and Start again', () => {
    renderCard(entry({ state: 'stopped', reason: 'user' }))
    expect(screen.getByText('stopped')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Start again' })).toBeTruthy()
  })

  it('unavailable: disabled, the reason, and no action', () => {
    renderCard(entry({ state: 'unavailable' }))
    expect(screen.getByText('unavailable')).toBeTruthy()
    expect(screen.getByText('worktree removed')).toBeTruthy()
    expect(screen.getByText('The worktree this server ran in is gone. Register it again from a new task.')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('names the first word of the command in the hint', () => {
    renderCard(entry({}, { command: 'pnpm dev' }))
    expect(screen.getByText("Runs pnpm ... in this task's worktree, on the host.")).toBeTruthy()
  })

  it('never uses an em-dash', () => {
    for (const state of ['registered', 'starting', 'up', 'stalled', 'exited', 'stopped', 'adopted', 'unavailable'] as const) {
      cleanup()
      renderCard(entry({ state, exitCode: 2 }))
      expect(document.body.textContent).not.toContain('—')
    }
  })
})
