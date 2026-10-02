import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { queryKeys } from '@/api/queries'
import { AutomationsRoute } from './automations-route'

afterEach(() => { cleanup(); vi.unstubAllGlobals() })

function mount(mode: 'list' | 'new' | 'edit' | 'log', health: unknown) {
  const client = createQueryClient()
  if (health !== undefined) client.setQueryData(queryKeys.health, health)
  return render(<QueryClientProvider client={client}><MemoryRouter><AutomationsRoute mode={mode} /></MemoryRouter></QueryClientProvider>)
}

it.each(['list', 'new', 'edit', 'log'] as const)('keeps %s gated, and says how to turn automations on, when they are off', (mode) => {
  const fetch = vi.fn(); vi.stubGlobal('fetch', fetch)
  mount(mode, { capabilities: { automations: false } })
  expect(screen.getByText('Automations are off')).not.toBeNull()
  expect(screen.getByText(/CEZ_AUTOMATIONS=1/)).not.toBeNull()
  expect(screen.queryByRole('button', { name: /^Save/ })).toBeNull()
  expect(fetch).not.toHaveBeenCalled()
})

it('waits for health before it renders anything or fetches', () => {
  const client = createQueryClient()
  // Health never answers: a pending query, no cached payload.
  vi.stubGlobal('fetch', vi.fn(() => new Promise(() => undefined)))
  render(<QueryClientProvider client={client}><MemoryRouter><AutomationsRoute mode="new" /></MemoryRouter></QueryClientProvider>)
  expect(screen.getByText('Loading automations…')).not.toBeNull()
  expect(screen.queryByText('Automations are off')).toBeNull()
  expect(document.querySelector('#automation-name')).toBeNull()
})
