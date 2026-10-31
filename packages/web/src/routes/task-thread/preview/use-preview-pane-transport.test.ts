import { useLayoutEffect } from 'react'
import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PreviewHandlers, PreviewTransport } from '@/api/preview-socket'
import type { PreviewServer, PreviewServerMessage } from '@open-mercato/cezar-api-client'
import type { PreviewPaneProps } from './preview-pane'
import { copyText, usePreviewPaneTransport } from './use-preview-pane-transport'

const env = vi.hoisted(() => ({ active: true, compact: false, project: undefined as string | undefined }))
const sockets: Array<{ handlers: PreviewHandlers; send: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }> = []
vi.mock('@/api/preview-socket', () => ({ connectPreview: vi.fn((_scope: unknown, handlers: PreviewHandlers) => {
  const socket = { handlers, send: vi.fn(), close: vi.fn() }
  sockets.push(socket)
  return socket
}) }))
vi.mock('@/api/live-visibility', () => ({ usePageActive: () => env.active, pageIsActive: () => env.active }))
vi.mock('@/lib/project-router', () => ({ useActiveProjectId: () => env.project }))
vi.mock('./use-media-query', () => ({ PREVIEW_PHONE_QUERY: 'phone', useMediaQuery: () => env.compact }))
vi.mock('@/components/ui/toaster', () => ({ toast: vi.fn() }))
import { connectPreview } from '@/api/preview-socket'
import { toast } from '@/components/ui/toaster'

const server: PreviewServer = { port: 5173, command: 'npm run dev', cwd: '.', label: 'web', registeredAt: '2026-10-01T00:00:00Z', answeredAtRegistration: false }
const last = () => sockets.at(-1)!
const transport = (state: PreviewTransport, attempt?: number) => act(() => last().handlers.onTransport(state, attempt))
const message = (value: PreviewServerMessage) => act(() => last().handlers.onMessage(value))
function mount(extra: Partial<PreviewPaneProps> = {}) {
  const props: PreviewPaneProps = { run: { id: 'run' } as PreviewPaneProps['run'], servers: [server], onClose: vi.fn(), ...extra }
  return renderHook((value: PreviewPaneProps) => usePreviewPaneTransport(value), { initialProps: props })
}
const stream = () => message({ t: 'state', stage: 'streaming', adopted: false })
beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(10_000)
  sockets.length = 0
  env.active = true
  env.compact = false
  env.project = undefined
  localStorage.clear()
  vi.clearAllMocks()
})
afterEach(() => { cleanup(); vi.useRealTimers(); vi.unstubAllGlobals() })

it('opens and resumes the same viewer with the latest quality and closes old connections', () => {
  const hook = mount({ request: { port: 5173 } })
  expect(connectPreview).toHaveBeenLastCalledWith({ projectId: 'default', runId: 'run' }, expect.anything())
  expect(last().send).not.toHaveBeenCalled()
  transport('open')
  const viewerId = last().send.mock.calls[0]![0].viewerId
  expect(viewerId).toEqual(expect.any(String))
  expect(last().send).toHaveBeenLastCalledWith({ t: 'open', target: { port: 5173 }, viewerId, resume: false, quality: 'normal' })
  act(() => hook.result.current.chooseQuality('high'))
  expect(hook.result.current.quality).toBe('high')
  expect(last().send).toHaveBeenLastCalledWith({ t: 'quality', quality: 'high' })
  transport('reconnecting', 3)
  expect(hook.result.current.transport).toEqual({ state: 'reconnecting', attempt: 3 })
  transport('open')
  expect(last().send).toHaveBeenLastCalledWith({ t: 'open', target: { port: 5173 }, viewerId, resume: true, quality: 'high' })
  const old = last()
  act(() => hook.result.current.reconnect())
  expect(old.close).toHaveBeenCalledOnce()
  expect(hook.result.current.transport).toEqual({ state: 'connecting', attempt: 0 })
  transport('open')
  expect(last().send).toHaveBeenLastCalledWith({ t: 'open', target: { port: 5173 }, viewerId, resume: false, quality: 'high' })
  hook.unmount()
  expect(last().close).toHaveBeenCalledOnce()
})

it('reports messages, download progress and takeover without sending more input', () => {
  const hook = mount()
  transport('open')
  message({ t: 'url', url: 'https://example.com/' })
  message({ t: 'cursor', cursor: 'pointer' })
  const dialog = { t: 'dialog', type: 'prompt', message: 'Name?', defaultPrompt: 'value', origin: 'https://example.com' } as const
  message(dialog)
  expect(hook.result.current).toMatchObject({ url: 'https://example.com/', cursor: 'pointer', dialog, everOpened: true })
  message({ t: 'downloadProgress', received: 4, total: 9 })
  expect(hook.result.current.stage).toBeUndefined()
  message({ t: 'state', stage: 'downloading', received: 1, total: 2 })
  message({ t: 'downloadProgress', received: 4, total: 9 })
  expect(hook.result.current.stage).toEqual({ t: 'state', stage: 'downloading', received: 4, total: 9 })
  message({ t: 'replaced', by: 'another tab' })
  expect(hook.result.current).toMatchObject({ takenOver: 'another tab', connected: false, empty: false })
  expect(last().close).toHaveBeenCalledOnce()
  last().send.mockClear()
  act(() => { hook.result.current.send({ t: 'download' }); vi.advanceTimersByTime(4000) })
  expect(last().send).not.toHaveBeenCalled()
  act(() => hook.result.current.actions.useHere())
  expect(hook.result.current.takenOver).toBeUndefined()
  expect(sockets).toHaveLength(2)
})

it('sends controls only through an open socket and keeps close as the owner callback', () => {
  const onClose = vi.fn()
  const hook = mount({ onClose })
  act(() => hook.result.current.actions.download())
  expect(last().send).not.toHaveBeenCalled()
  transport('open')
  act(() => {
    const actions = hook.result.current.actions
    actions.download(); actions.cancelDownload(); actions.retryBrowser()
    actions.run(1); actions.stop(2); actions.keepWaiting(3); actions.close()
  })
  expect(last().send.mock.calls.map(call => call[0])).toEqual([
    { t: 'download' }, { t: 'cancelDownload' }, { t: 'retryBrowser' },
    { t: 'run', port: 1 }, { t: 'stop', port: 2 }, { t: 'keepWaiting', port: 3 },
  ])
  expect(onClose).toHaveBeenCalledOnce()
})

it('draws before acknowledging, ignores hidden frames and tracks the rolling frame window', async () => {
  const onLive = vi.fn()
  const hook = mount({ onLive })
  transport('open'); stream()
  let finish!: () => void
  const draw = vi.fn(() => new Promise<void>(resolve => { finish = resolve }))
  hook.result.current.stageHandle.current = { draw }
  const frame = new Blob(['x'.repeat(1536)])
  act(() => last().handlers.onFrame(frame))
  expect(draw).toHaveBeenCalledWith(frame)
  expect(hook.result.current.hasFrame).toBe(true)
  expect(last().send).not.toHaveBeenCalledWith({ t: 'ack' })
  await act(async () => { finish(); await Promise.resolve() })
  expect(last().send).toHaveBeenLastCalledWith({ t: 'ack' })
  message({ t: 'pong', ts: 9980 })
  act(() => vi.advanceTimersByTime(500))
  expect(hook.result.current.stats).toEqual({ fps: 1, kbps: 2, rttMs: 20, lastFrameAt: 10000 })
  act(() => vi.advanceTimersByTime(500))
  expect(hook.result.current.stats?.fps).toBe(1)
  act(() => vi.advanceTimersByTime(500))
  expect(hook.result.current.stats).toEqual({ fps: 0, kbps: 0, rttMs: 20, lastFrameAt: 10000 })
  env.active = false
  act(() => last().handlers.onFrame(frame))
  expect(draw).toHaveBeenCalledOnce()
  hook.rerender({ run: { id: 'run' } as PreviewPaneProps['run'], servers: [], onClose: vi.fn(), onLive })
  expect(hook.result.current.stats).toBeUndefined()
  expect(onLive).toHaveBeenLastCalledWith(false)
})

it('acks without a stage handle and reports zero stats and nonnegative round trips', async () => {
  const hook = mount()
  transport('open'); stream()
  act(() => vi.advanceTimersByTime(500))
  expect(hook.result.current.stats).toEqual({ fps: 0, kbps: 0 })
  message({ t: 'pong', ts: 99999 })
  await act(async () => { last().handlers.onFrame(new Blob(['a'])); await Promise.resolve() })
  expect(last().send).toHaveBeenCalledWith({ t: 'ack' })
  act(() => vi.advanceTimersByTime(1500))
  expect(hook.result.current.stats?.rttMs).toBe(0)
  expect(last().send).toHaveBeenCalledWith({ t: 'ping', ts: 12000 })
  transport('closed')
  last().send.mockClear()
  act(() => vi.advanceTimersByTime(4000))
  expect(last().send).not.toHaveBeenCalled()
})

it('resizes only live stages and repeats the size for a new page', () => {
  const hook = mount()
  act(() => hook.result.current.setStageSize({ w: 600, h: 400 }))
  transport('open')
  expect(last().send).not.toHaveBeenCalledWith(expect.objectContaining({ t: 'resize' }))
  stream()
  expect(last().send).toHaveBeenLastCalledWith({ t: 'resize', w: 600, h: 400 })
  last().send.mockClear()
  stream()
  expect(last().send).toHaveBeenLastCalledWith({ t: 'resize', w: 600, h: 400 })
  act(() => hook.result.current.setViewport({ w: 1200, h: 800 }))
  expect(last().send).toHaveBeenLastCalledWith({ t: 'resize', w: 1200, h: 800 })
  env.compact = true
  hook.rerender({ run: { id: 'run' } as PreviewPaneProps['run'], servers: [server], onClose: vi.fn() })
  expect(last().send).toHaveBeenLastCalledWith({ t: 'resize', w: 600, h: 400 })
  message({ t: 'state', stage: 'loading', step: 'page' })
  expect(hook.result.current.streaming).toBe(false)
})

it('navigates a live page in place, replaces an agent page and remembers targets', () => {
  const onTarget = vi.fn()
  const hook = mount({ onTarget })
  expect(onTarget).not.toHaveBeenCalled()
  transport('open')
  act(() => hook.result.current.openServer(5173))
  expect(hook.result.current).toMatchObject({ port: 5173, url: 'http://localhost:5173', agent: false, empty: false })
  stream()
  act(() => hook.result.current.navigate('https://example.com/path'))
  expect(last().send).toHaveBeenLastCalledWith({ t: 'nav', url: 'https://example.com/path' })
  expect(hook.result.current.port).toBeUndefined()
  expect(onTarget).toHaveBeenLastCalledWith({ url: 'https://example.com/path' })
  act(() => hook.result.current.openAgent())
  expect(hook.result.current).toMatchObject({ agent: true, url: '', stage: undefined })
  expect(onTarget).toHaveBeenLastCalledWith({ agent: true })
  stream()
  act(() => hook.result.current.navigate('https://other.com'))
  expect(last().send).toHaveBeenLastCalledWith(expect.objectContaining({ t: 'open', target: { url: 'https://other.com' } }))
  expect(hook.result.current.agent).toBe(false)
  act(() => hook.result.current.navigate('javascript:void 0'))
  expect(hook.result.current.addressError).toEqual(expect.any(String))
  act(() => hook.result.current.navigate('5173'))
  expect(hook.result.current.addressError).toBeUndefined()
  expect(hook.result.current.port).toBe(5173)
})

it.each([undefined, '/', '/app'])('shows server paths accurately (%s)', path => {
  const hook = mount({ servers: [{ ...server, path }] })
  act(() => hook.result.current.openServer(5173))
  expect(hook.result.current.url).toBe(`http://localhost:5173${path === '/app' ? '/app' : ''}`)
  act(() => hook.result.current.openServer(9999))
  expect(hook.result.current.url).toBe('http://localhost:9999')
})

it('copies text and reports success, failure and absent clipboard', async () => {
  const writeText = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('navigator', { clipboard: { writeText } })
  copyText('hello')
  await Promise.resolve()
  expect(writeText).toHaveBeenCalledWith('hello')
  expect(toast).toHaveBeenLastCalledWith('Copied')
  writeText.mockRejectedValueOnce(new Error('denied'))
  copyText('again')
  await Promise.resolve()
  expect(toast).toHaveBeenLastCalledWith("Couldn't copy to the clipboard", { tone: 'danger' })
  vi.stubGlobal('navigator', {})
  expect(() => copyText('none')).not.toThrow()
})

it.each(['needs-approval', 'port-held', 'server-starting', 'server-stalled', 'server-exited', 'server-stopped', 'loading', 'streaming', 'agent-idle'] as const)(
  'spends approval only on a matching server answer (%s)', stage => {
    const hook = mount({ request: { port: 5173, run: true } })
    transport('open')
    const state = (port: number) => ({ t: 'state', stage, server: { ...server, port }, wasRunning: false, ownerTitle: 'other', logTail: '', step: 'page', adopted: false, exitCode: 1 }) as PreviewServerMessage
    message(state(9999))
    expect(last().send).not.toHaveBeenCalledWith({ t: 'run', port: 5173 })
    message(state(5173))
    const shouldRun = ['needs-approval', 'server-exited', 'server-stopped'].includes(stage)
    expect(last().send.mock.calls.filter(call => call[0].t === 'run')).toHaveLength(shouldRun ? 1 : 0)
    if (stage !== 'agent-idle') {
      message({ t: 'state', stage: 'needs-approval', server, wasRunning: false })
      expect(last().send.mock.calls.filter(call => call[0].t === 'run')).toHaveLength(shouldRun ? 1 : 0)
    }
    expect(hook.result.current.hasFrame).toBe(false)
  },
)

it('reapplies requests while preserving an already streaming target unless approval is repeated', () => {
  const props: PreviewPaneProps = { run: { id: 'run' } as PreviewPaneProps['run'], servers: [server], onClose: vi.fn(), request: { port: 5173 } }
  const hook = mount(props)
  transport('open'); stream()
  last().send.mockClear()
  hook.rerender({ ...props, request: { port: 5173 } })
  expect(last().send).not.toHaveBeenCalled()
  hook.rerender({ ...props, request: { port: 5173, run: true } })
  expect(last().send).toHaveBeenCalledWith(expect.objectContaining({ t: 'open', target: { port: 5173 } }))
  hook.rerender({ ...props, request: { agent: true } })
  stream()
  last().send.mockClear()
  hook.rerender({ ...props, request: { agent: true } })
  expect(last().send).not.toHaveBeenCalled()
  hook.rerender({ ...props, request: { url: 'https://example.com' } })
  expect(hook.result.current.url).toBe('https://example.com')
  hook.rerender({ ...props, request: { url: '5173' } })
  expect(hook.result.current.port).toBe(5173)
  last().send.mockClear()
  hook.rerender({ ...props, request: { url: 'javascript:void 0' } })
  expect(last().send).not.toHaveBeenCalled()
})

it.each([
  { port: 9999, restored: true as const },
  {},
])('leaves a missing restored target empty (%j)', request => {
  const hook = mount({ request })
  transport('open')
  expect(hook.result.current.empty).toBe(true)
  expect(last().send).not.toHaveBeenCalled()
  transport('blocked')
  expect(hook.result.current.empty).toBe(false)
})

it('opens a restored registered server and uses the active project', () => {
  env.project = 'project'
  const hook = mount({ request: { port: 5173, restored: true } })
  expect(connectPreview).toHaveBeenLastCalledWith({ projectId: 'project', runId: 'run' }, expect.anything())
  expect(hook.result.current.port).toBe(5173)
})

it('clears a pending approval when navigating and reopens the new URL on reconnect', () => {
  const hook = mount({ request: { port: 5173, run: true } })
  transport('open'); stream()
  act(() => hook.result.current.navigate('https://example.com'))
  message({ t: 'state', stage: 'needs-approval', server, wasRunning: false })
  expect(last().send).not.toHaveBeenCalledWith({ t: 'run', port: 5173 })
  transport('reconnecting')
  transport('open')
  expect(last().send).toHaveBeenLastCalledWith(expect.objectContaining({ t: 'open', target: { url: 'https://example.com' }, resume: true }))
})

it('clears old frame state on an explicit reconnect so the next frame becomes visible', async () => {
  const hook = mount()
  transport('open')
  await act(async () => { last().handlers.onFrame(new Blob(['a'])); await Promise.resolve() })
  act(() => hook.result.current.reconnect())
  transport('open')
  await act(async () => { last().handlers.onFrame(new Blob(['b'])); await Promise.resolve() })
  expect(hook.result.current.hasFrame).toBe(true)
  expect(last().send).toHaveBeenCalledWith({ t: 'ack' })
})

it.each([
  [undefined, true],
  [{ port: 9999, restored: true }, true],
  [{ port: 5173, restored: true }, false],
  [{ port: 9999 }, false],
  [{ agent: true }, false],
  [{ url: 'https://example.com' }, false],
] as const)('focuses an empty address only when no target is pending (%j)', (request, focused) => {
  const input = document.createElement('input')
  const focus = vi.spyOn(input, 'focus')
  const hook = renderHook(() => {
    const value = usePreviewPaneTransport({ run: { id: 'run' } as PreviewPaneProps['run'], servers: [server], request, onClose: vi.fn() })
    useLayoutEffect(() => { value.urlInput.current = input }, [value.urlInput])
    return value
  })
  expect(focus).toHaveBeenCalledTimes(focused ? 1 : 0)
  hook.unmount()
})
