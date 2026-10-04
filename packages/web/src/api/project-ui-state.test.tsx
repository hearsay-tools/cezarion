import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { setApiScope } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { useProjectUiState } from '@/api/queries'

const json = (value: unknown) => new Response(JSON.stringify(value))
afterEach(() => { cleanup(); vi.unstubAllGlobals(); setApiScope(null) })

it('captures late read scope while switching projects and ignores ambient scope', async () => {
  const client = createQueryClient()
  const requested: string[] = []
  let release!: () => void
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = String(input)
    requested.push(url)
    if (url.includes('/p/shop/')) {
      await new Promise<void>(resolve => { release = resolve })
      return json({ sidebarLimits: { overall: 3 } })
    }
    return json({ sidebarLimits: { overall: 7 } })
  }))
  function Read({ project }: { project: string }) {
    const result = useProjectUiState(project)
    return <output>{result.data?.sidebarLimits?.overall ?? 'loading'}</output>
  }
  const tree = (project: string) => <QueryClientProvider client={client}><Read project={project} /></QueryClientProvider>
  setApiScope('unrelated')
  const rendered = render(tree('shop'))
  await waitFor(() => expect(release).toBeTypeOf('function'))
  rendered.rerender(tree('other'))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('7'))
  await act(async () => release())
  expect(screen.getByRole('status').textContent).toBe('7')
  expect(client.getQueryData(['other', 'ui-state'])).toMatchObject({ sidebarLimits: { overall: 7 } })
  expect(requested).toEqual(['/api/v1/p/shop/ui-state', '/api/v1/p/other/ui-state'])
})

it('disabled demand does not fetch until expanded and boot shares the default cache', async () => {
  const client = createQueryClient()
  const requests: string[] = []
  vi.stubGlobal('fetch', vi.fn(async input => {
    requests.push(String(input))
    return json({ sidebarLimits: { overall: 2 } })
  }))
  function Read({ enabled }: { enabled: boolean }) {
    const result = useProjectUiState('boot', enabled, true)
    return <output>{result.data?.sidebarLimits?.overall ?? 'loading'}</output>
  }
  const tree = (enabled: boolean) => <QueryClientProvider client={client}><Read enabled={enabled} /></QueryClientProvider>
  const rendered = render(tree(false))
  expect(requests).toEqual([])
  rendered.rerender(tree(true))
  await waitFor(() => expect(screen.getByRole('status').textContent).toBe('2'))
  expect(requests).toEqual(['/api/v1/p/boot/ui-state'])
  expect(client.getQueryData(['default', 'ui-state'])).toMatchObject({ sidebarLimits: { overall: 2 } })
})
