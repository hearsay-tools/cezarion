import { act, render, renderHook } from '@testing-library/react'
import { MemoryRouter, useLocation, useNavigate } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { useSearchParamsWriter, type SearchParamsUpdate } from '@/lib/use-search-params-writer'

const router = vi.hoisted(() => ({
  enabled: false,
  location: { key: 'initial', search: '', state: null as Record<string, number> | null },
  type: 'POP' as 'POP' | 'PUSH' | 'REPLACE',
  navigate: vi.fn(),
}))

vi.mock('react-router', async importOriginal => {
  const actual = await importOriginal<typeof import('react-router')>()
  return {
    ...actual,
    useLocation: () => router.enabled ? router.location : actual.useLocation(),
    useNavigate: () => router.enabled ? router.navigate : actual.useNavigate(),
    useNavigationType: () => router.enabled ? router.type : actual.useNavigationType(),
    useSearchParams: () => router.enabled ? [new URLSearchParams(router.location.search)] : actual.useSearchParams(),
  }
})

afterEach(() => { router.enabled = false; router.navigate.mockReset() })

function set(key: string, value: string | null): SearchParamsUpdate {
  return (current) => {
    if (value === null) current.delete(key)
    else current.set(key, value)
    return current
  }
}

function renderWriter(initial = '/p/x/') {
  const handle: {
    write?: (update: SearchParamsUpdate) => void
    externalNavigate?: (search: string) => void
    push?: (search: string) => void
    back?: () => void
    search?: string | undefined
    params?: string
    key?: string
  } = {}
  function Probe() {
    const [params, write] = useSearchParamsWriter()
    const nav = useNavigate()
    handle.write = write
    handle.externalNavigate = (search) => nav({ search }, { replace: true })
    handle.push = (search) => nav({ search })
    handle.back = () => nav(-1)
    handle.params = params.toString()
    const location = useLocation()
    handle.search = location.search
    handle.key = location.key
    return null
  }
  render(<MemoryRouter initialEntries={[initial]}><Probe /></MemoryRouter>)
  return handle
}

describe('useSearchParamsWriter (hearsay-tools/cezarion#1616)', () => {
  it('keeps both of two writes made before the router renders the first', () => {
    const probe = renderWriter('/p/x/?origin=direct')
    act(() => {
      probe.write!(set('archived', '1'))
      probe.write!(set('q', 'Needle'))
    })
    expect(new URLSearchParams(probe.search)).toEqual(new URLSearchParams('origin=direct&archived=1&q=Needle'))
  })

  it('does not navigate for a write that changes nothing', () => {
    const probe = renderWriter('/p/x/?origin=direct')
    const before = probe.key
    act(() => probe.write!(set('q', null)))
    act(() => probe.write!(set('origin', 'direct')))
    // A navigation, even to the same URL, could land after the reader left the page and take
    // them back to it.
    expect(probe.key).toBe(before)
    expect(probe.search).toBe('?origin=direct')
  })

  it('starts from the rendered URL again once the router has caught up', () => {
    const probe = renderWriter()
    act(() => probe.write!(set('archived', '1')))
    expect(probe.params).toBe('archived=1')
    act(() => probe.write!(set('archived', null)))
    act(() => probe.write!(set('origin', 'automations')))
    expect(probe.search).toBe('?origin=automations')
  })

  // hearsay-tools/cezarion#1790: a debounce timer can fire from a stale `next` when an earlier
  // write's render lands between two dispatches and the layout effect reset `next` too early.
  // In the test environment React Router batches both navigate calls into one render, so the
  // exact timing race only manifests in the browser's async concurrent-mode scheduler; the
  // browser-driven regression is mobile-task-controls.e2e.ts:176. This test pins the intended
  // composition guarantee that the session+seq tracking is designed to preserve.
  it('a debounced clear after switching tabs preserves the tab switch (hearsay-tools/cezarion#1790)', () => {
    const probe = renderWriter('/p/x/')
    // Simulate: debounce timer for 'done' fires (A), tab click fires (B) before A renders.
    act(() => {
      probe.write!(set('q', 'done'))        // A: ?q=done
      probe.write!(set('archived', '1'))    // B: ?q=done&archived=1 (composes on A's target)
    })
    // Debounce timer for the clear fires — must compose on B's target, not A's.
    act(() => probe.write!(set('q', null))) // C: should give ?archived=1
    expect(new URLSearchParams(probe.search)).toEqual(new URLSearchParams('archived=1'))
  })

  it('resets to an external URL so subsequent writes start from it', () => {
    const probe = renderWriter('/p/x/?origin=direct')
    act(() => probe.write!(set('archived', '1')))
    // A URL change from outside the writer (sidebar link, pasted URL, etc.)
    act(() => probe.externalNavigate!('?q=external'))
    act(() => probe.write!(set('origin', 'direct')))
    expect(new URLSearchParams(probe.search)).toEqual(new URLSearchParams('q=external&origin=direct'))
  })

  // When ?q=x and ?q=y are both queued and an external navigation to ?q=x occurs, a URL-content
  // check would falsely match the inflight ?q=x entry. The session+seq approach avoids this:
  // the external navigation carries no writer state, so it is identified as external and resets
  // `next` to ?q=x. A subsequent write must compose on ?q=x, not on the stale ?q=y.
  it('resets to an external URL even when that URL matches an earlier queued write', () => {
    const probe = renderWriter('/p/x/')
    act(() => {
      probe.write!(set('q', 'x'))  // A: ?q=x
      probe.write!(set('q', 'y'))  // B: ?q=y (composes on A's target)
    })
    // External navigation to ?q=x — should reset, not match A's inflight entry.
    act(() => probe.externalNavigate!('?q=x'))
    act(() => probe.write!(set('origin', 'direct')))
    expect(new URLSearchParams(probe.search)).toEqual(new URLSearchParams('q=x&origin=direct'))
  })

  // hearsay-tools/cezarion#1790: a Back navigation (POP) may restore a history entry that carries
  // our session tag and an old seq. Without the navigation-type check, the seq guard treats it as
  // an intermediate write still in flight and preserves the stale `next`. The next write then
  // composes from `next` instead of the URL Back restored.
  // hearsay-tools/cezarion#1790: useSearchParams memoises by search string (useMemo([search])),
  // so navigating to a same-search entry returns the same URLSearchParams object. A guard that
  // compares rendered===searchParams would short-circuit on that navigation and leave `next`
  // pointing at an abandoned write's URL. Tracking by location.key (unique per entry) avoids
  // the object-reuse false-positive.
  it('does not short-circuit on a same-search navigation when a write is pending', () => {
    const probe = renderWriter('/p/x/?q=done')
    act(() => {
      // Dispatch a write (REPLACE to ?q=done&archived=1) and a same-search PUSH in the same
      // batch. The PUSH is applied last; its search string (?q=done) matches the initial
      // rendered URL, so useSearchParams returns the same memoised object. The location.key
      // is new, so the external reset must still fire.
      probe.write!(set('archived', '1'))  // REPLACE to ?q=done&archived=1
      probe.push!('?q=done')             // PUSH back to ?q=done (same search, same object)
    })
    act(() => probe.write!(set('f', '1')))
    expect(new URLSearchParams(probe.search)).toEqual(new URLSearchParams('q=done&f=1'))
  })

  it('treats Back as external even when the restored entry carries our session tag', () => {
    const probe = renderWriter('/p/x/')
    act(() => probe.write!(set('q', 'done')))   // seq 1: ?q=done (REPLACE, our state)
    act(() => probe.push!('?q=done'))            // external PUSH — new entry, no writer state
    act(() => probe.write!(set('f', '1')))       // seq 2: ?q=done&f=1 (REPLACE, replaces push)
    // Back → POP to seq-1 entry (?q=done, state {__writerSession, __writerSeq: 1}).
    // Must be treated as external; next must reset to ?q=done.
    act(() => probe.back!())
    act(() => probe.write!(set('new', '1')))     // compose on ?q=done, not stale ?q=done&f=1
    expect(new URLSearchParams(probe.search)).toEqual(new URLSearchParams('q=done&new=1'))
  })
})

describe('writer navigation acknowledgements', () => {
  function start() {
    router.enabled = true
    router.location = { key: 'initial', search: '?base=1', state: null }
    router.type = 'POP'
    return renderHook(() => useSearchParamsWriter())
  }

  function landed(index: number, key: string, type: 'POP' | 'PUSH' | 'REPLACE' = 'REPLACE') {
    const [to, options] = router.navigate.mock.calls[index]!
    router.location = { key, search: to.search, state: options.state }
    router.type = type
  }

  it('preserves the newest query when an earlier write lands first', () => {
    const { result, rerender } = start()
    act(() => {
      result.current[1](set('a', '1'))
      result.current[1](set('b', '2'))
    })
    expect(router.navigate.mock.calls[0]![1]).toMatchObject({ replace: true, state: { __writerSeq: 1 } })
    expect(router.navigate.mock.calls[1]![1].state.__writerSeq).toBe(2)
    landed(0, 'first')
    rerender()
    expect(result.current[0].toString()).toBe('base=1&a=1')
    // A render without navigation must also keep the pending second write.
    rerender()
    act(() => result.current[1](set('c', '3')))
    expect(router.navigate.mock.calls[2]![0]).toEqual({ search: '?base=1&a=1&b=2&c=3' })
    landed(2, 'latest')
    rerender()
    act(() => result.current[1](set('c', '3')))
    expect(router.navigate).toHaveBeenCalledTimes(3)
  })

  it.each(['POP', 'PUSH'] as const)('resets on %s even when the navigation carries a writer tag', type => {
    const { result, rerender } = start()
    act(() => {
      result.current[1](set('a', '1'))
      result.current[1](set('b', '2'))
    })
    landed(0, 'external', type)
    rerender()
    act(() => result.current[1](set('c', '3')))
    expect(router.navigate.mock.calls[2]![0]).toEqual({ search: '?base=1&a=1&c=3' })
  })

  it.each(['foreign session', 'future sequence', 'absent sequence'] as const)('resets a replace from %s', kind => {
    const { result, rerender } = start()
    act(() => result.current[1](set('a', '1')))
    const state = { ...router.navigate.mock.calls[0]![1].state } as Record<string, number>
    if (kind === 'foreign session') state.__writerSession = -1
    if (kind === 'future sequence') state.__writerSeq = 100
    if (kind === 'absent sequence') delete state.__writerSeq
    router.location = { key: 'external', search: '?outside=1', state }
    router.type = 'REPLACE'
    rerender()
    act(() => result.current[1](set('c', '3')))
    expect(router.navigate.mock.calls[1]![0]).toEqual({ search: '?outside=1&c=3' })
  })

  it('gives updates a copy so a no-op cannot change the returned params', () => {
    const { result } = start()
    const returned = result.current[0]
    act(() => result.current[1](current => {
      current.set('scratch', '1')
      return new URLSearchParams('base=1')
    }))
    expect(returned.toString()).toBe('base=1')
    expect(router.navigate).not.toHaveBeenCalled()
    act(() => result.current[1](set('next', '2')))
    expect(router.navigate.mock.calls[0]![0]).toEqual({ search: '?base=1&next=2' })
  })
})
