import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'

import type { PreviewClientMessage, PreviewServer, PreviewServerMessage } from '@open-mercato/cezar-api-client'
import type { PreviewHandlers, PreviewTransport } from '@/api/preview-socket'

const sockets: Array<{ handlers: PreviewHandlers; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []

vi.mock('@/api/preview-socket', async () => ({
  ...(await vi.importActual<typeof import('@/api/preview-socket')>('@/api/preview-socket')),
  connectPreview: vi.fn((_scope: unknown, handlers: PreviewHandlers) => {
    const socket = { handlers, send: vi.fn(), close: vi.fn() }
    sockets.push(socket)
    handlers.onTransport('connecting')
    return socket
  }),
}))

const history = vi.hoisted(() => ({ events: [] as unknown[] }))
vi.mock('@/api/run-history', () => ({ useRunHistory: () => ({ visibleEvents: history.events }) }))

vi.mock('@/lib/project-router', async () => {
  const actual = await vi.importActual<typeof import('@/lib/project-router')>('@/lib/project-router')
  return { ...actual, useActiveProjectId: () => 'default' }
})

import { PreviewPane } from './preview-pane'
import { PreviewErrorBoundary } from './preview-error-boundary'
import { PreviewSplit } from './preview-split'
import { usePreviewPaneState } from './preview-state'

const web: PreviewServer = {
  port: 5173,
  command: 'npm run dev -- --port 5173',
  cwd: 'apps/web',
  label: 'web',
  registeredAt: '2026-10-02T10:00:00.000Z',
  answeredAtRegistration: false,
}

const runRecord = { id: 'r1', worktreePath: '/repo/.ai/cezar/worktrees/r1', previewServers: [web] }
const run = runRecord as never

const last = () => sockets.at(-1)!
const sent = (socket = last()): PreviewClientMessage[] => socket.send.mock.calls.map(call => call[0] as PreviewClientMessage)
const transport = (state: PreviewTransport, attempt?: number) => act(() => last().handlers.onTransport(state, attempt))
const message = (m: PreviewServerMessage) => act(() => last().handlers.onMessage(m))

/** matchMedia that answers min-width / max-width queries against one width. */
function setWidth(width: number) {
  vi.stubGlobal('matchMedia', (query: string) => {
    const min = /min-width:\s*(\d+)px/.exec(query)
    const max = /max-width:\s*(\d+)px/.exec(query)
    const matches = (min ? width >= Number(min[1]) : true) && (max ? width <= Number(max[1]) : true)
    return { matches, media: query, addEventListener() {}, removeEventListener() {} }
  })
}

beforeEach(() => {
  sockets.length = 0
  history.events = []
  setWidth(1440)
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('PreviewPane', () => {
  it('connects on mount, asks to open the requested server once the socket is up, and closes on unmount', () => {
    const { unmount } = render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onClose={() => undefined} />)
    expect(sockets).toHaveLength(1)
    expect(sent()).toEqual([])
    transport('open')
    expect(sent()).toContainEqual({ t: 'open', target: { port: 5173 } })
    expect(sent().some(m => m.t === 'run')).toBe(false)
    unmount()
    expect(last().close).toHaveBeenCalledTimes(1)
  })

  it('re-opens the last target after the socket reconnects', () => {
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onClose={() => undefined} />)
    transport('open')
    transport('reconnecting', 1)
    transport('open')
    expect(sent().filter(m => m.t === 'open')).toHaveLength(2)
  })

  it('never sends run for a plain open; Run and open sends it once', () => {
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onClose={() => undefined} />)
    transport('open')
    message({ t: 'state', stage: 'needs-approval', server: web, wasRunning: false })
    expect(sent().some(m => m.t === 'run')).toBe(false)
    fireEvent.click(screen.getByRole('button', { name: 'Run and open' }))
    expect(sent().filter(m => m.t === 'run')).toEqual([{ t: 'run', port: 5173 }])
  })

  it('Run and open shows the server URL in an unfocused address field (#781 final review)', () => {
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173, run: true }} onClose={() => undefined} />)
    transport('open')
    const field = screen.getByRole('textbox', { name: 'Page address' }) as HTMLInputElement
    expect(document.activeElement).not.toBe(field)
    expect(field.value).toBe('localhost:5173')
  })

  it('a card that already asked to run sends run when the server asks for approval', () => {
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173, run: true }} onClose={() => undefined} />)
    transport('open')
    expect(sent().some(m => m.t === 'run')).toBe(false)
    message({ t: 'state', stage: 'needs-approval', server: web, wasRunning: false })
    message({ t: 'state', stage: 'needs-approval', server: web, wasRunning: false })
    expect(sent().filter(m => m.t === 'run')).toEqual([{ t: 'run', port: 5173 }])
  })

  it('shows 5.14 after the upgrade never succeeds, with no reconnect', () => {
    render(<PreviewPane run={run} servers={[web]} onClose={() => undefined} />)
    transport('blocked')
    expect(screen.getByRole('heading', { name: "Preview doesn't work behind this proxy yet" })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /reconnect|retry/i })).toBeNull()
  })

  it('shows 5.11 over the last state after a drop and reconnects on demand', () => {
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onClose={() => undefined} />)
    transport('open')
    transport('reconnecting', 2)
    expect(screen.getByText('Lost the connection to the host')).toBeTruthy()
    transport('closed')
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }))
    expect(sockets).toHaveLength(2)
  })

  it('stops reconnecting and shows 5.12 when another tab took the preview', () => {
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onClose={() => undefined} />)
    transport('open')
    message({ t: 'replaced', by: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36' })
    expect(screen.getByRole('heading', { name: 'Preview is open somewhere else' })).toBeTruthy()
    // The server closes the old socket; leaving the connection alive would steal the preview back in a loop.
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1)
    fireEvent.click(screen.getByRole('button', { name: 'Use it here' }))
    expect(sockets).toHaveLength(2)
    transport('open')
    expect(sent()).toContainEqual({ t: 'open', target: { port: 5173 } })
  })

  it('answers a page dialog with dialogResult', () => {
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onClose={() => undefined} />)
    transport('open')
    message({ t: 'dialog', type: 'confirm', message: 'Suspend?', origin: 'localhost:5173' })
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(sent()).toContainEqual({ t: 'dialogResult', accept: true })
  })

  it('takes input only while the page is live: not behind a state, not while a dialog freezes it', () => {
    // jsdom lays nothing out: give the stage a box so the surface, and the layer in it, exist.
    Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 1000 })
    Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get: () => 700 })
    onTestFinished(() => {
      delete (HTMLElement.prototype as { clientWidth?: number }).clientWidth
      delete (HTMLElement.prototype as { clientHeight?: number }).clientHeight
    })
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onClose={() => undefined} />)
    transport('open')
    expect(screen.queryByRole('application')).toBeNull()
    message({ t: 'state', stage: 'streaming', adopted: false })
    const layer = screen.getByRole('application')
    fireEvent.keyDown(layer, { key: 'a', code: 'KeyA', keyCode: 65 })
    expect(sent()).toContainEqual(expect.objectContaining({ t: 'key', type: 'keyDown', text: 'a' }))
    // Shift+Esc hands the keyboard back: the address field, not the page, has it next.
    layer.focus()
    fireEvent.keyDown(layer, { key: 'Escape', code: 'Escape', keyCode: 27, shiftKey: true })
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: 'Page address' }))

    message({ t: 'dialog', type: 'alert', message: 'Saved', origin: 'localhost:5173' })
    expect(screen.queryByRole('application')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'OK' }))
    expect(screen.getByRole('application')).toBeTruthy()

    transport('reconnecting', 1)
    expect(screen.queryByRole('application')).toBeNull()
  })

  it('acks a frame once it is drawn so the server sends the next one', async () => {
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onClose={() => undefined} />)
    transport('open')
    message({ t: 'state', stage: 'streaming', adopted: false })
    await act(async () => last().handlers.onFrame(new Blob(['x'], { type: 'image/jpeg' })))
    expect(sent().filter(m => m.t === 'ack')).toHaveLength(1)
  })

  it('opens on the empty state when nothing was requested and navigates a typed port', () => {
    render(<PreviewPane run={run} servers={[web]} onClose={() => undefined} />)
    transport('open')
    expect(screen.getByText("Open a page in this task's browser")).toBeTruthy()
    expect(sent().some(m => m.t === 'open')).toBe(false)
    const field = screen.getByRole('textbox', { name: 'Page address' })
    fireEvent.change(field, { target: { value: '3000' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(sent()).toContainEqual({ t: 'open', target: { url: 'http://localhost:3000' } })
  })

  it('a URL typed while streaming becomes the target a reconnect reopens, and no server stays current', () => {
    const onPort = vi.fn()
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onPort={onPort} onClose={() => undefined} />)
    transport('open')
    message({ t: 'state', stage: 'streaming', adopted: false })
    const field = screen.getByRole('textbox', { name: 'Page address' })
    fireEvent.change(field, { target: { value: 'example.com/docs' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(sent()).toContainEqual({ t: 'nav', url: 'http://example.com/docs' })
    expect(onPort).toHaveBeenLastCalledWith(undefined)
    transport('reconnecting', 1)
    transport('open')
    expect(sent().filter(m => m.t === 'open').at(-1)).toEqual({ t: 'open', target: { url: 'http://example.com/docs' } })
  })

  it('a typed registered port opens that server instead of a bare URL', () => {
    render(<PreviewPane run={run} servers={[web]} onClose={() => undefined} />)
    transport('open')
    const field = screen.getByRole('textbox', { name: 'Page address' })
    fireEvent.change(field, { target: { value: '5173' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(sent()).toContainEqual({ t: 'open', target: { port: 5173 } })
  })

  it('refuses addresses the browser must not open, without asking the server', () => {
    render(<PreviewPane run={run} servers={[web]} onClose={() => undefined} />)
    transport('open')
    const field = screen.getByRole('textbox', { name: 'Page address' })
    fireEvent.change(field, { target: { value: 'javascript:void(0)' } })
    fireEvent.keyDown(field, { key: 'Enter' })
    expect(sent().some(m => m.t === 'open')).toBe(false)
    expect(screen.getByRole('alert').textContent).toContain('http')
  })

  it('reports the shown server and liveness to its owner', () => {
    const onPort = vi.fn()
    const onLive = vi.fn()
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onPort={onPort} onLive={onLive} onClose={() => undefined} />)
    transport('open')
    expect(onPort).toHaveBeenCalledWith(5173)
    message({ t: 'state', stage: 'streaming', adopted: true })
    expect(onLive).toHaveBeenLastCalledWith(true)
    transport('reconnecting', 1)
    expect(onLive).toHaveBeenLastCalledWith(false)
  })

  it('a takeover ends the stream: no live dot, no navigation, status paused', () => {
    const onLive = vi.fn()
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onLive={onLive} onClose={() => undefined} />)
    transport('open')
    message({ t: 'state', stage: 'streaming', adopted: false })
    expect(onLive).toHaveBeenLastCalledWith(true)
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(false)
    message({ t: 'replaced', by: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0 Safari/537.36' })
    expect(onLive).toHaveBeenLastCalledWith(false)
    expect((screen.getByRole('button', { name: 'Back' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.getByText('paused')).toBeTruthy()
    expect(screen.queryByText('idle')).toBeNull()
    expect(screen.queryByText('Lost the connection to the host')).toBeNull()
  })

  it('a takeover stops the heartbeat and sends nothing more', () => {
    vi.useFakeTimers()
    try {
      render(<PreviewPane run={run} servers={[web]} request={{ port: 5173 }} onClose={() => undefined} />)
      transport('open')
      act(() => { vi.advanceTimersByTime(2100) })
      expect(sent().filter(m => m.t === 'ping')).toHaveLength(1)
      message({ t: 'replaced', by: '' })
      const before = sent(sockets[0]).length
      act(() => { vi.advanceTimersByTime(10_000) })
      expect(sent(sockets[0])).toHaveLength(before)
    } finally {
      vi.useRealTimers()
    }
  })

  it('a card approval is spent on the first answer: a later crash never restarts the server by itself', () => {
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173, run: true }} onClose={() => undefined} />)
    transport('open')
    // The card was stale: the server was already up, so the approval had nothing to approve.
    message({ t: 'state', stage: 'streaming', adopted: false })
    message({ t: 'state', stage: 'server-exited', server: web, exitCode: 1, logTail: 'boom' })
    expect(sent().some(m => m.t === 'run')).toBe(false)
    // The owner's own click still runs it.
    fireEvent.click(screen.getByRole('button', { name: 'Start again' }))
    expect(sent().filter(m => m.t === 'run')).toEqual([{ t: 'run', port: 5173 }])
  })

  it('a card approval survives an unrelated browser state before the server answers', () => {
    render(<PreviewPane run={run} servers={[web]} request={{ port: 5173, run: true }} onClose={() => undefined} />)
    transport('open')
    message({ t: 'state', stage: 'downloading', received: 1, total: 2 })
    message({ t: 'state', stage: 'needs-approval', server: web, wasRunning: false })
    expect(sent().filter(m => m.t === 'run')).toEqual([{ t: 'run', port: 5173 }])
  })

  it('5.14 draws the Experimental badge once, in the stage, and not in the toolbar', () => {
    render(<PreviewPane run={run} servers={[web]} onClose={() => undefined} />)
    expect(document.querySelectorAll('[data-slot="preview-experimental"]')).toHaveLength(1)
    transport('blocked')
    expect(document.querySelectorAll('[data-slot="preview-experimental"]')).toHaveLength(1)
    expect(document.querySelector('[data-slot="preview-state"] [data-slot="preview-experimental"]')).not.toBeNull()
  })

  it('shows the live servers in the empty state and the switcher', () => {
    const storybook = { ...web, port: 6006, label: 'storybook' }
    const states = new Map([[5173, { kind: 'preview-server' as const, id: 'a', server: web, state: 'exited' as const, exitCode: 1 }]])
    render(<PreviewPane run={run} servers={[web, storybook]} serverStates={states} onClose={() => undefined} />)
    expect(screen.getByText('exited · code 1')).toBeTruthy()
  })

  it('an error inside the pane stays inside the pane', () => {
    const boom = vi.spyOn(console, 'error').mockImplementation(() => undefined)
    const onClose = vi.fn()
    const Bad = (): never => { throw new Error('boom') }
    render(<PreviewErrorBoundary onClose={onClose}><Bad /></PreviewErrorBoundary>)
    expect(screen.getByText('The preview hit an error')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }))
    expect(onClose).toHaveBeenCalledTimes(1)
    boom.mockRestore()
  })
})

function Harness({ open, session = false, port = 5173, servers }: { open: boolean; session?: boolean; port?: number | null; servers?: PreviewServer[] }) {
  const state = usePreviewPaneState()
  useEffect(() => {
    if (open) state.openPane(port === null ? {} : { port })
    if (session) state.showSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <PreviewSplit run={servers ? ({ ...runRecord, previewServers: servers } as never) : run} state={state}>
      <div data-route="task-thread">
        <header data-slot="run-header">header</header>
        <div data-testid="transcript">transcript</div>
      </div>
    </PreviewSplit>
  )
}

describe('PreviewSplit', () => {
  it('docks the pane beside the transcript on wide screens', async () => {
    render(<Harness open />)
    await screen.findByRole('separator', { name: 'Resize preview' })
    expect(screen.getByTestId('transcript').closest('[data-slot="task-main"]')?.hasAttribute('hidden')).toBe(false)
    expect(document.querySelector('[data-slot="preview-pane"]')).not.toBeNull()
    expect(screen.getByRole('separator', { name: 'Resize preview' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Session' })).toBeNull()
  })

  it('renders only the transcript while the pane is closed', () => {
    render(<Harness open={false} />)
    expect(document.querySelector('[data-slot="preview-pane"]')).toBeNull()
    expect(sockets).toHaveLength(0)
    expect(screen.getByTestId('transcript').closest('[data-slot="task-main"]')?.hasAttribute('hidden')).toBe(false)
  })

  it('at 1179 px the pane takes the main area under the task header, and Session returns to the transcript', async () => {
    setWidth(1179)
    render(<Harness open />)
    await screen.findByRole('button', { name: 'Session' })
    const main = screen.getByTestId('transcript').closest('[data-slot="task-main"]')!
    // Design 02: the title, tabs and Preview toggle stay above the pane; only the body steps aside.
    expect(main.hasAttribute('hidden')).toBe(false)
    expect(main.hasAttribute('data-collapsed')).toBe(true)
    expect(main.contains(screen.getByText('header'))).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Session' }))
    expect(main.hasAttribute('data-collapsed')).toBe(false)
    // The pane stays mounted, so the stream and the browser survive the glance at the conversation.
    expect(document.querySelector('[data-slot="preview-pane"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="preview-pane"]')?.hasAttribute('hidden')).toBe(true)
    expect(sockets[0]!.close).not.toHaveBeenCalled()
  })

  it('on a phone the pane is the whole screen and the task view steps aside', async () => {
    setWidth(390)
    render(<Harness open />)
    await screen.findByRole('button', { name: 'Session' })
    expect(screen.getByTestId('transcript').closest('[data-slot="task-main"]')?.hasAttribute('hidden')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Session' }))
    expect(screen.getByTestId('transcript').closest('[data-slot="task-main"]')?.hasAttribute('hidden')).toBe(false)
  })

  it('the collapsed task view keeps only its header (stylesheet rule)', () => {
    const previewCss = readFileSync(join(import.meta.dirname, 'preview.css'), 'utf8')
    expect(previewCss).toContain("[data-slot='task-main'][data-collapsed] [data-route] > :not([data-slot='run-header'])")
  })

  it('feeds the live server states from the task history to the pane', async () => {
    const storybook = { ...web, port: 6006, label: 'storybook' }
    history.events = [
      { seq: 1, ts: '2026-10-02T09:00:00.000Z', type: 'preview.server-registered', server: web },
      { seq: 2, ts: '2026-10-02T09:00:01.000Z', type: 'preview.server-registered', server: storybook },
      { seq: 3, ts: '2026-10-02T09:01:00.000Z', type: 'preview.server-state', port: 5173, state: 'exited', exitCode: 1 },
    ]
    render(<Harness open port={null} servers={[web, storybook]} />)
    expect(await screen.findByText('exited · code 1')).toBeTruthy()
    expect(screen.getByText('registered · not started')).toBeTruthy()
  })

  it('at 1180 px the transcript and the pane share the row', async () => {
    setWidth(1180)
    render(<Harness open />)
    await screen.findByRole('separator', { name: 'Resize preview' })
    expect(screen.getByTestId('transcript').closest('[data-slot="task-main"]')?.hasAttribute('hidden')).toBe(false)
  })

  it('closing the pane closes the socket', async () => {
    render(<Harness open />)
    fireEvent.click(await screen.findByRole('button', { name: 'Close preview' }))
    expect(sockets[0]!.close).toHaveBeenCalledTimes(1)
    expect(document.querySelector('[data-slot="preview-pane"]')).toBeNull()
  })

  it('resizes with the keyboard and keeps the pane within bounds', async () => {
    render(<Harness open />)
    const divider = await screen.findByRole('separator', { name: 'Resize preview' })
    const before = Number(divider.getAttribute('aria-valuenow'))
    fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(Number(divider.getAttribute('aria-valuenow'))).toBeGreaterThan(before)
    for (let i = 0; i < 100; i++) fireEvent.keyDown(divider, { key: 'ArrowLeft' })
    expect(Number(divider.getAttribute('aria-valuenow'))).toBeLessThanOrEqual(Number(divider.getAttribute('aria-valuemax')))
  })
})
