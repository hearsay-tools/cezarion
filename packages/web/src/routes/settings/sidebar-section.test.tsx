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
let holdGet: ((scope: string) => Promise<unknown>) | undefined
let failGet = false
let failPut = false
let holdPut: (() => Promise<void>) | undefined
function setup(cached?: Record<string, unknown>, initialScope = 'shop') {
  vi.stubGlobal('fetch', vi.fn(async (input, init) => {
    const url = String(input)
    const scope = /\/p\/([^/]+)\//.exec(url)?.[1] ?? 'default'
    if (init?.method === 'PUT') {
      if (holdPut) await holdPut()
      if (failPut) return json({ error: 'Save unavailable' }, 500)
      stores[scope] = { ...stores[scope], ...JSON.parse(init.body) }
    } else if (holdGet) return json(await holdGet(scope))
    else if (failGet) return json({ error: 'Load unavailable' }, 500)
    return json(stores[scope] ?? {})
  }))
  const client = createQueryClient()
  if (cached) client.setQueryData([initialScope, 'ui-state'], cached, { updatedAt: 1 })
  const tree = (scope: string) => <QueryClientProvider client={client}><ProjectScopeProvider projectId={scope}><Section /></ProjectScopeProvider></QueryClientProvider>
  const result = render(tree(initialScope))
  return { ...result, client, switchTo: (scope: string) => result.rerender(tree(scope)) }
}
afterEach(() => { cleanup(); vi.unstubAllGlobals(); for (const key of Object.keys(stores)) delete stores[key]; failGet = false; failPut = false; holdPut = undefined; holdGet = undefined })
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

it.each([null, [], 'broken', { overall: -1, needsYou: 0, working: 1.5 }].map(value => [value]))('defaults malformed stored settings %j without blocking the form', async sidebarLimits => {
  stores.shop = { sidebarLimits }
  setup()
  await waitFor(() => expect(overall().value).toBe('10'))
  expect(save().disabled).toBe(true)
  expect(screen.getByRole('checkbox', { name: 'Working Unlimited' })).toHaveProperty('checked', true)
})
it('refreshes pristine values and their saved baseline', async () => {
  let release!: (value: unknown) => void
  holdGet = () => new Promise(resolve => { release = resolve })
  setup({ sidebarLimits: { overall: 10 } })
  await waitFor(() => expect(release).toBeTypeOf('function'))
  await act(async () => release({ sidebarLimits: { overall: 3, working: 2 } }))
  await waitFor(() => expect(overall().value).toBe('3'))
  expect(screen.getByRole('spinbutton', { name: 'Working' })).toHaveProperty('value', '2')
  expect(save().disabled).toBe(true)
  fireEvent.change(overall(), { target: { value: '4' } })
  expect(save().disabled).toBe(false)
  fireEvent.change(overall(), { target: { value: '3' } })
  expect(save().disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: 'Finished Unlimited' }))
  fireEvent.click(save())
  await screen.findByText('Sidebar limits saved.')
  expect(stores.shop?.sidebarLimits).toEqual({ overall: 3, needsYou: null, finished: 10, working: 2 })
})
it('retains dirty drafts through refresh and failed mutation, then saves the draft', async () => {
  let release!: (value: unknown) => void
  holdGet = () => new Promise(resolve => { release = resolve })
  setup({ sidebarLimits: { overall: 10 } })
  await waitFor(() => expect(release).toBeTypeOf('function'))
  fireEvent.change(overall(), { target: { value: '4' } })
  await act(async () => release({ sidebarLimits: { overall: 3 } }))
  expect(overall().value).toBe('4')
  failPut = true; fireEvent.click(save())
  await screen.findByText(/Save unavailable/)
  expect(overall().value).toBe('4')
  failPut = false; fireEvent.click(save())
  await screen.findByText('Sidebar limits saved.')
  expect(stores.shop?.sidebarLimits).toMatchObject({ overall: 4 })
})
it.each([['before', 'shop'], ['during', 'shop'], ['before', 'default'], ['during', 'default']] as const)('prevents a GET started %s save in %s from overwriting its successful response', async (timing, scope) => {
  let releaseGet!: (value: unknown) => void
  let releasePut!: () => void
  let reads = 0
  holdGet = () => { reads++; return new Promise(resolve => { releaseGet = resolve }) }
  holdPut = () => new Promise(resolve => { releasePut = resolve })
  const result = setup({ sidebarLimits: { overall: 10 } }, scope)
  await waitFor(() => expect(releaseGet).toBeTypeOf('function'))
  // Keep an unrelated project's request alive: cancellation must be exact and scoped.
  let releaseOther!: (value: unknown) => void
  const other = result.client.fetchQuery({ queryKey: ['other', 'ui-state'], queryFn: () => new Promise(resolve => { releaseOther = resolve }) })
  let releaseNested!: (value: unknown) => void
  const nested = result.client.fetchQuery({ queryKey: [scope, 'ui-state', 'independent'], queryFn: () => new Promise(resolve => { releaseNested = resolve }) })
  fireEvent.change(overall(), { target: { value: '3' } }); fireEvent.click(save())
  await waitFor(() => expect(releasePut).toBeTypeOf('function'))
  if (timing === 'during') {
    // A new refetch can start even after onMutate canceled the first read.
    await act(async () => { void result.client.refetchQueries({ queryKey: [scope, 'ui-state'], exact: true }) })
    await waitFor(() => expect(reads).toBe(2))
  }
  await act(async () => releasePut())
  await screen.findByText('Sidebar limits saved.')
  await act(async () => { releaseGet({ sidebarLimits: { overall: 10 } }); releaseOther({ marker: 'other' }); releaseNested({ marker: 'nested' }); await Promise.all([other, nested]) })
  expect(result.client.getQueryData([scope, 'ui-state'])).toMatchObject({ sidebarLimits: { overall: 3 } })
  expect(result.client.getQueryData(['other', 'ui-state'])).toEqual({ marker: 'other' })
  expect(result.client.getQueryData([scope, 'ui-state', 'independent'])).toEqual({ marker: 'nested' })
  expect(overall().value).toBe('3')
  expect(save().disabled).toBe(true)
})

it('keeps a pending draft while a refresh completes, then adopts the successful save result', async () => {
  let releasePut!: () => void
  holdPut = () => new Promise(resolve => { releasePut = resolve })
  const result = setup()
  await screen.findByRole('spinbutton', { name: 'Overall' })
  fireEvent.change(overall(), { target: { value: '4' } }); fireEvent.click(save())
  await waitFor(() => expect(releasePut).toBeTypeOf('function'))
  await act(async () => { result.client.setQueryData(['shop', 'ui-state'], { sidebarLimits: { overall: 2 } }) })
  expect(overall().value).toBe('4')
  expect(overall().disabled).toBe(true)
  await act(async () => releasePut())
  await screen.findByText('Sidebar limits saved.')
  expect(overall().value).toBe('4')
  expect(save().disabled).toBe(true)
  await act(async () => { result.client.setQueryData(['shop', 'ui-state'], { sidebarLimits: { overall: 5 } }) })
  await waitFor(() => expect(overall().value).toBe('5'))
  expect(save().disabled).toBe(true)
})
