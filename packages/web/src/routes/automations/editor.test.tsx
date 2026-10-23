import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AutomationDefinition } from '@open-mercato/cezar-api-client'
import { createQueryClient } from '@/api/query-client'
import { AutomationEditor } from './editor'

// Radix's Switch and the composer pills measure themselves; jsdom has no ResizeObserver.
beforeEach(() => { vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} }) })
afterEach(() => { cleanup(); vi.unstubAllGlobals() })
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

type Call = { path: string; method: string; body: unknown }
/** A fetch double: the editor's pickers read workflows (everything else 404s and degrades), and
 *  the write routes answer with whatever `write` returns. */
function stubFetch(write: (call: Call) => Response) {
  const calls: Call[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const call = { path: String(input), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined }
    if (call.method === 'GET') return call.path.endsWith('/workflows') ? json({ workflows: [{ name: 'quick-task', description: '', steps: [] }] }) : json({ error: 'not found' }, 404)
    calls.push(call)
    return write(call)
  }))
  return calls
}

const forgeOk = { available: true }
const saved = { automation: { id: 'new1' } }
function mount(props: Partial<React.ComponentProps<typeof AutomationEditor>> = {}) {
  const onSaved = vi.fn()
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter><AutomationEditor forge={forgeOk} timeZone="Europe/Warsaw" onSaved={onSaved} {...props} /></MemoryRouter>
    </QueryClientProvider>,
  )
  return onSaved
}
const fill = () => {
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Weekly digest' } })
  fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Summarise the week' } })
}

it('saves the explicit existing-items choice for a GitHub automation', async () => {
  const calls = stubFetch(() => json(saved, 201))
  const onSaved = mount()
  fill()
  fireEvent.click(screen.getByRole('button', { name: 'When GitHub changes' }))
  const history = screen.getByRole('switch', { name: 'Include existing items' })
  expect(history.getAttribute('aria-checked')).toBe('false')
  fireEvent.click(history)
  expect(screen.getAllByText(/Existing matches within the lookback/).length).toBeGreaterThan(0)
  fireEvent.click(screen.getByRole('button', { name: 'Save paused' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ filters: { includeExisting: true, lookbackDays: 7, maxRecords: 25 } })
})

it('restores a saved history choice and allows turning it off while editing', async () => {
  const calls = stubFetch(() => json(saved))
  const automation: AutomationDefinition = {
    id: 'history', name: 'Review', revision: 3, kind: 'github', enabled: true,
    events: ['issue.opened'], intervalSeconds: 300,
    filters: { includeExisting: true, lookbackDays: 7, maxRecords: 25 },
    task: { prompt: 'Review {{github.url}}' }, createdAt: '', updatedAt: '',
  }
  const onSaved = mount({ automation })
  const history = screen.getByRole('switch', { name: 'Include existing items' })
  expect(history.getAttribute('aria-checked')).toBe('true')
  fireEvent.click(history)
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(calls.find((call) => call.method === 'PUT')?.body).toMatchObject({ enabled: true, expectedRevision: 3, filters: { includeExisting: false } })
})

it('saves a weekly schedule paused and shows five previewed runs', async () => {
  const calls = stubFetch(() => json(saved, 201))
  const onSaved = mount()
  fill()
  fireEvent.click(screen.getByRole('button', { name: 'Weekly' }))
  fireEvent.click(screen.getByRole('button', { name: 'Wed' }))
  fireEvent.change(screen.getByLabelText('Hour'), { target: { value: '07' } })
  fireEvent.change(screen.getByLabelText('Minute'), { target: { value: '30' } })
  expect(screen.getByRole('button', { name: 'Wed' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.getByText('30 7 * * 3')).not.toBeNull()
  expect(within(screen.getByRole('list', { name: 'Next 5 runs' })).getAllByRole('listitem')).toHaveLength(5)
  fireEvent.click(screen.getByRole('button', { name: 'Save paused' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  const post = calls.find((call) => call.method === 'POST')
  expect(post?.path).toMatch(/\/automations$/)
  expect(post?.body).toMatchObject({
    name: 'Weekly digest', kind: 'schedule', enable: false,
    schedule: { type: 'weekly', hour: 7, minute: 30, day: 3 },
    task: { prompt: 'Summarise the week', workflow: 'quick-task', autonomous: true },
  })
  expect(post?.body).not.toHaveProperty('events')
})

it('an out-of-range hour is marked invalid and blocks Save until it is fixed', async () => {
  // Typing "24" over "02" must not leave the field reading 24 while the draft keeps 2: pressing
  // Save (or Enter) before blur would then save 02:00, a time nobody typed.
  const calls = stubFetch(() => json(saved, 201))
  const onSaved = mount()
  fill()
  const hour = screen.getByLabelText('Hour') as HTMLInputElement
  fireEvent.change(hour, { target: { value: '2' } })
  expect(hour.getAttribute('aria-invalid')).not.toBe('true')
  fireEvent.change(hour, { target: { value: '24' } })
  expect(hour.getAttribute('aria-invalid')).toBe('true')
  expect(screen.getByText('Hour must be 00–23.')).not.toBeNull()
  fireEvent.submit(hour.form!)
  fireEvent.click(screen.getByRole('button', { name: 'Save paused' }))
  await new Promise((resolve) => setTimeout(resolve, 20))
  expect(calls).toEqual([])
  expect(onSaved).not.toHaveBeenCalled()
  fireEvent.change(hour, { target: { value: '23' } })
  expect(hour.getAttribute('aria-invalid')).not.toBe('true')
  fireEvent.click(screen.getByRole('button', { name: 'Save paused' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ schedule: { hour: 23 } })
})

it('offers Save and enable once the enable switch is on', async () => {
  const calls = stubFetch(() => json(saved, 201))
  const onSaved = mount()
  fill()
  fireEvent.click(screen.getByRole('switch', { name: 'Enable after saving' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save and enable' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ enable: true })
})

it('switching to GitHub is disabled with the forge reason when unavailable, and the schedule form still saves', async () => {
  const calls = stubFetch(() => json(saved, 201))
  const onSaved = mount({ forge: { available: false, reason: 'No GitHub remote configured.' } })
  const github = screen.getByRole('button', { name: 'When GitHub changes' }) as HTMLButtonElement
  expect(github.disabled).toBe(true)
  expect(screen.getByText('GitHub unavailable · No GitHub remote configured.')).not.toBeNull()
  fireEvent.click(github)
  expect(screen.getByRole('button', { name: 'On a schedule' }).getAttribute('aria-pressed')).toBe('true')
  fill()
  fireEvent.click(screen.getByRole('button', { name: 'Save paused' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ kind: 'schedule' })
})

it('a 400 renders under the section and keeps the draft', async () => {
  let attempt = 0
  stubFetch(() => (attempt++ === 0 ? json({ error: 'Prompt uses an unknown placeholder {{nope}}.' }, 400) : json(saved, 201)))
  const onSaved = mount({ forge: { available: false, reason: 'No GitHub remote configured.' } })
  fill()
  fireEvent.click(screen.getByRole('button', { name: 'Save paused' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain('unknown placeholder')
  expect(within(screen.getByRole('group', { name: 'What to run' })).getByRole('alert')).toBe(alert)
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Weekly digest')
  expect((screen.getByLabelText('Prompt') as HTMLTextAreaElement).value).toBe('Summarise the week')
  expect(onSaved).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Save paused' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
})

const stored = {
  id: 'a1', revision: 4, name: 'Digest', description: '', kind: 'schedule', enabled: false, schedule: { type: 'daily', hour: 4, minute: 0 },
  task: { prompt: 'Go', workflow: 'quick-task' }, createdAt: '', updatedAt: '',
} as AutomationDefinition

it('requires an explicit single-task choice before saving a retired multi-candidate template', async () => {
  const calls = stubFetch(() => json(saved))
  const onSaved = mount({ automation: { ...stored, task: { ...stored.task, variants: 2 } } })
  expect(screen.getByRole('alert').textContent).toContain('cannot launch')
  expect(screen.queryByRole('heading', { name: 'Copy as CLI' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await screen.findByText('Parallel variants are removed. Choose Use one task before saving this automation.')
  expect(calls).toEqual([])
  expect(onSaved).not.toHaveBeenCalled()
  fireEvent.click(screen.getByRole('button', { name: 'Use one task' }))
  expect(screen.getByRole('heading', { name: 'Copy as CLI' })).toBeTruthy()
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(calls.find(call => call.method === 'PUT')?.body).toMatchObject({ task: { prompt: 'Go' } })
  expect(calls.find(call => call.method === 'PUT')?.body).not.toHaveProperty('task.variants')
})

it('a 409 shows the reload action and keeps the typed name', async () => {
  stubFetch(() => json({ error: 'automation revision conflict' }, 409))
  const onReload = vi.fn()
  const onSaved = mount({ automation: stored, onReload })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Renamed locally' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  expect((await screen.findByRole('alert')).textContent).toContain('Edited elsewhere — reload to see the latest version')
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Renamed locally')
  fireEvent.click(screen.getByRole('button', { name: 'Reload' }))
  expect(onReload).toHaveBeenCalled()
  expect(onSaved).not.toHaveBeenCalled()
})

it('saves an edit with the revision it read, then enables a paused automation through the enable route', async () => {
  const calls = stubFetch(() => json({ automation: stored }))
  const onSaved = mount({ automation: stored })
  fireEvent.click(screen.getByRole('switch', { name: 'Enabled' }))
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  const put = calls.find((call) => call.method === 'PUT')
  expect(put?.path).toMatch(/\/automations\/a1$/)
  expect(put?.body).toMatchObject({ expectedRevision: 4, enabled: false, kind: 'schedule' })
  expect(calls.some((call) => call.path.endsWith('/a1/enable'))).toBe(true)
})

it('does not let an existing automation change its kind', () => {
  stubFetch(() => json({}))
  mount({ automation: stored })
  expect(screen.queryByRole('button', { name: 'When GitHub changes' })).toBeNull()
  expect(screen.getByText('On a schedule')).not.toBeNull()
})

it('shows the GitHub fields and how it polls, instead of a preview, for a GitHub automation', () => {
  stubFetch(() => json({}))
  mount({ automation: { ...stored, kind: 'github', schedule: undefined, events: ['issue.opened'], intervalSeconds: 600, filters: { lookbackDays: 7, maxRecords: 25 } } as AutomationDefinition })
  expect(screen.getByRole('button', { name: 'issue.opened' }).getAttribute('aria-pressed')).toBe('true')
  expect(screen.queryByRole('list', { name: 'Next 5 runs' })).toBeNull()
  expect(screen.getByText(/every 10 minutes/)).not.toBeNull()
})

it.each([
  ['AUTOMATIONS_OFF', 'Automations are off on this server.'],
  ['a kind switch', 'change the kind by creating a new automation'],
])('a 409 that is not a revision conflict (%s) shows its own message and no Reload', async (_name, error) => {
  stubFetch(() => json({ error }, 409))
  mount({ automation: stored, onReload: vi.fn() })
  fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Kept' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
  const alert = await screen.findByRole('alert')
  expect(alert.textContent).toContain(error)
  expect(alert.textContent).not.toContain('Edited elsewhere')
  expect(screen.queryByRole('button', { name: 'Reload' })).toBeNull()
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Kept')
})

it('deletes an existing automation only after an inline confirm, then leaves the editor', async () => {
  const calls = stubFetch(() => new Response(null, { status: 204 }))
  const onSaved = mount({ automation: stored })
  expect(screen.queryByRole('button', { name: 'Delete automation' })).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  expect(screen.getByText('Delete “Digest”? It will stop running and cannot be restored.')).not.toBeNull()
  expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Keep' }))
  expect(screen.getByRole('button', { name: 'Delete' })).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete automation' }))
  await waitFor(() => expect(onSaved).toHaveBeenCalled())
  expect(calls.find((call) => call.method === 'DELETE')?.path).toMatch(/\/automations\/a1$/)
})

it('keeps the editor and says why when the delete fails', async () => {
  stubFetch(() => json({ error: 'not found' }, 404))
  const onSaved = mount({ automation: stored })
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete automation' }))
  expect((await screen.findByRole('alert')).textContent).toContain('not found')
  expect(onSaved).not.toHaveBeenCalled()
  expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Digest')
})

it('offers no Delete on a new automation', () => {
  stubFetch(() => json({}))
  mount()
  expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull()
})

it('shows Copy as CLI beside both kinds, following the draft', () => {
  stubFetch(() => json(saved, 201))
  mount()
  fill()
  expect(screen.getByText(/^cez automation (add|create) .*Weekly digest/)).not.toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'When GitHub changes' }))
  expect(screen.getByRole('heading', { name: 'Copy as CLI' })).not.toBeNull()
  expect(screen.getByText(/^cez automation (add|create) .*Weekly digest/)).not.toBeNull()
})

// hearsay-tools/cezarion#1465: Run once.
describe('one-time schedules', () => {
  const chooseOnce = () => fireEvent.click(screen.getByRole('button', { name: 'Once' }))
  const setWhen = (date: string, hour: string, minute: string) => {
    fireEvent.change(screen.getByLabelText('Date'), { target: { value: date } })
    fireEvent.change(screen.getByLabelText('Hour'), { target: { value: hour } })
    fireEvent.change(screen.getByLabelText('Minute'), { target: { value: minute } })
  }

  it('choosing Once shows date, time, zone and latest start', () => {
    stubFetch(() => json(saved, 201))
    mount()
    chooseOnce()
    expect(screen.getByRole('button', { name: 'Once' }).getAttribute('aria-pressed')).toBe('true')
    for (const label of ['Date', 'Hour', 'Minute', 'Time zone', 'Latest start']) expect(screen.getByLabelText(label)).not.toBeNull()
    expect((screen.getByLabelText('Time zone') as HTMLInputElement).value).toBe('Europe/Warsaw')
    setWhen('2030-01-15', '09', '30')
    expect(screen.getByText('Runs once at 09:30 on Tue 15 Jan 2030 (Europe/Warsaw). Cezarion must be running then.')).not.toBeNull()
    expect(screen.queryByText(/^Cron:/)).toBeNull()
  })

  it('the summary names the time a DST gap moves the schedule to', () => {
    stubFetch(() => json(saved, 201))
    mount()
    chooseOnce()
    setWhen('2027-03-28', '02', '30')
    expect(screen.getByText('Runs once at 01:30 on Sun 28 Mar 2027 (Europe/Warsaw). 02:30 does not exist on Sun 28 Mar 2027 in Europe/Warsaw. Cezarion must be running then.')).not.toBeNull()
  })

  it('a past time blocks save and keeps the draft', async () => {
    const calls = stubFetch(() => json(saved, 201))
    const onSaved = mount()
    fill()
    chooseOnce()
    setWhen('2020-01-15', '09', '00')
    expect(screen.getByText('the due time has passed; choose a later time or use Run now')).not.toBeNull()
    expect((screen.getByLabelText('Date') as HTMLInputElement).validationMessage).toBe('the due time has passed; choose a later time or use Run now')
    fireEvent.click(screen.getByRole('button', { name: 'Save paused' }))
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(calls.filter((call) => call.method === 'POST')).toEqual([])
    expect(onSaved).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Name') as HTMLInputElement).value).toBe('Weekly digest')
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2020-01-15')
  })

  // Review of #1465: a Failed or Missed schedule keeps its past due time. Editing its prompt
  // before Run now or Retry must save; only a changed due time has to be in the future.
  it('an existing schedule past its due time saves a prompt-only edit, but not a new past time', async () => {
    const pastOnce = { ...stored, schedule: { type: 'once', at: '2020-01-15T09:00', timeZone: 'UTC' } } as AutomationDefinition
    const calls = stubFetch(() => json({ automation: pastOnce }))
    const onSaved = mount({ automation: pastOnce })
    expect(screen.queryByText('the due time has passed; choose a later time or use Run now')).toBeNull()
    fireEvent.change(screen.getByLabelText('Prompt'), { target: { value: 'Go, with more care' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save changes' }))
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(calls.find((call) => call.method === 'PUT')?.body).toMatchObject({ schedule: { type: 'once', at: '2020-01-15T09:00', timeZone: 'UTC' }, task: { prompt: 'Go, with more care' } })
    setWhen('2020-02-15', '09', '00')
    expect((screen.getByLabelText('Date') as HTMLInputElement).validationMessage).toBe('the due time has passed; choose a later time or use Run now')
  })

  it('a server 400 on time zone renders beside the zone field and keeps the draft', async () => {
    stubFetch(() => json({ error: 'unknown time zone "Etc/Nowhere"; use an IANA name such as Europe/Warsaw' }, 400))
    const onSaved = mount()
    fill()
    chooseOnce()
    setWhen('2030-01-15', '09', '00')
    fireEvent.click(screen.getByRole('button', { name: 'Save paused' }))
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('unknown time zone')
    expect(alert.previousElementSibling?.contains(screen.getByLabelText('Time zone'))).toBe(true)
    expect(onSaved).not.toHaveBeenCalled()
    expect((screen.getByLabelText('Date') as HTMLInputElement).value).toBe('2030-01-15')
  })

  it('an unknown typed zone blocks save with its message', () => {
    stubFetch(() => json(saved, 201))
    mount()
    chooseOnce()
    fireEvent.change(screen.getByLabelText('Time zone'), { target: { value: 'Mars/Base' } })
    expect((screen.getByLabelText('Time zone') as HTMLInputElement).validationMessage).toBe('unknown time zone "Mars/Base"; use an IANA name such as Europe/Warsaw')
  })

  it('keyboard only: Tab reaches every once control in order and Enter saves', async () => {
    const calls = stubFetch(() => json(saved, 201))
    const onSaved = mount()
    fill()
    chooseOnce()
    setWhen('2030-01-15', '09', '00')
    const when = screen.getByRole('group', { name: 'When' })
    const tabbable = [...when.querySelectorAll<HTMLElement>('button, input, select, [role="combobox"], [tabindex]')]
      .filter((element) => element.tabIndex >= 0 && !(element as HTMLButtonElement).disabled)
    const order = ['Date', 'Hour', 'Minute', 'Time zone', 'Latest start'].map((label) => tabbable.indexOf(screen.getByLabelText(label)))
    expect(order.every((index) => index >= 0)).toBe(true)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
    // Enter in a text field submits its form.
    fireEvent.submit(screen.getByLabelText('Date').closest('form')!)
    await waitFor(() => expect(onSaved).toHaveBeenCalled())
    expect(calls.find((call) => call.method === 'POST')?.body).toMatchObject({ schedule: { type: 'once', at: '2030-01-15T09:00', timeZone: 'Europe/Warsaw' } })
  })
})
