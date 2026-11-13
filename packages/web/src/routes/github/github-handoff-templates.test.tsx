import { jsonResponse, stubFetch, promptField, promptValue, BASE, baseWith, openDetail } from './github.testkit'

import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetToasts } from '@/components/ui/toaster'


import { ListViewportResizeObserver } from './github-geometry.testkit'

beforeAll(() => {
  // cmdk scrolls the selected item into view; jsdom has no scrollIntoView.
  Element.prototype.scrollIntoView = vi.fn()
})

beforeEach(() => {
  // Radix popovers position with floating-ui, which needs a ResizeObserver; jsdom has none. The
  // list's scroll owner gets a tall viewport so the virtualized rows mount (hearsay-tools/cezarion#1183).
  vi.stubGlobal('ResizeObserver', ListViewportResizeObserver)
  // The #408 follow-up persistence (remembered selection + per-item draft) is localStorage-
  // backed and jsdom's localStorage survives across tests in this file — start every test clean.
  localStorage.clear()
})

afterEach(() => {
  act(() => resetToasts())
  cleanup()
  vi.unstubAllGlobals()
})

describe('the follow-up prompt template menu (#413)', () => {
  /** The menu is a Popover + cmdk (like the skills picker beside it), so it opens on click. */
  async function openTemplateMenu(): Promise<void> {
    fireEvent.click(document.querySelector('[data-slot="prompt-template-trigger"]')!)
    await waitFor(() =>
      expect(document.querySelector('[data-slot="prompt-template-option"]')).not.toBeNull(),
    )
  }

  const option = (id: string) =>
    document.querySelector<HTMLElement>(`[data-slot="prompt-template-option"][data-template="${id}"]`)

  /**
   * Click a mounted template option until the select provably lands. A re-render (the
   * ui-state query resolving, a queries invalidation) can replace the option node between
   * querying it and clicking it — a click on the detached node is a silent no-op, the race
   * that made this suite flake (#413). Selecting closes the menu (`onSelect` →
   * `setOpen(false)`), so re-query a FRESH node each retry and stop only once the options
   * unmount: the insert has provably happened.
   */
  async function selectOption(id: string): Promise<void> {
    await waitFor(() => {
      const node = option(id)
      if (!node) return // menu closed — the select landed
      fireEvent.click(node)
      throw new Error(`template option "${id}" still mounted — select has not landed yet`)
    })
  }

  /**
   * Open the menu and click a specific template. Waits for *that* option to
   * mount before clicking it, so a stale option from the previous (closing)
   * popover can never satisfy the wait while the wanted one is still absent —
   * the race that made this suite flake in CI (#413).
   */
  async function chooseTemplate(id: string): Promise<void> {
    const textarea = () => screen.getByLabelText('Custom prompt') as HTMLTextAreaElement
    const before = textarea().value
    fireEvent.click(document.querySelector('[data-slot="prompt-template-trigger"]')!)
    await waitFor(() => {
      if (!option(id)) throw new Error(`template option "${id}" not mounted yet`)
    })
    await selectOption(id)
    // Insertion restores the textarea caret on the next animation frame. Opening the
    // next popover before that focus lands lets the old restoration dismiss it; an
    // unmounted option alone does not prove that the second insertion happened.
    await waitFor(() => expect(textarea().value).not.toBe(before))
    await waitFor(() => expect(document.activeElement).toBe(textarea()))
  }

  it('an untouched ui-state shows the built-in templates, and inserting one fills the custom prompt', async () => {
    stubFetch()
    await openDetail()

    await openTemplateMenu()
    expect(document.querySelectorAll('[data-slot="prompt-template-option"]').length).toBeGreaterThan(1)
    expect(option('add-tests')).not.toBeNull()

    await selectOption('add-tests')
    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith('Also add or update tests covering this change.'),
      ),
    )
  })

  it('a user-edited ui-state templates list replaces the built-ins in the menu', async () => {
    stubFetch({
      'GET /api/v1/ui-state': () =>
        jsonResponse({ promptTemplates: [{ id: 'custom-1', label: 'My snippet', text: 'Custom instructions.' }] }),
    })
    await openDetail()

    await openTemplateMenu()
    expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(1)
    expect(option('custom-1')?.textContent).toContain('My snippet')

    await selectOption('custom-1')
    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith('Custom instructions.'),
      ),
    )
  })

  it('inserting a second template stacks it below the first, separated by a blank line', async () => {
    stubFetch()
    await openDetail()

    await chooseTemplate('add-tests')
    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith('Also add or update tests covering this change.'),
      ),
    )

    await chooseTemplate('update-docs')

    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith(
          'Also add or update tests covering this change.\n\nAlso update any relevant documentation or comments.',
        ),
      ),
    )
  })

  it('a second insert still stacks when the menu blur reports selectionStart 0 (#221)', async () => {
    stubFetch()
    await openDetail()

    await chooseTemplate('add-tests')
    await waitFor(() =>
      expect(promptValue()).toBe(baseWith('Also add or update tests covering this change.')),
    )

    const field = promptField()
    field.blur()
    field.setSelectionRange(0, 0)
    expect(field.selectionStart).toBe(0)

    await chooseTemplate('update-docs')
    await waitFor(() =>
      expect(promptValue()).toBe(
        baseWith(
          'Also add or update tests covering this change.\n\nAlso update any relevant documentation or comments.',
        ),
      ),
    )
  })

  it('an EDITED box honours the caret — a template lands mid-text, not appended (#524)', async () => {
    // The pre-fill (#524) means an untouched box must append rather than splice above the
    // reference, but that must not cost `insertTemplate`'s documented mid-text case: the user
    // clicked back into the box to fix a typo, then picked a template.
    stubFetch()
    await openDetail()

    fireEvent.change(promptField(), { target: { value: 'ALPHA OMEGA' } })
    await waitFor(() => expect(promptValue()).toBe('ALPHA OMEGA'))
    promptField().setSelectionRange(5, 5)

    await chooseTemplate('add-tests')
    await waitFor(() =>
      expect(promptValue()).toBe(
        'ALPHA\n\nAlso add or update tests covering this change.\n\nOMEGA',
      ),
    )
  })

  it('the menu is searchable — typing narrows it to the matching template', async () => {
    stubFetch()
    await openDetail()

    await openTemplateMenu()
    const all = document.querySelectorAll('[data-slot="prompt-template-option"]').length
    expect(all).toBeGreaterThan(1)

    fireEvent.change(screen.getByPlaceholderText('search templates…'), { target: { value: 'docs' } })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(1),
    )
    expect(option('update-docs')).not.toBeNull()
  })

  it('search matches a template by its TEXT, not just the label someone gave it', async () => {
    stubFetch()
    await openDetail()

    await openTemplateMenu()
    // "unrelated refactors" appears only in the body of the keep-minimal template.
    fireEvent.change(screen.getByPlaceholderText('search templates…'), {
      target: { value: 'unrelated refactors' },
    })
    await waitFor(() =>
      expect(document.querySelectorAll('[data-slot="prompt-template-option"]')).toHaveLength(1),
    )
    expect(option('keep-minimal')).not.toBeNull()
  })
})

describe('templates assigned to a skill auto-apply when a skill is picked', () => {
  const ASSIGNED = {
    'GET /api/v1/ui-state': () =>
      jsonResponse({
        promptTemplates: [
          { id: 'assigned', label: 'Fix rules', text: 'Follow the fix rules.', skills: ['om-fix'] },
          { id: 'manual', label: 'Manual', text: 'Never auto.' },
        ],
      }),
  }

  /** Toggle a skill. The picker is multi-select and STAYS open after a toggle, so only open it
   *  when it is not already showing — clicking the trigger again would close it instead. */
  const pickSkill = async (name: string) => {
    const selector = `[data-slot="gh-skill-option"][data-skill="${name}"]`
    if (document.querySelector(selector) === null) {
      fireEvent.click(document.querySelector('[data-slot="gh-skills-trigger"]')!)
      await waitFor(() => expect(document.querySelector(selector)).not.toBeNull())
    }
    fireEvent.click(document.querySelector(selector)!)
  }

  it('fills an untouched prompt box with the assigned template, and only that one', async () => {
    stubFetch(ASSIGNED)
    await openDetail()

    await pickSkill('om-fix')
    // Stacked BELOW the pre-filled reference (#524) — auto-apply adds to the item context, it
    // never replaces it, the same rule the composed task text follows.
    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith('Follow the fix rules.'),
      ),
    )
  })

  it('deselecting the skill takes the auto-applied text back out again, leaving the reference', async () => {
    stubFetch(ASSIGNED)
    await openDetail()

    await pickSkill('om-fix')
    await waitFor(() =>
      expect(screen.getByLabelText('Custom prompt')).toHaveProperty(
        'value',
        baseWith('Follow the fix rules.'),
      ),
    )

    await pickSkill('om-fix')
    // Back to the pre-fill, NOT to empty: deselecting a skill must not strip the item context.
    await waitFor(() => expect(screen.getByLabelText('Custom prompt')).toHaveProperty('value', BASE))
  })

  it('NEVER overwrites a prompt the user already typed in', async () => {
    stubFetch(ASSIGNED)
    await openDetail()

    fireEvent.change(screen.getByLabelText('Custom prompt'), { target: { value: 'my own words' } })
    await pickSkill('om-fix')

    // Give the effect every chance to misbehave before asserting it did not.
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-skill-chip"][data-skill="om-fix"]')).not.toBeNull(),
    )
    expect(screen.getByLabelText('Custom prompt')).toHaveProperty('value', 'my own words')
  })

  it('a skill with no template assigned to it leaves the box alone', async () => {
    stubFetch(ASSIGNED)
    await openDetail()

    await pickSkill('g-review')
    await waitFor(() =>
      expect(document.querySelector('[data-slot="gh-skill-chip"][data-skill="g-review"]')).not.toBeNull(),
    )
    expect(screen.getByLabelText('Custom prompt')).toHaveProperty('value', BASE)
  })
})
