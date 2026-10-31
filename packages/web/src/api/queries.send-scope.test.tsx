import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import type { ReactNode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setApiScope } from '@open-mercato/cezar-api-client/utils/project-scope'
import { configureLiveSession, resetLiveSession } from './live-coordinator'
import { createQueryClient } from './query-client'
import { useContinueRun, useSendMessage } from './queries'

// Send and continue refresh the run's own project and the current scope (hearsay-tools/cezarion#2327).
const fetchMock = vi.fn<typeof fetch>()

beforeEach(() => {
  vi.stubGlobal('fetch', fetchMock)
  configureLiveSession({ local: false, bootProject: 'boot', apiBase: '' })
  setApiScope('active')
})

afterEach(() => {
  cleanup()
  resetLiveSession()
  fetchMock.mockReset()
  vi.unstubAllGlobals()
  setApiScope(null)
})

const respond = (status: number) => new Response(JSON.stringify(status === 200 ? { id: 'r' } : { error: 'closed' }), {
  status,
  headers: { 'content-type': 'application/json' },
})

const SCOPES = ['active', 'boot', 'default', 'next', 'other', 'third']

/** Both project caches seeded, and nothing else refreshes them: no poll, no SSE. */
function seededClient() {
  const client = createQueryClient()
  for (const scope of SCOPES) {
    client.setQueryData([scope, 'runs', 'list'], [])
    client.setQueryData([scope, 'runs', 'detail', 'r'], { id: 'r' })
  }
  return client
}

function withClient(client: ReturnType<typeof createQueryClient>) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>
  }
}

const stale = (client: ReturnType<typeof createQueryClient>) =>
  SCOPES.filter(scope =>
    client.getQueryState([scope, 'runs', 'list'])?.isInvalidated
    && client.getQueryState([scope, 'runs', 'detail', 'r'])?.isInvalidated)

const paths = {
  send: {
    hook: (projectId?: string) => useSendMessage('r', projectId),
    run: (mutate: (input: never) => void) => mutate({ text: 'hi' } as never),
    route: 'messages',
  },
  continue: {
    hook: (projectId?: string) => useContinueRun('r', projectId),
    run: (mutate: (input: never) => void) => mutate({} as never),
    route: 'continue',
  },
} as const

describe.each(['send', 'continue'] as const)('%s cache refresh', (name) => {
  const path = paths[name]

  async function deliver(projectId: string | undefined, status = 200) {
    const client = seededClient()
    fetchMock.mockResolvedValue(respond(status))
    const { result } = renderHook(() => path.hook(projectId), {
      wrapper: withClient(client),
    })
    act(() => path.run(result.current.mutate as (input: never) => void))
    await waitFor(() => expect(result.current.isIdle).toBe(false))
    await waitFor(() => expect(result.current.isPending).toBe(false))
    return { client, url: String(fetchMock.mock.calls[0]?.[0]) }
  }

  it('from another project, refreshes the run project and the current scope', async () => {
    const { client, url } = await deliver('other')
    expect(url).toBe(`/api/v1/p/other/runs/r/${path.route}`)
    expect(stale(client)).toEqual(['active', 'other'])
  })

  it('in the same project, refreshes that one project', async () => {
    const { client, url } = await deliver(undefined)
    expect(url).toBe(`/api/v1/p/active/runs/r/${path.route}`)
    expect(stale(client)).toEqual(['active'])
  })
})

it('a 409 send from another project refreshes both scopes, so the record stops claiming a session', async () => {
  const client = seededClient()
  fetchMock.mockResolvedValue(respond(409))
  const { result } = renderHook(() => useSendMessage('r', 'other'), {
    wrapper: withClient(client),
  })
  act(() => result.current.mutate({ text: 'hi' } as never))
  await waitFor(() => expect(result.current.isError).toBe(true))
  expect(stale(client)).toEqual(['active', 'other'])
})

it('a send to the boot project that settles after navigation refreshes its slug, its default alias and the new scope', async () => {
  const client = seededClient()
  let release!: (response: Response) => void
  fetchMock.mockReturnValue(new Promise<Response>(resolve => { release = resolve }))
  const { result } = renderHook(() => useSendMessage('r', 'boot'), { wrapper: withClient(client) })
  act(() => result.current.mutate({ text: 'hi' } as never))
  await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
  expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/v1/p/boot/runs/r/messages')
  setApiScope('next')
  await act(async () => release(respond(200)))
  await waitFor(() => expect(result.current.isSuccess).toBe(true))
  expect(stale(client)).toEqual(['boot', 'default', 'next'])
})

describe.each(['send', 'continue'] as const)('%s started in one project and settled in another', (name) => {
  it.each([
    { start: 'active', expected: ['active', 'next'] },
    { start: null, expected: ['boot', 'default', 'next'] },
  ])('from $start refreshes the starting project, its boot alias and the new scope', async ({ start, expected }) => {
    setApiScope(start)
    const client = seededClient()
    let release!: (response: Response) => void
    fetchMock.mockReturnValue(new Promise<Response>(resolve => { release = resolve }))
    const { result } = renderHook(() => paths[name].hook(), { wrapper: withClient(client) })
    act(() => paths[name].run(result.current.mutate as (input: never) => void))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledOnce())
    setApiScope('next')
    await act(async () => release(respond(200)))
    await waitFor(() => expect(result.current.isSuccess).toBe(true))
    expect(stale(client)).toEqual(expected)
  })
})
