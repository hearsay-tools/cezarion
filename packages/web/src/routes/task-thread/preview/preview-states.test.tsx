import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { PreviewServer } from '@open-mercato/cezar-api-client'

import type { ThreadPreviewServer } from '../thread-state'

import { ConnectionBanner, PreviewEmptyState, PreviewStates, type PreviewStageState, type PreviewStateActions } from './preview-states'

afterEach(() => cleanup())

const server: PreviewServer = {
  port: 5173,
  command: 'npm run dev -- --port 5173 --strictPort --host 127.0.0.1',
  cwd: 'apps/web',
  label: 'web',
  registeredAt: '2026-10-02T10:00:00.000Z',
  answeredAtRegistration: false,
}

const actions = (): PreviewStateActions => ({
  download: vi.fn(),
  cancelDownload: vi.fn(),
  retryBrowser: vi.fn(),
  run: vi.fn(),
  stop: vi.fn(),
  keepWaiting: vi.fn(),
  close: vi.fn(),
  useHere: vi.fn(),
  copy: vi.fn(),
})

function show(state: PreviewStageState, a: PreviewStateActions = actions(), extra: { url?: string; worktree?: string } = {}) {
  render(<PreviewStates state={state} actions={a} {...extra} />)
  return a
}

/** The contrast button is the design's primary action; a stage has at most one. */
const primary = () => [...document.querySelectorAll<HTMLElement>('button[data-variant="contrast"]')]

describe('PreviewStates (design 5.1 to 5.18)', () => {
  it('5.1 offers one Download Chromium button and the install command', () => {
    const a = show({ t: 'state', stage: 'chromium-missing', installCommand: 'sudo apt-get install -y chromium', canDownload: true })
    expect(screen.getByRole('heading', { name: 'This host has no browser yet' })).toBeTruthy()
    expect(primary().map(b => b.textContent)).toEqual(['Download Chromium'])
    expect(screen.getByText('sudo apt-get install -y chromium')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Download Chromium' }))
    expect(a.download).toHaveBeenCalledTimes(1)
  })

  it('5.1 on linux-arm64 has no Download button, only the OS command', () => {
    show({ t: 'state', stage: 'chromium-missing', installCommand: 'sudo apt-get install -y chromium', canDownload: false })
    expect(screen.getByRole('heading', { name: 'This host has no browser yet' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /download/i })).toBeNull()
    expect(primary()).toHaveLength(0)
    expect(screen.getByText('sudo apt-get install -y chromium')).toBeTruthy()
  })

  it('5.2 shows progress, the time left and Cancel', () => {
    const a = show({ t: 'state', stage: 'downloading', received: 93_000_000, total: 150_000_000 })
    expect(screen.getByRole('heading', { name: 'Downloading Chromium' })).toBeTruthy()
    expect(screen.getByText('93 of 150 MB · 62%')).toBeTruthy()
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('62')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(a.cancelDownload).toHaveBeenCalledTimes(1)
  })

  it('5.3 keeps Retry download primary and copies diagnostics', () => {
    const a = show({ t: 'state', stage: 'download-failed', error: 'The Chrome for Testing server answered 403 after 3 attempts', installCommand: 'sudo apt-get install -y chromium' })
    expect(screen.getByRole('heading', { name: "Couldn't download Chromium" })).toBeTruthy()
    expect(primary().map(b => b.textContent)).toEqual(['Retry download'])
    fireEvent.click(screen.getByRole('button', { name: 'Retry download' }))
    expect(a.download).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Copy diagnostics' }))
    expect(a.copy).toHaveBeenCalledWith(expect.stringContaining('403'))
  })

  it('5.4 has Retry and the docs link, and no control to run without the sandbox', () => {
    const a = show({ t: 'state', stage: 'sandbox-failed', stderrTail: 'No usable sandbox! Running as root without --no-sandbox is not supported.' })
    expect(screen.getByRole('heading', { name: "Chromium couldn't start its sandbox" })).toBeTruthy()
    expect(screen.getByText(/No usable sandbox!/)).toBeTruthy()
    expect(primary().map(b => b.textContent)).toEqual(['Retry'])
    expect(screen.queryByRole('button', { name: /without (the )?sandbox|no-sandbox/i })).toBeNull()
    const docs = screen.getByRole('link', { name: /CEZ_PREVIEW_NO_SANDBOX=1/ })
    expect(docs.getAttribute('href')).toMatch(/^https:\/\//)
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    expect(a.retryBrowser).toHaveBeenCalledTimes(1)
  })

  it('5.5 says the server is separate and offers one manual Retry', () => {
    show({ t: 'state', stage: 'browser-exited', signal: 'SIGSEGV', stderrTail: 'Received signal 11', serverUp: true })
    expect(screen.getByRole('heading', { name: 'The browser stopped' })).toBeTruthy()
    expect(screen.getByText(/dev server is still up/)).toBeTruthy()
    expect(primary().map(b => b.textContent)).toEqual(['Retry'])
  })

  it('5.6 shows the attempt and stops the server', () => {
    const a = show({ t: 'state', stage: 'server-starting', server, attempt: 3, startedAt: new Date().toISOString(), logTail: [] })
    expect(screen.getByRole('heading', { name: 'Starting web' })).toBeTruthy()
    expect(screen.getByText(/Attempt 3/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Stop server' }))
    expect(a.stop).toHaveBeenCalledWith(5173)
  })

  it('5.6 shows the command output so far, and nothing before it prints', () => {
    show({ t: 'state', stage: 'server-starting', server, attempt: 2, startedAt: new Date().toISOString(), logTail: ['> members-web@0.4.0 dev', '> vite --port 5173', 'VITE v6.2.1  building deps'] })
    expect(screen.getByText(/VITE v6\.2\.1/)).toBeTruthy()
    expect(document.querySelector('[data-slot="preview-log-tail"]')?.textContent).toContain('last 3 lines')
    cleanup()
    show({ t: 'state', stage: 'server-starting', server, attempt: 0, startedAt: new Date().toISOString(), logTail: [] })
    expect(document.querySelector('[data-slot="preview-log-tail"]')).toBeNull()
  })

  it('5.7 uses the spec copy: waiting on another service, not waiting for input', () => {
    const a = show({ t: 'state', stage: 'server-stalled', server, logTail: '> wait-on tcp:5432' })
    expect(screen.getByRole('heading', { name: 'web is running, but :5173 is silent' })).toBeTruthy()
    expect(document.body.textContent).toContain('waiting on another service')
    expect(document.body.textContent).not.toContain('waiting for input')
    expect(screen.getByText('> wait-on tcp:5432')).toBeTruthy()
    expect(primary().map(b => b.textContent)).toEqual(['Keep waiting'])
    fireEvent.click(screen.getByRole('button', { name: 'Keep waiting' }))
    fireEvent.click(screen.getByRole('button', { name: 'Stop server' }))
    expect(a.keepWaiting).toHaveBeenCalledWith(5173)
    expect(a.stop).toHaveBeenCalledWith(5173)
  })

  it('5.8 puts the exit code in the title and says what Start again runs', () => {
    const a = show({ t: 'state', stage: 'server-exited', server, exitCode: 1, logTail: "Error: Cannot find module 'vite'" })
    expect(screen.getByRole('heading', { name: 'web exited with code 1' })).toBeTruthy()
    expect(primary().map(b => b.textContent)).toEqual(['Start again'])
    expect(screen.getByText("Runs npm run dev in this task's worktree, on the host.")).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    expect(a.run).toHaveBeenCalledWith(5173)
  })

  it('5.8 names a signal when no exit code exists', () => {
    show({ t: 'state', stage: 'server-exited', server, exitCode: null, logTail: '' })
    expect(screen.getByRole('heading', { name: 'web was stopped by a signal' })).toBeTruthy()
  })

  it('5.9 reopens the last URL after an idle stop', () => {
    show({ t: 'state', stage: 'server-stopped', server, reason: 'idle', lastUrl: 'http://localhost:5173/members' })
    expect(screen.getByRole('heading', { name: 'Stopped after 15 min idle' })).toBeTruthy()
    expect(document.body.textContent).toContain('Start again reopens localhost:5173/members')
    expect(primary().map(b => b.textContent)).toEqual(['Start again'])
  })

  it('5.9 a user stop lands on Start again as well', () => {
    show({ t: 'state', stage: 'server-stopped', server, reason: 'user', lastUrl: 'http://localhost:5173/' })
    expect(screen.getByRole('heading', { name: 'web stopped' })).toBeTruthy()
    expect(primary().map(b => b.textContent)).toEqual(['Start again'])
  })

  it('5.10 lists the first-open steps for the current step', () => {
    show({ t: 'state', stage: 'loading', step: 'page' }, actions(), { url: 'http://localhost:5173/members' })
    expect(screen.getByText('Browser started')).toBeTruthy()
    expect(screen.getByText('Opening localhost:5173/members')).toBeTruthy()
    expect(screen.getByText('First frame')).toBeTruthy()
    expect(primary()).toHaveLength(0)
  })

  it('5.12 offers Use it here and Close preview', () => {
    const a = show({ stage: 'taken-over', by: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1' })
    expect(screen.getByRole('heading', { name: 'Preview is open somewhere else' })).toBeTruthy()
    expect(document.body.textContent).toContain('Safari on iPhone')
    expect(primary().map(b => b.textContent)).toEqual(['Use it here'])
    fireEvent.click(screen.getByRole('button', { name: 'Use it here' }))
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(a.useHere).toHaveBeenCalledTimes(1)
    expect(a.close).toHaveBeenCalledTimes(1)
  })

  it('5.14 has no retry or reconnect control, only Close preview and the setups link', () => {
    const a = show({ stage: 'proxy-blocked' })
    expect(screen.getByRole('heading', { name: "Preview doesn't work behind this proxy yet" })).toBeTruthy()
    expect(document.body.textContent).toContain("The proxy in front of cezar didn't let the preview's WebSocket through.")
    expect(screen.queryByRole('button', { name: /retry|reconnect|again/i })).toBeNull()
    expect(screen.getByRole('link', { name: 'Which setups work' })).toBeTruthy()
    // The badge lives in the stage here because the toolbar has no room for it in this state.
    expect(screen.getByText('Experimental')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(a.close).toHaveBeenCalledTimes(1)
  })

  it('5.15 explains that the worktree is gone, keeps the disabled card and only closes', () => {
    show({ t: 'state', stage: 'worktree-removed', server }, actions(), { worktree: '/repo/.ai/cezar/worktrees/98d6e190' })
    expect(screen.getByRole('heading', { name: "This task's worktree is gone" })).toBeTruthy()
    expect(document.body.textContent).toContain('.ai/cezar/worktrees/98d6e190')
    expect(document.querySelector('[data-slot="preview-server-card"]')?.getAttribute('data-state')).toBe('unavailable')
    expect(screen.getByRole('button', { name: 'Close preview' })).toBeTruthy()
  })

  it('port held by another task names that task by title and offers only Close preview', () => {
    const a = show({ t: 'state', stage: 'port-held', server, ownerTitle: 'Fix the footer' })
    expect(screen.getByRole('heading', { name: 'web :5173 is in use by another task' })).toBeTruthy()
    expect(document.body.textContent).toContain('Task "Fix the footer" is running its own server on :5173. Register a different port for this task, or stop that task\'s server.')
    expect(primary().map(b => b.textContent)).toEqual(['Close preview'])
    expect(screen.queryByRole('button', { name: /run/i })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(a.close).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['5.16', false, "web isn't running yet", 'The agent registered this server. Nothing runs until you approve it here.', 'registered · not started'],
    ['5.17', true, 'Nothing answers on :5173 anymore', "web was running when the agent registered it, likely inside the agent's own session, which has ended.", 'was running when registered · silent now'],
  ])('%s shows the command, cwd, what runs where and Run and open', (_n, wasRunning, title, body, status) => {
    const a = show({ t: 'state', stage: 'needs-approval', server, wasRunning })
    expect(screen.getByRole('heading', { name: title })).toBeTruthy()
    expect(document.body.textContent).toContain(body)
    expect(screen.getByText(status)).toBeTruthy()
    expect(screen.getByText('npm run dev -- --port 5173 --strictPort --host 127.0.0.1')).toBeTruthy()
    expect(screen.getByText('apps/web')).toBeTruthy()
    expect(screen.getByText("Runs npm run dev in this task's worktree, on the host.")).toBeTruthy()
    expect(primary().map(b => b.textContent)).toEqual(['Run and open'])
    fireEvent.click(screen.getByRole('button', { name: 'Run and open' }))
    expect(a.run).toHaveBeenCalledWith(5173)
  })
})

describe('ConnectionBanner (5.11)', () => {
  it('counts the reconnect attempts and offers Reconnect now', () => {
    const onReconnect = vi.fn()
    render(<ConnectionBanner attempt={2} exhausted={false} onReconnect={onReconnect} />)
    expect(screen.getByText('Lost the connection to the host')).toBeTruthy()
    expect(document.body.textContent).toContain('attempt 2 of 5')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect now' }))
    expect(onReconnect).toHaveBeenCalledTimes(1)
  })

  it('stops at Reconnect after the last attempt', () => {
    render(<ConnectionBanner attempt={5} exhausted onReconnect={() => undefined} />)
    expect(document.body.textContent).not.toContain('attempt')
    expect(screen.getByRole('button', { name: 'Reconnect' })).toBeTruthy()
  })
})

describe('PreviewEmptyState (design 04)', () => {
  it('lists the registered servers and opens one without running anything', () => {
    const onOpen = vi.fn()
    const storybook = { ...server, port: 6006, label: 'storybook' }
    render(<PreviewEmptyState servers={[{ ...server, answeredAtRegistration: true }, storybook]} onOpen={onOpen} />)
    expect(screen.getByText('Open a page in this task\'s browser')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Open' }))
    fireEvent.click(screen.getByRole('button', { name: 'Review' }))
    expect(onOpen).toHaveBeenNthCalledWith(1, 5173)
    expect(onOpen).toHaveBeenNthCalledWith(2, 6006)
    expect(document.body.textContent).toContain("Nothing runs from this list")
  })

  it('shows each server as it is now, not as it was registered', () => {
    const storybook = { ...server, port: 6006, label: 'storybook' }
    const api = { ...server, port: 8787, label: 'api' }
    const states = new Map<number, ThreadPreviewServer>([
      [5173, { kind: 'preview-server', id: 'a', server, state: 'up', stateAt: '2026-10-02T09:54:00.000Z' }],
      [8787, { kind: 'preview-server', id: 'c', server: api, state: 'exited', exitCode: 1 }],
    ])
    render(<PreviewEmptyState servers={[server, storybook, api]} states={states} onOpen={() => undefined} />)
    expect(screen.getByText(/^up · \d+[smhd]$/)).toBeTruthy()
    expect(screen.getByText('exited · code 1')).toBeTruthy()
    expect(screen.getByText('registered · not started')).toBeTruthy()
    expect(screen.getAllByRole('button').map(b => b.textContent)).toEqual(['Open', 'Review', 'Review'])
  })

  it('shows no list when nothing is registered', () => {
    render(<PreviewEmptyState servers={[]} onOpen={() => undefined} />)
    expect(screen.queryByText('Registered in this task')).toBeNull()
  })
})

describe('time-dependent copy', () => {
  it('ticks the starting attempt clock', () => {
    vi.useFakeTimers()
    vi.setSystemTime(Date.parse('2026-10-02T10:00:06.000Z'))
    try {
      show({ t: 'state', stage: 'server-starting', server, attempt: 1, startedAt: '2026-10-02T10:00:00.000Z', logTail: [] })
      expect(screen.getByText('started 6 s ago')).toBeTruthy()
      expect(document.body.textContent).toContain('Attempt 1 · next try in 2 s')
      act(() => { vi.advanceTimersByTime(1000) })
      expect(document.body.textContent).toContain('Attempt 1 · next try in 1 s')
      act(() => { vi.advanceTimersByTime(1000) })
      expect(screen.getByText('started 8 s ago')).toBeTruthy()
    } finally {
      vi.useRealTimers()
    }
  })
})
