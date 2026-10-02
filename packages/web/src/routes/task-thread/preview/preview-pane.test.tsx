import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useEffect } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const run = { id: 'r1', worktreePath: '/repo/.ai/cezar/worktrees/r1', previewServers: [web] } as never

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

function Harness({ open, session = false }: { open: boolean; session?: boolean }) {
  const state = usePreviewPaneState()
  useEffect(() => {
    if (open) state.openPane({ port: 5173 })
    if (session) state.showSession()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return (
    <PreviewSplit run={run} state={state}>
      <div data-testid="transcript">transcript</div>
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

  it('at 1179 px the pane takes the main area and Session returns to the transcript', async () => {
    setWidth(1179)
    render(<Harness open />)
    await screen.findByRole('button', { name: 'Session' })
    const main = screen.getByTestId('transcript').closest('[data-slot="task-main"]')!
    expect(main.hasAttribute('hidden')).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Session' }))
    expect(main.hasAttribute('hidden')).toBe(false)
    // The pane stays mounted, so the stream and the browser survive the glance at the conversation.
    expect(document.querySelector('[data-slot="preview-pane"]')).not.toBeNull()
    expect(document.querySelector('[data-slot="preview-pane"]')?.hasAttribute('hidden')).toBe(true)
    expect(sockets[0]!.close).not.toHaveBeenCalled()
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
