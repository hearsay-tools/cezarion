import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { createQueryClient } from '@/api/query-client'
import { ProjectScopeProvider } from '@/api/project-scope-context'
import { SETTINGS_SECTIONS } from './registry'

const Section = () => {
  const Component = SETTINGS_SECTIONS.find(section => section.id === 'sidebar')?.component
  return Component ? <Component /> : null
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const stores: Record<string, Record<string, unknown>> = {}
let failGet = false
let failPut = false
let holdPut: (() => Promise<void>) | undefined
function setup() {
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = String(input)
    const scope = /\/p\/([^/]+)\//.exec(url)?.[1] ?? 'default'
    if (init?.method === 'PUT') {
      if (holdPut) await holdPut()
      if (failPut) return json({ error: 'Save unavailable' }, 500)
      stores[scope] = { ...stores[scope], ...JSON.parse(init.body) }
    } else if (failGet) return json({ error: 'Load unavailable' }, 500)
    return json(stores[scope] ?? {})
  }))
  const client = createQueryClient()
  const tree = (scope: string) => <QueryClientProvider client={client}><ProjectScopeProvider projectId={scope}><Section /></ProjectScopeProvider></QueryClientProvider>
  const result = render(tree('shop'))
  return { ...result, client, switchTo: (scope: string) => result.rerender(tree(scope)) }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); for (const key of Object.keys(stores)) delete stores[key]; failGet = false; failPut = false; holdPut = undefined })
const overall = () => screen.getByRole('spinbutton', { name: 'Overall' }) as HTMLInputElement
const save = () => screen.getByRole('button', { name: 'Save sidebar limits' }) as HTMLButtonElement

it('offers project-scoped defaults with accessible labels and explains combined budgets', async () => {
  setup()
  await waitFor(() => expect(overall().value).toBe('10'))
  expect(SETTINGS_SECTIONS.find(section => section.id === 'sidebar')?.scope).toBe('project')
  for (const name of ['Needs You', 'Finished', 'Working']) {
    expect(screen.getByRole('checkbox', { name: `${name} Unlimited` })).toHaveProperty('checked', true)
  }
  expect(screen.getByText(/section order/i)).not.toBeNull()
  expect(save().disabled).toBe(true)
})
it.each(['0', '-1', '1.5', ''])('rejects invalid input %j before saving', async value => {
  setup(); await screen.findByRole('spinbutton', { name: 'Overall' })
  fireEvent.change(overall(), { target: { value } })
  expect(overall().getAttribute('aria-invalid')).toBe('true')
  expect(save().disabled).toBe(true)
  expect(screen.getByText(/Enter a positive whole number/)).not.toBeNull()
})
it('saves all four caps, reloads preferences, and separates projects', async () => {
  const rendered = setup(); await screen.findByRole('spinbutton', { name: 'Overall' })
  fireEvent.change(overall(), { target: { value: '4' } })
  fireEvent.click(screen.getByRole('checkbox', { name: 'Finished Unlimited' }))
  fireEvent.change(screen.getByRole('spinbutton', { name: 'Finished' }), { target: { value: '2' } })
  fireEvent.click(save())
  await screen.findByText('Sidebar limits saved.')
  expect(stores.shop?.sidebarLimits).toEqual({ overall: 4, needsYou: null, finished: 2, working: null })
  rendered.switchTo('other')
  await waitFor(() => expect(overall().value).toBe('10'))
  rendered.switchTo('shop')
  await waitFor(() => expect(overall().value).toBe('4'))
  rendered.unmount(); setup()
  await waitFor(() => expect(overall().value).toBe('4'))
})
it('shows loading and a recoverable load error', async () => {
  failGet = true; setup()
  expect(screen.getByText('Loading sidebar settings…')).not.toBeNull()
  await screen.findByText(/Load unavailable/, {}, { timeout: 3000 })
  failGet = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(overall().value).toBe('10'))
})
it('keeps edits after a failed save and exposes retry', async () => {
  failPut = true; setup(); await screen.findByRole('spinbutton', { name: 'Overall' })
  fireEvent.change(overall(), { target: { value: '3' } }); fireEvent.click(save())
  await screen.findByText(/Save unavailable/)
  expect(overall().value).toBe('3'); expect(save().disabled).toBe(false)
  failPut = false; fireEvent.click(save()); await screen.findByText('Sidebar limits saved.')
})
it('captures the saving project even when its response arrives after a project switch', async () => {
  let release!: () => void
  holdPut = () => new Promise<void>(resolve => { release = resolve })
  const result = setup(); await screen.findByRole('spinbutton', { name: 'Overall' })
  fireEvent.change(overall(), { target: { value: '3' } }); fireEvent.click(save())
  await screen.findByRole('button', { name: 'Saving…' })
  result.switchTo('other'); await waitFor(() => expect(overall().value).toBe('10'))
  await act(async () => release())
  await waitFor(() => expect(result.client.getQueryData(['shop', 'ui-state'])).toMatchObject({ sidebarLimits: { overall: 3 } }))
  expect(result.client.getQueryData(['other', 'ui-state'])).toEqual({})
  expect(overall().value).toBe('10')
})
