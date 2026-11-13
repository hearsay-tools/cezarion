import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, within, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import type { Skill, WorkflowDef, WorkflowsResponse } from '@open-mercato/cezar-api-client'
import { Toaster, resetToasts } from '@/components/ui/toaster'

import { WorkflowsRoute } from './workflows'

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

// ---- fixtures ----------------------------------------------------------------------------------

const SKILLS: Skill[] = [
  {
    name: 'om-fix',
    description: 'Fix the thing, verify the regression, and leave a concise review note for the next person.',
    body: '',
    path: '.ai/skills/om-fix.md',
    source: 'ai',
  },
  { name: 'om-review', description: 'Review it', body: '', path: '~/.cez/skills/om-review.md', source: 'global' },
]

const QUICK: WorkflowDef = {
  name: 'quick-task',
  description: 'One agent run on your task — no ceremony.',
  source: 'built-in',
  steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
}

/** The repo's first saved (file) workflow — what a cold /workflows visit must open. */
const SHIP: WorkflowDef = {
  name: 'ship-it',
  description: 'Fix then review.',
  source: 'file',
  path: '.ai/cezar/workflows/ship-it.yaml',
  steps: [
    { id: 'om-fix', name: 'om-fix', skill: 'om-fix', prompt: '{{task}}' },
    { id: 'om-review', name: 'om-review', skill: 'om-review', prompt: '{{task}}' },
  ],
}

/** Already at the server's save/run cap. */
const FULL: WorkflowDef = {
  name: 'crowded',
  source: 'file',
  path: '.ai/cezar/workflows/crowded.yaml',
  steps: Array.from({ length: 8 }, (_, i) => ({
    id: `s${i + 1}`,
    name: 'om-fix',
    skill: 'om-fix',
    prompt: '{{task}}',
  })),
}

interface SentRequest {
  path: string
  method: string
  body: unknown
}

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

/** Fetch stub in the house style: records requests (bodies included), serves
 *  the fixtures, and lets a test override specific `METHOD path` keys — per call, so a 409
 *  can turn into a 201 on the retry. */
function stubFetch(
  overrides: Record<string, Array<() => Response | Promise<Response>>> = {},
  workflows: WorkflowDef[] = [QUICK, SHIP],
): SentRequest[] {
  const sent: SentRequest[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const path = String(input)
      const method = init.method ?? 'GET'
      sent.push({ path, method, body: init.body ? JSON.parse(String(init.body)) : undefined })
      const queue = overrides[`${method} ${path}`]
      const next = queue?.shift()
      if (next) return next()
      if (method === 'GET' && path === '/api/v1/workflows') {
        return jsonResponse({ workflows, issues: [] } satisfies WorkflowsResponse)
      }
      if (method === 'GET' && path === '/api/v1/skills') return jsonResponse(SKILLS)
      if (method === 'GET' && path === '/api/v1/ui-state') return jsonResponse({})
      return jsonResponse({ error: 'not found' }, 404)
    }),
  )
  return sent
}

function renderAt(entry: string) {
  render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter initialEntries={[entry]}>
        <Routes>
          <Route path="/workflows" element={<WorkflowsRoute />} />
          <Route path="/workflows/:name" element={<WorkflowsRoute />} />
        </Routes>
        <Toaster />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

const stepCards = () => [...document.querySelectorAll<HTMLElement>('[data-slot="wb-step"]')]
const stepIds = () => stepCards().map((card) => card.dataset.id)
const yamlText = () => document.querySelector('[data-slot="wb-yaml"]')?.textContent ?? ''
const nameInput = () => screen.getByLabelText('Workflow name') as HTMLInputElement
const addButton = (skill: string) =>
  document.querySelector<HTMLButtonElement>(`[data-slot="wb-skill"][data-skill="${skill}"] [data-slot="wb-skill-add"]`)!

// ---- seeding -----------------------------------------------------------------------------------

describe('canvas seeding', () => {
  it('a cold /workflows opens the repo’s first saved workflow (built-ins skipped)', async () => {
    stubFetch()
    renderAt('/workflows')

    await waitFor(() => expect(stepIds()).toEqual(['om-fix', 'om-review']))
    expect(nameInput().value).toBe('ship-it')
    // The selector reflects the loaded file; YAML retains the compact skill stack.
    expect((screen.getByLabelText('Load an existing workflow') as HTMLSelectElement).value).toBe('ship-it')
    expect(yamlText()).toContain('skills:')
    expect(yamlText()).toContain('- om-fix')
    expect(screen.getByText('2 skills')).toBeTruthy()
  })

  it('/workflows/:name deep-links that workflow into the canvas', async () => {
    stubFetch({}, [QUICK, SHIP, FULL])
    renderAt('/workflows/crowded')

    await waitFor(() => expect(stepCards()).toHaveLength(8))
    expect(nameInput().value).toBe('crowded')
  })

  it('no saved workflows → an empty canvas with the drop hint', async () => {
    stubFetch({}, [QUICK])
    renderAt('/workflows')

    await screen.findByText('Drop a skill here — or Import a workflow.yaml')
    expect(stepCards()).toHaveLength(0)
    expect(nameInput().value).toBe('my-workflow')
  })
})

// ---- action hierarchy + readable summaries ----------------------------------------------------

describe('workflow editor presentation', () => {
  it('makes Save the sole primary toolbar action and keeps destructive emphasis inside confirmation', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    const save = document.querySelector<HTMLElement>('[data-slot="wb-save"]')!
    const removeFile = document.querySelector<HTMLElement>('[data-slot="wb-delete"]')!
    expect(save.dataset.variant).toBe('primary')
    expect(removeFile.dataset.variant).toBe('ghost')
    expect(removeFile.className).not.toContain('text-soft-foreground')

    fireEvent.click(removeFile)
    const confirm = document.querySelector<HTMLElement>('[data-slot="wb-delete-confirm"]')!
    expect(confirm.className).toContain('bg-danger')
  })

  it('shows the step prompt ahead of the skill catalog description', async () => {
    stubFetch({}, [{ ...SHIP, steps: [{ ...SHIP.steps[0]!, prompt: 'Implement {{task}} and leave a concise review note after verification.' }, SHIP.steps[1]!] }])
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    const first = stepCards()[0]!
    const summary = first.querySelector<HTMLElement>('[data-slot="wb-step-summary"]')!
    expect(summary).toBeTruthy()
    expect(summary.textContent).toBe('Implement {{task}} and leave a concise review note after verification.')
    expect(summary.className).toContain('break-words')
    expect(summary.className).not.toContain('truncate')
    expect(first.querySelector('[data-slot="wb-step-heading"]')).toBeTruthy()
  })

  it('keeps the skill description for the generic task placeholder', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    expect(stepCards()[1]!.querySelector('[data-slot="wb-step-summary"]')?.textContent).toBe('Review it')
  })

  it('adds a selected skill from the Add step picker without changing the draft on cancel', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add step' })
    fireEvent.change(within(dialog).getByLabelText('Filter skills'), { target: { value: 'om-review' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: /om-review/ }))
    expect(stepCards()).toHaveLength(2)
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add selected skill' }))
    expect(stepCards()).toHaveLength(3)
    expect(stepIds()[2]).toContain('om-review')
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }))
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Add step' })).getByRole('button', { name: 'Cancel' }))
    expect(stepCards()).toHaveLength(3)
    await waitFor(() => expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Add step' })))
  })

  it('Add step ranks a name match above a description-only hit', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add step' })
    fireEvent.change(within(dialog).getByLabelText('Filter skills'), { target: { value: 'review' } })
    const radios = within(dialog).getAllByRole('radio')
    expect(radios.map((radio) => (radio as HTMLInputElement).value)).toEqual(['om-review', 'om-fix'])
  })

  it('keeps Export available and downloads the current workflow YAML', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    const createObjectUrl = vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:workflow-yaml')
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
      expect(this.download).toBe('ship-it.yaml')
      expect(this.href).toBe('blob:workflow-yaml')
      expect(this.isConnected).toBe(true)
    })
    const revokeObjectUrl = vi.spyOn(URL, 'revokeObjectURL')
    vi.useFakeTimers()

    fireEvent.click(document.querySelector('[data-slot="wb-export"]')!)

    expect(createObjectUrl).toHaveBeenCalledOnce()
    const exported = createObjectUrl.mock.calls[0]?.[0]
    expect(exported).toBeInstanceOf(Blob)
    expect((exported as Blob).type).toBe('text/yaml')
    await expect((exported as Blob).text()).resolves.toContain('name: ship-it')
    expect(click).toHaveBeenCalledOnce()
    expect(document.querySelector('a[download]')).toBeNull()
    await act(() => vi.runOnlyPendingTimersAsync())
    expect(revokeObjectUrl).toHaveBeenCalledWith('blob:workflow-yaml')
  })
})

// ---- palette → canvas, remove, limit -----------------------------------------------------------

describe('palette add / remove / the 8-step limit', () => {
  it('the palette add appends a step, dedupes ids, and updates count + YAML', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(addButton('om-fix'))
    expect(stepIds()).toEqual(['om-fix', 'om-review', 'om-fix-2'])
    expect(screen.getByText('3 skills')).toBeTruthy()
    expect(yamlText().match(/- om-fix/g)).toHaveLength(2)
  })

  it('remove drops exactly that card', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.pointerDown(screen.getByRole('button', { name: 'Step 1 actions: om-fix' }))
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Remove step 1: om-fix' }))
    expect(stepIds()).toEqual(['om-review'])
    expect(screen.getByText('1 skill')).toBeTruthy()
  })

  it('the 9th step is refused with the legacy message', async () => {
    stubFetch({}, [FULL])
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(8))

    fireEvent.click(addButton('om-review'))
    expect(stepCards()).toHaveLength(8)
    await screen.findByText('A workflow holds at most 8 steps.')
  })

  // #374: the palette's empty state must mention the same discovery dirs as the Skills tab's,
  // not just `.ai/skills/`.
  it('an empty skill catalog explains every discovery dir, not just .ai/skills/', async () => {
    stubFetch({ 'GET /api/v1/skills': [() => jsonResponse([])] })
    renderAt('/workflows')

    const hint = await screen.findByText(/No skills yet/)
    expect(hint.textContent).toContain('.ai/skills/')
    expect(hint.textContent).toContain('.ai/cezar/skills/')
    expect(hint.textContent).toContain('.agents/skills/')
  })
})

// ---- import ------------------------------------------------------------------------------------

describe('YAML import', () => {
  it('a valid paste replaces the canvas with the server-normalized steps', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows/parse': [
        () =>
          jsonResponse({
            name: 'imported-flow',
            steps: [{ id: 'om-review', name: 'om-review', skill: 'om-review', prompt: '{{task}}' }],
          }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-import"]')!)
    fireEvent.change(screen.getByLabelText('Workflow YAML to import'), {
      target: { value: 'name: imported-flow\nskills:\n  - om-review\n' },
    })
    fireEvent.click(document.querySelector('[data-slot="wb-import-run"]')!)

    await waitFor(() => expect(stepIds()).toEqual(['om-review']))
    expect(nameInput().value).toBe('imported-flow')
    // The server owns YAML parsing — the paste went to /parse verbatim.
    expect(sent.find((r) => r.path === '/api/v1/workflows/parse')?.body).toEqual({
      yaml: 'name: imported-flow\nskills:\n  - om-review',
    })
    await screen.findByText('Imported "imported-flow" — review, then Save.')
  })

  it('a bad paste surfaces the server’s own error and keeps the canvas', async () => {
    stubFetch({
      'POST /api/v1/workflows/parse': [
        () => jsonResponse({ error: 'a workflow lists either "steps" or "skills", not both' }, 400),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-import"]')!)
    fireEvent.change(screen.getByLabelText('Workflow YAML to import'), { target: { value: 'nope: 1' } })
    fireEvent.click(document.querySelector('[data-slot="wb-import-run"]')!)

    await waitFor(() =>
      expect(document.querySelector('[data-slot="wb-import-error"]')?.textContent).toBe(
        'a workflow lists either "steps" or "skills", not both',
      ),
    )
    expect(stepIds()).toEqual(['om-fix', 'om-review'])
  })
})

// ---- auto chain creator (#414) -----------------------------------------------------------------

describe('auto chain creator', () => {
  it('a built plan lands its title + steps on the canvas', async () => {
    const sent = stubFetch({
      'POST /api/v1/plan': [
        () =>
          jsonResponse({
            name: 'fix-and-review',
            steps: [
              { id: 'implement', name: 'Implement', prompt: '{{task}}' },
              { id: 'verify', name: 'Verify', command: 'npm test' },
            ],
            rationale: 'implement then verify',
            fallback: false,
          }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-auto"]')!)
    fireEvent.change(screen.getByLabelText('Describe the chain to build'), {
      target: { value: 'Fix the bug and review it' },
    })
    fireEvent.click(document.querySelector('[data-slot="wb-auto-run"]')!)

    await waitFor(() => expect(stepIds()).toEqual(['implement', 'verify']))
    expect(nameInput().value).toBe('fix-and-review')
    expect(sent.find((r) => r.path === '/api/v1/plan')?.body).toEqual({ task: 'Fix the bug and review it' })
    await screen.findByText('Built "fix-and-review" — review, tweak, then Save.')
  })

  it('a degraded (fallback) plan keeps the current name and warns', async () => {
    stubFetch({
      'POST /api/v1/plan': [
        () =>
          jsonResponse({
            steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
            rationale: 'planner unavailable',
            fallback: true,
          }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-auto"]')!)
    fireEvent.change(screen.getByLabelText('Describe the chain to build'), {
      target: { value: 'do something' },
    })
    fireEvent.click(document.querySelector('[data-slot="wb-auto-run"]')!)

    await waitFor(() => expect(stepIds()).toEqual(['task']))
    // No proposed title → the name the canvas already had (the seeded file) survives.
    expect(nameInput().value).toBe('ship-it')
    await screen.findByText('Planner unavailable — added a single step. Edit, then Save.')
  })
})

// ---- save --------------------------------------------------------------------------------------

describe('save', () => {
  it('a pure stack saves in the portable compact form', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows': [
        () => jsonResponse({ path: '.ai/cezar/workflows/ship-it.yaml', name: 'ship-it' }, 201),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-save"]')!)
    await screen.findByText('Saved — ship-it.yaml')
    expect(sent.find((r) => r.method === 'POST' && r.path === '/api/v1/workflows')?.body).toEqual({
      name: 'ship-it',
      description: 'Fix then review.',
      skills: ['om-fix', 'om-review'],
    })
  })

  it('a 409 opens the overwrite confirm; confirming retries with overwrite: true', async () => {
    const sent = stubFetch({
      'POST /api/v1/workflows': [
        () => jsonResponse({ error: 'workflow file already exists', exists: true }, 409),
        () => jsonResponse({ path: '.ai/cezar/workflows/ship-it.yaml', name: 'ship-it' }, 201),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-save"]')!)
    await screen.findByText('“ship-it” already exists')
    fireEvent.click(document.querySelector('[data-slot="wb-overwrite-confirm"]')!)

    await screen.findByText('Saved — ship-it.yaml')
    const posts = sent.filter((r) => r.method === 'POST' && r.path === '/api/v1/workflows')
    expect(posts).toHaveLength(2)
    expect(posts[0]!.body).not.toHaveProperty('overwrite')
    expect(posts[1]!.body).toMatchObject({ name: 'ship-it', overwrite: true })
  })

  it('an empty canvas refuses to save with the legacy message', async () => {
    const sent = stubFetch({}, [QUICK])
    renderAt('/workflows')
    await screen.findByText('Drop a skill here — or Import a workflow.yaml')

    fireEvent.click(document.querySelector('[data-slot="wb-save"]')!)
    await screen.findByText('Add at least one step first.')
    expect(sent.some((r) => r.method === 'POST')).toBe(false)
  })
})

// ---- delete / new ------------------------------------------------------------------------------

describe('delete and “+ new”', () => {
  it('Delete exists only for saved files, confirms, DELETEs and resets the canvas', async () => {
    const sent = stubFetch({
      'DELETE /api/v1/workflows/ship-it': [
        () => jsonResponse({ ok: true, path: '.ai/cezar/workflows/ship-it.yaml' }),
      ],
    })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-delete"]')!)
    await screen.findByText('Delete workflow “ship-it”?')
    fireEvent.click(document.querySelector('[data-slot="wb-delete-confirm"]')!)

    await screen.findByText('Deleted "ship-it".')
    expect(sent.some((r) => r.method === 'DELETE' && r.path === '/api/v1/workflows/ship-it')).toBe(true)
    await waitFor(() => expect(stepCards()).toHaveLength(0))
    expect(nameInput().value).toBe('my-workflow')
  })

  it('a built-in (or unsaved) name shows no Delete button', async () => {
    stubFetch({}, [QUICK])
    renderAt('/workflows')
    await screen.findByText('Drop a skill here — or Import a workflow.yaml')
    expect(document.querySelector('[data-slot="wb-delete"]')).toBeNull()
  })

  it('“+ new” resets to the empty draft', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))

    fireEvent.click(document.querySelector('[data-slot="wb-new"]')!)
    expect(stepCards()).toHaveLength(0)
    expect(nameInput().value).toBe('my-workflow')
    await screen.findByText('Drop a skill here — or Import a workflow.yaml')
  })
})


describe('design workflow controls', () => {
  it('keeps Description beside the name; a loaded file’s description round-trips in YAML', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    const description = screen.getByLabelText('Description') as HTMLTextAreaElement
    expect(description).not.toBeNull()
    fireEvent.change(screen.getByLabelText('Load an existing workflow'), { target: { value: 'quick-task' } })
    expect(nameInput().value).toBe('quick-task')
    expect(description.value).toBe('One agent run on your task — no ceremony.')
    expect(yamlText()).toContain('One agent run on your task — no ceremony.')
    fireEvent.change(description, { target: { value: 'Edited chain' } })
    expect(yamlText()).toContain('Edited chain')
  })

  it('reorders without dragging and keeps boundary controls disabled', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    expect((screen.getByLabelText('Move step 1 up') as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByLabelText('Move step 1 down'))
    expect(stepIds()).toEqual(['om-review', 'om-fix'])
    expect(yamlText().indexOf('- om-review')).toBeLessThan(yamlText().indexOf('- om-fix'))
    expect((screen.getByLabelText('Move step 2 down') as HTMLButtonElement).disabled).toBe(true)
  })
})

// The route owns these transitions; the section tests cover only the individual controls.
describe('draft editing and cancelled actions', () => {
  it('clears metadata for a new draft and only offers Delete for the matching saved file', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    fireEvent.change(nameInput(), { target: { value: 'unsaved' } })
    expect(document.querySelector('[data-slot="wb-delete"]')).toBeNull()
    fireEvent.change(screen.getByLabelText('Load an existing workflow'), { target: { value: 'quick-task' } })
    expect(document.querySelector('[data-slot="wb-delete"]')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'New workflow' }))
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('')
    expect(stepIds()).toEqual([])
  })

  it('filters the palette and marks only skills already in the flow', async () => {
    stubFetch({}, [{ ...SHIP, steps: [SHIP.steps[0]!, QUICK.steps[0]!] }])
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    const palette = (skill: string) => document.querySelector(`[data-slot="wb-skill"][data-skill="${skill}"]`)!
    expect(palette('om-fix').getAttribute('data-in-flow')).toBe('true')
    expect(palette('om-review').hasAttribute('data-in-flow')).toBe(false)
    const filter = screen.getByLabelText('Filter skills') as HTMLInputElement
    expect(filter.value).toBe('')
    fireEvent.change(filter, { target: { value: 'om-review' } })
    expect(document.querySelectorAll('[data-slot="wb-skill"]')).toHaveLength(1)
    expect(palette('om-review')).toBeTruthy()
  })

  it('resets the picker filter and selection on each opening', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }))
    const dialog = await screen.findByRole('dialog', { name: 'Add step' })
    expect((within(dialog).getByLabelText('Filter skills') as HTMLInputElement).value).toBe('')
    fireEvent.change(within(dialog).getByLabelText('Filter skills'), { target: { value: 'om-review' } })
    fireEvent.click(within(dialog).getByRole('radio', { name: /om-review/ }))
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
    fireEvent.click(screen.getByRole('button', { name: 'Add step' }))
    const reopened = await screen.findByRole('dialog', { name: 'Add step' })
    expect((within(reopened).getByLabelText('Filter skills') as HTMLInputElement).value).toBe('')
    expect(within(reopened).getAllByRole('radio')).toHaveLength(2)
    expect((within(reopened).getByRole('radio', { name: /om-review/ }) as HTMLInputElement).checked).toBe(false)
    expect((within(reopened).getByRole('button', { name: 'Add selected skill' }) as HTMLButtonElement).disabled).toBe(true)
  })

  it('cancels import, clears the error and paste, then clears the successful paste too', async () => {
    stubFetch({ 'POST /api/v1/workflows/parse': [
      () => jsonResponse({ error: 'Invalid workflow' }, 400),
      () => jsonResponse({ name: 'recovered', description: 'Imported description', steps: [SHIP.steps[1]!] }),
    ] })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    const open = () => fireEvent.click(document.querySelector('[data-slot="wb-import"]')!)
    open()
    expect((screen.getByLabelText('Workflow YAML to import') as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('Workflow YAML to import'), { target: { value: 'invalid' } })
    fireEvent.click(document.querySelector('[data-slot="wb-import-run"]')!)
    await screen.findByText('Invalid workflow')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    expect((screen.getByLabelText('Workflow YAML to import') as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByLabelText('Workflow YAML to import'), { target: { value: 'name: recovered' } })
    fireEvent.click(document.querySelector('[data-slot="wb-import-run"]')!)
    await waitFor(() => expect(nameInput().value).toBe('recovered'))
    expect((screen.getByLabelText('Description') as HTMLTextAreaElement).value).toBe('Imported description')
    expect(screen.queryByRole('dialog')).toBeNull()
    open()
    expect((screen.getByLabelText('Workflow YAML to import') as HTMLTextAreaElement).value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('cancels a proposed chain and clears the brief on cancel and on success', async () => {
    stubFetch({ 'POST /api/v1/plan': [() => jsonResponse({ steps: [QUICK.steps[0]!], fallback: false })] })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    const open = () => fireEvent.click(document.querySelector('[data-slot="wb-auto"]')!)
    open()
    expect((screen.getByLabelText('Describe the chain to build') as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('Describe the chain to build'), { target: { value: 'discard this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByLabelText('Describe the chain to build')).toBeNull()
    expect(stepIds()).toEqual(['om-fix', 'om-review'])
    open()
    expect((screen.getByLabelText('Describe the chain to build') as HTMLTextAreaElement).value).toBe('')
    fireEvent.change(screen.getByLabelText('Describe the chain to build'), { target: { value: 'build this' } })
    fireEvent.click(screen.getByRole('button', { name: 'Build chain' }))
    await screen.findByText('Built "ship-it" — review, tweak, then Save.')
    expect(screen.queryByLabelText('Describe the chain to build')).toBeNull()
    open()
    expect((screen.getByLabelText('Describe the chain to build') as HTMLTextAreaElement).value).toBe('')
  })

  it.each(['overwrite', 'delete'] as const)('dismissing %s keeps the draft and makes no write', async (action) => {
    const sent = stubFetch({ 'POST /api/v1/workflows': [() => jsonResponse({ error: 'Exists', exists: true }, 409)] })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    fireEvent.click(document.querySelector(`[data-slot="wb-${action === 'overwrite' ? 'save' : 'delete'}"]`)!)
    const dialog = await screen.findByRole('alertdialog')
    // Fake time drains mutation callbacks; the refused write cannot arrive after the assertion.
    vi.useFakeTimers()
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep the file' }))
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(stepIds()).toEqual(['om-fix', 'om-review'])
    expect(sent.filter((r) => r.method !== 'GET')).toHaveLength(action === 'overwrite' ? 1 : 0)
  })
})

describe('workflow failures and submission guards', () => {
  it('shows a workflow catalog error instead of the editor', async () => {
    stubFetch({ 'GET /api/v1/workflows': [() => jsonResponse({ error: 'Cannot read workflows' }, 403)] })
    renderAt('/workflows')
    await screen.findByText('Could not load workflows')
    expect(screen.getByText('Cannot read workflows')).toBeTruthy()
    expect(screen.queryByLabelText('Workflow name')).toBeNull()
  })

  it.each(['save', 'auto', 'delete'] as const)('reports a %s failure with a danger status and keeps the draft', async (action) => {
    const endpoint = { save: 'POST /api/v1/workflows', auto: 'POST /api/v1/plan', delete: 'DELETE /api/v1/workflows/ship-it' }[action]
    stubFetch({ [endpoint]: [() => jsonResponse({ error: 'Read only', exists: false }, 403)] })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    fireEvent.click(document.querySelector(`[data-slot="wb-${action}"]`)!)
    if (action === 'auto') {
      fireEvent.change(screen.getByLabelText('Describe the chain to build'), { target: { value: 'build chain' } })
      fireEvent.click(screen.getByRole('button', { name: 'Build chain' }))
    }
    if (action === 'delete') fireEvent.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Delete workflow' }))
    expect((await screen.findByText('Read only')).closest('[role="status"]')?.getAttribute('data-tone')).toBe('danger')
    expect(screen.queryByRole('alertdialog')).toBeNull()
    expect(nameInput().value).toBe('ship-it')
    expect(stepIds()).toEqual(['om-fix', 'om-review'])
  })

  it('focuses a blank name without submitting, and recognises a padded saved name', async () => {
    const sent = stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    fireEvent.change(nameInput(), { target: { value: '  ship-it  ' } })
    expect(document.querySelector('[data-slot="wb-delete"]')).toBeTruthy()
    fireEvent.change(nameInput(), { target: { value: '  ' } })
    vi.useFakeTimers()
    fireEvent.click(document.querySelector('[data-slot="wb-save"]')!)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(document.activeElement).toBe(nameInput())
    expect(sent.filter((r) => r.method === 'POST')).toEqual([])
  })

  it('ignores whitespace-only import and keyboard auto requests', async () => {
    const sent = stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    vi.useFakeTimers()
    fireEvent.click(document.querySelector('[data-slot="wb-import"]')!)
    fireEvent.change(screen.getByLabelText('Workflow YAML to import'), { target: { value: ' \n ' } })
    fireEvent.click(document.querySelector('[data-slot="wb-import-run"]')!)
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(sent.filter((r) => r.method === 'POST')).toEqual([])
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    fireEvent.click(document.querySelector('[data-slot="wb-auto"]')!)
    const brief = screen.getByLabelText('Describe the chain to build')
    fireEvent.change(brief, { target: { value: ' \n ' } })
    fireEvent.keyDown(brief, { key: 'Enter', ctrlKey: true })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(sent.filter((r) => r.method === 'POST')).toEqual([])
  })

  it('trims a brief and refuses a second keyboard request while the planner is pending', async () => {
    let finish!: (response: Response) => void
    const response = new Promise<Response>((resolve) => { finish = resolve })
    const sent = stubFetch({ 'POST /api/v1/plan': [() => response] })
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    fireEvent.click(document.querySelector('[data-slot="wb-auto"]')!)
    const brief = screen.getByLabelText('Describe the chain to build')
    fireEvent.change(brief, { target: { value: '  test then review  ' } })
    fireEvent.keyDown(brief, { key: 'Enter', ctrlKey: true })
    await screen.findByRole('button', { name: 'Building…' })
    vi.useFakeTimers()
    fireEvent.keyDown(brief, { key: 'Enter', ctrlKey: true })
    await act(() => vi.advanceTimersByTimeAsync(0))
    expect(sent.filter((r) => r.path === '/api/v1/plan')).toEqual([
      { path: '/api/v1/plan', method: 'POST', body: { task: 'test then review' } },
    ])
    await act(async () => {
      finish(jsonResponse({ name: 'planned', steps: [QUICK.steps[0]!], fallback: false }))
      await vi.advanceTimersByTimeAsync(0)
    })
    expect(nameInput().value).toBe('planned')
  })
})

/** jsdom has no layout. Model 100px cards with the canvas's gap-4 (16px) between them.
 * The canvas fits those cards; its absolute tail indicator adds no height or padding.
 * An empty canvas instead fits the padded drop hint. */
function layOutWorkflow() {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
    const ids = canvasIds()
    const card = this.closest('li')?.querySelector<HTMLElement>('[data-slot="wb-step"]')
    const palette = this.closest<HTMLElement>('[data-slot="wb-skill"]')
    if (card) {
      const index = ids.indexOf(card.dataset.id)
      return new DOMRect(0, index * 116, 400, 100)
    }
    if (this.matches('[data-slot="wb-steps"]')) {
      const height = ids.length === 0 ? 100 : ids.length * 100 + (ids.length - 1) * 16
      return new DOMRect(0, 0, 400, height)
    }
    if (palette) return new DOMRect(600, palette.dataset.skill === 'om-fix' ? 0 : 60, 200, 44)
    // DragOverlay measures its fixed wrapper, whose inline dimensions come from the source.
    const overlay = this.parentElement
    if (overlay?.style.position === 'fixed') {
      return new DOMRect(Number.parseFloat(overlay.style.left), Number.parseFloat(overlay.style.top),
        Number.parseFloat(overlay.style.width), Number.parseFloat(overlay.style.height))
    }
    return new DOMRect(0, 0, 0, 0)
  })
  // PointerSensor reads the standard pointer fields; jsdom has no PointerEvent constructor.
  class TestPointerEvent extends MouseEvent {
    readonly isPrimary = true
    readonly pointerId = 1
    readonly pointerType = 'mouse'
  }
  vi.stubGlobal('PointerEvent', TestPointerEvent)
  vi.useFakeTimers()
}

async function dragKey(target: HTMLElement, code: string) {
  await act(async () => {
    fireEvent.keyDown(target, { code, key: code === 'Space' ? ' ' : code })
    // Advance the sensor's listener attachment and animation frames, without real-time sleeps.
    await vi.advanceTimersByTimeAsync(20)
  })
}

async function pointerMove(x: number, y: number) {
  act(() => { fireEvent.pointerMove(document, { clientX: x, clientY: y }) })
  await act(() => vi.advanceTimersByTimeAsync(20))
}

async function dropPointer() {
  await act(async () => {
    fireEvent.pointerUp(document)
    await vi.advanceTimersByTimeAsync(300)
  })
}

const canvas = () => document.querySelector<HTMLElement>('[data-slot="wb-steps"]')!
const canvasIds = () => [...canvas().querySelectorAll<HTMLElement>('[data-slot="wb-step"]')].map((card) => card.dataset.id)
const dropLine = () => document.querySelector<HTMLElement>('[data-slot="wb-drop-line"]')

async function liftPalette() {
  const pill = document.querySelector<HTMLElement>('[data-slot="wb-skill"][data-skill="om-review"]')!
  fireEvent.pointerDown(pill, { button: 0, clientX: 610, clientY: 82 })
  await pointerMove(620, 82)
  expect(canvas().getAttribute('data-dragging')).toBe('true')
}

describe('workflow drag and drop through real sensors', () => {
  it('moves a step from the keyboard and removes the insert indicator after the drop', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    layOutWorkflow()
    const grip = screen.getByRole('button', { name: 'Reorder step 1: om-fix' })
    grip.focus()
    expect(canvas().hasAttribute('data-dragging')).toBe(false)
    expect(dropLine()).toBeNull()
    await dragKey(grip, 'Space')
    expect(grip.getAttribute('aria-pressed')).toBe('true')
    expect(canvas().getAttribute('data-dragging')).toBe('true')
    expect(dropLine()).toBeNull() // The active card is never its own insertion target.
    await dragKey(grip, 'ArrowDown')
    expect(dropLine()?.parentElement?.querySelector<HTMLElement>('[data-slot="wb-step"]')?.dataset.id).toBe('om-review')
    await dragKey(grip, 'Space')
    await act(() => vi.advanceTimersByTimeAsync(300))
    expect(canvasIds()).toEqual(['om-review', 'om-fix'])
    expect(stepIds()).toEqual(['om-review', 'om-fix'])
    expect(yamlText().indexOf('- om-review')).toBeLessThan(yamlText().indexOf('- om-fix'))
    expect(canvas().hasAttribute('data-dragging')).toBe(false)
    expect(dropLine()).toBeNull()
  })

  it('cancels a move with Escape and leaves both execution order and indicators unchanged', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    layOutWorkflow()
    const grip = screen.getByRole('button', { name: 'Reorder step 1: om-fix' })
    grip.focus()
    await dragKey(grip, 'Space')
    await dragKey(grip, 'ArrowDown')
    expect(dropLine()).toBeTruthy()
    await dragKey(grip, 'Escape')
    expect(canvasIds()).toEqual(['om-fix', 'om-review'])
    expect(stepIds()).toEqual(['om-fix', 'om-review'])
    expect(canvas().hasAttribute('data-dragging')).toBe(false)
    expect(dropLine()).toBeNull()
  })

  it('copies a palette skill before a hovered card instead of appending it', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    layOutWorkflow()
    await liftPalette()
    await pointerMove(110, 166)
    expect(dropLine()?.parentElement?.querySelector<HTMLElement>('[data-slot="wb-step"]')?.dataset.id).toBe('om-review')
    await dropPointer()
    expect(stepIds()).toEqual(['om-fix', 'om-review-2', 'om-review'])
    expect(canvas().hasAttribute('data-dragging')).toBe(false)
    expect(dropLine()).toBeNull()
  })

  it('copies a palette skill into an empty canvas', async () => {
    stubFetch({}, [QUICK])
    renderAt('/workflows')
    await screen.findByText('Drop a skill here — or Import a workflow.yaml')
    layOutWorkflow()
    await liftPalette()
    await pointerMove(110, 50)
    expect(dropLine()).toBeNull()
    await dropPointer()
    expect(stepIds()).toEqual(['om-review'])
    expect(screen.queryByText('Drop a skill here — or Import a workflow.yaml')).toBeNull()
    expect(canvas().hasAttribute('data-dragging')).toBe(false)
  })

  it('moves a step to the last card when dropped below the content-sized canvas', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    layOutWorkflow()
    const grip = screen.getByRole('button', { name: 'Reorder step 1: om-fix' })
    fireEvent.pointerDown(grip, { button: 0, clientX: 10, clientY: 50 })
    await pointerMove(20, 50)
    await pointerMove(10, 300)
    // closestCenter keeps the last card as the nearest target even below its bottom edge.
    expect(dropLine()?.parentElement?.querySelector<HTMLElement>('[data-slot="wb-step"]')?.dataset.id).toBe('om-review')
    await dropPointer()
    expect(stepIds()).toEqual(['om-review', 'om-fix'])
    expect(canvas().hasAttribute('data-dragging')).toBe(false)
  })

  it('Move up returns a step to its earlier position', async () => {
    stubFetch()
    renderAt('/workflows')
    await waitFor(() => expect(stepCards()).toHaveLength(2))
    fireEvent.click(screen.getByLabelText('Move step 2 up'))
    expect(stepIds()).toEqual(['om-review', 'om-fix'])
  })
})
