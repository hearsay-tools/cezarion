import { act, render } from '@testing-library/react'
import { MemoryRouter, useLocation } from 'react-router'
import { describe, expect, it } from 'vitest'

import { useSearchParamsWriter, type SearchParamsUpdate } from '@/lib/use-search-params-writer'

function set(key: string, value: string | null): SearchParamsUpdate {
  return (current) => {
    if (value === null) current.delete(key)
    else current.set(key, value)
    return current
  }
}

function renderWriter(initial = '/p/x/') {
  const handle: { write?: (update: SearchParamsUpdate) => void; search?: string; params?: string } = {}
  function Probe() {
    const [params, write] = useSearchParamsWriter()
    handle.write = write
    handle.params = params.toString()
    handle.search = useLocation().search
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

  it('starts from the rendered URL again once the router has caught up', () => {
    const probe = renderWriter()
    act(() => probe.write!(set('archived', '1')))
    expect(probe.params).toBe('archived=1')
    act(() => probe.write!(set('archived', null)))
    act(() => probe.write!(set('origin', 'automations')))
    expect(probe.search).toBe('?origin=automations')
  })
})
