import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { makeRunRecord } from '@open-mercato/cezar-api-client/contract/test-factories.testkit'
import type { ApiRun, PreviewServer } from '@open-mercato/cezar-api-client'
import type { ThreadPreviewServer } from '../thread-state'
import { readPanePercent, readPreviewMemory, rememberPreview } from './preview-memory'
import { entryFor, opensDirectly, registrationEntry, serverScript, serverStatus, usePreviewPane, usePreviewPaneState, worktreeRemoved } from './preview-state'

const server: PreviewServer = {
  port: 5173, command: 'npm run dev -- --port 5173', cwd: '.', label: 'web',
  registeredAt: '2026-10-02T10:00:00.000Z', answeredAtRegistration: false,
}

function entry(state: ThreadPreviewServer['state'], extra: Partial<ThreadPreviewServer> = {}): ThreadPreviewServer {
  return { ...registrationEntry(server), state, ...extra }
}

afterEach(() => {
  cleanup()
  localStorage.clear()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('preview server presentation', () => {
  it.each([
    ['registered', 'neutral', true, false, 'registered · not started'],
    ['adopted', 'neutral', false, false, 'was running when registered'],
    ['starting', 'pending', false, true, 'starting'],
    ['stalled', 'pending', false, false, 'stalled · port silent 2 min'],
    ['stopped', 'neutral', true, false, 'stopped'],
    ['unavailable', 'neutral', true, false, 'unavailable'],
  ] as const)('describes %s with its dot and text', (state, tone, ring, pulse, text) => {
    expect(serverStatus(entry(state))).toEqual({ tone, ring, pulse, text })
  })

  it('distinguishes a running registration, exit codes, idle stops and uptime', () => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-02T10:02:00.000Z'))
    expect(serverStatus(entry('registered', { server: { ...server, answeredAtRegistration: true } }))).toEqual({ tone: 'neutral', ring: false, pulse: false, text: 'was running when registered' })
    expect(serverStatus(entry('exited', { stateAt: '' }))).toEqual({ tone: 'danger', ring: false, pulse: false, text: 'exited' })
    expect(serverStatus(entry('exited', { exitCode: 0 })).text).toBe('exited · code 0')
    expect(serverStatus(entry('stopped', { reason: 'idle' })).text).toBe('stopped after 15 min idle')
    expect(serverStatus(entry('up'))).toEqual({ tone: 'success', ring: false, pulse: false, text: 'up · 2m' })
    expect(serverStatus(entry('up', { stateAt: '' })).text).toBe('up')
  })

  it.each(['registered', 'adopted', 'starting', 'up', 'stalled', 'exited', 'stopped', 'unavailable'] as const)('opens %s directly only when it can load', state => {
    expect(opensDirectly(entry(state))).toBe(['adopted', 'starting', 'up'].includes(state))
    expect(opensDirectly(entry(state, { server: { ...server, answeredAtRegistration: true } }))).toBe(['registered', 'adopted', 'starting', 'up'].includes(state))
  })

  it('uses the matching event entry or the complete registration fallback', () => {
    const registered = { kind: 'preview-server', id: 'preview-server:5173', server, state: 'registered', stateAt: server.registeredAt }
    expect(registrationEntry(server)).toEqual(registered)
    expect(entryFor(server, undefined)).toEqual(registered)
    expect(entryFor(server, new Map([[3000, entry('up')]]))).toEqual(registered)
    const up = entry('up')
    expect(entryFor(server, new Map([[5173, up]]))).toBe(up)
    expect(serverScript('  npm run dev -- --port 5173 -- other ')).toBe('npm run dev')
    expect(serverScript('  node app.js  ')).toBe('node app.js')
  })
})

function run(extra: Partial<ApiRun> = {}): ApiRun {
  return makeRunRecord({ worktreePath: '/repo/task', ...extra })
}

it('detects absent and reclaimed worktrees without treating an ordinary run as removed', () => {
  expect(worktreeRemoved(run())).toBe(false)
  expect(worktreeRemoved(run({ worktreePath: undefined }))).toBe(true)
  expect(worktreeRemoved(run({ worktreeReclaimedAt: server.registeredAt }))).toBe(true)
  expect(worktreeRemoved(run({ delegation: { role: 'root', permissions: [], receipts: [] } }))).toBe(false)
})

it.each([false, true])('checks whether a destroyed worker retains its worktree: %s', kept => {
  const remaining = kept ? ['worktree' as const] : []
  const delegation: NonNullable<ApiRun['delegation']> = {
    role: 'worker', parentRunId: 'parent', permissions: [],
    workspace: { ownerRunId: 'worker', resourceId: 'workspace', kind: 'owned-isolated', path: '/repo/worker', branch: 'worker', baselineSha: 'a'.repeat(40) },
    destroy: { requestedAt: server.registeredAt, phase: 'complete', remaining: [...remaining] },
  }
  expect(worktreeRemoved(run({ delegation }))).toBe(!kept)
  const { destroy: _destroy, ...alive } = delegation
  expect(worktreeRemoved(run({ delegation: alive }))).toBe(false)
})

it('has no pane outside its provider', () => {
  expect(renderHook(() => usePreviewPane()).result.current).toBeNull()
})

describe('preview pane actions and restore', () => {
  it('opens, selects, preserves an open target, and clears the target after close', () => {
    const { result } = renderHook(() => usePreviewPaneState('a'))
    expect(result.current).toMatchObject({ open: false, live: false, session: false, target: undefined, request: undefined, percent: 58 })
    act(() => result.current.openPane({ port: 5173, run: true }))
    expect(result.current).toMatchObject({ open: true, port: 5173, request: { port: 5173, run: true }, session: false })
    expect(readPreviewMemory('a')).toEqual({ open: true, target: { port: 5173 } })
    act(() => result.current.setTarget({ url: 'https://example.com' }))
    act(() => result.current.openPane({}))
    expect(result.current.target).toEqual({ url: 'https://example.com' })
    expect(result.current.port).toBeUndefined()
    expect(readPreviewMemory('a')?.target).toEqual({ url: 'https://example.com' })
    act(() => { result.current.setLive(true); result.current.showSession() })
    expect(result.current).toMatchObject({ live: true, session: true })
    act(() => result.current.closePane())
    expect(result.current).toMatchObject({ open: false, live: false, session: false, target: undefined })
    expect(readPreviewMemory('a')?.open).toBe(false)
    act(() => result.current.openPane({}))
    expect(result.current).toMatchObject({ open: true, target: undefined, session: false })
    expect(readPreviewMemory('a')).toEqual({ open: true })
  })

  it('selects the agent, makes each request fresh, and saves target and width changes', () => {
    const { result } = renderHook(() => usePreviewPaneState('a'))
    act(() => result.current.openPane({ agent: true }))
    expect(result.current.target).toEqual({ agent: true })
    const previous = result.current.request
    act(() => result.current.openPane({ agent: true }))
    expect(result.current.request).not.toBe(previous)
    act(() => result.current.setTarget(undefined))
    expect(result.current.target).toBeUndefined()
    expect(readPreviewMemory('a')).toEqual({ open: true })
    act(() => result.current.setPercent(41))
    expect(result.current.percent).toBe(41)
    expect(readPanePercent('a')).toBe(41)
    expect(readPanePercent('b')).toBe(41)
  })

  it('does not save an unscoped pane, but saves its width for new tasks', () => {
    const { result } = renderHook(() => usePreviewPaneState())
    act(() => result.current.openPane({ port: 5173 }))
    act(() => result.current.setPercent(43))
    expect(readPreviewMemory('undefined')).toBeUndefined()
    expect(readPanePercent(undefined)).toBe(43)
    expect(result.current.port).toBe(5173)
  })

  it.each([true, false, undefined])('restores an open pane with dock match %s, without run approval', matches => {
    vi.stubGlobal('matchMedia', matches === undefined ? undefined : vi.fn(() => ({ matches })))
    rememberPreview('a', { open: true, target: { port: 5173 }, percent: 44 })
    const { result } = renderHook(() => usePreviewPaneState('a'))
    expect(result.current).toMatchObject({ open: true, target: { port: 5173 }, port: 5173, request: { port: 5173, restored: true }, session: matches === false, percent: 44 })
    expect(result.current.request).not.toHaveProperty('run')
  })

  it('restores each task independently and resets live state on a scope switch', () => {
    rememberPreview('a', { open: true, target: { agent: true }, percent: 40 })
    rememberPreview('b', { open: false, target: { port: 3000 }, percent: 65 })
    const { result, rerender } = renderHook(({ scope }) => usePreviewPaneState(scope), { initialProps: { scope: 'a' } })
    act(() => { result.current.setLive(true); result.current.showSession() })
    rerender({ scope: 'b' })
    expect(result.current).toMatchObject({ open: false, live: false, session: false, target: undefined, request: undefined, percent: 65 })
    rerender({ scope: 'a' })
    expect(result.current).toMatchObject({ open: true, live: false, target: { agent: true }, request: { agent: true, restored: true }, percent: 40 })
  })

  it('closes a restored pane when the worktree disappears and preserves saved state', () => {
    rememberPreview('a', { open: true, target: { port: 5173 } })
    const { result, rerender } = renderHook(({ gone }) => usePreviewPaneState('a', gone), { initialProps: { gone: false } })
    act(() => result.current.showSession())
    rerender({ gone: true })
    expect(result.current).toMatchObject({ open: false, target: undefined, request: undefined, session: false })
    expect(readPreviewMemory('a')).toEqual({ open: true, target: { port: 5173 } })
    act(() => result.current.openPane({ agent: true }))
    expect(result.current).toMatchObject({ open: true, target: { agent: true } })
    rerender({ gone: false })
    expect(result.current.open).toBe(true)
  })
})
