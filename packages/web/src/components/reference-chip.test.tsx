import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

import type { ReferenceStatus } from '@open-mercato/cezar-api-client'

import { ReferenceChip, useCloseReferenceCard } from './reference-chip'
import { REFERENCE_CONFLICT, REFERENCE_STATUS } from '@/lib/reference-status'

beforeAll(() => {
  // Radix's tooltip arrow measures itself with a ResizeObserver; jsdom has none and never lays
  // anything out.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  )
})

afterEach(cleanup)

const PR = { kind: 'PR' as const, number: 402, url: 'https://github.com/o/r/pull/402' }

/** The one panel every chip opens — a popover, hover-driven, since it had to hold a button
 *  without costing the chip its own tap and keyboard behaviour. */
const panelText = () => document.querySelector('[data-slot="reference-status-card"]')?.textContent ?? ''

function chipOf(ui: React.ReactElement) {
  const { container } = render(ui)
  const chip = container.querySelector('[data-slot="pr-chip"], [data-slot="issue-chip"]')
  if (!chip) throw new Error('ReferenceChip did not render')
  return chip
}

describe('ReferenceChip without a status', () => {
  it('is the neutral brand chip, with the URL as its native tooltip', () => {
    // The pre-status treatment, unchanged: nothing is known about the PR, so nothing is claimed.
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="Add checkout" />)

    expect(chip.getAttribute('data-status')).toBeNull()
    expect(chip.className).toContain('text-accent-text')
    expect(chip.getAttribute('title')).toBe('https://github.com/o/r/pull/402')
    expect(chip.textContent).toBe('#402')
  })

  it('carries no status glyph', () => {
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="Add checkout" />)
    expect(chip.querySelector('[data-slot="status-dot"]')).toBeNull()
  })
})

describe('ReferenceChip with a status', () => {
  it('paints the tone, the icon and the state — three channels, not one', () => {
    // Color alone is invisible to a colorblind reader and an icon alone is a rebus, so the
    // status has to reach the accessible name too.
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="Add checkout" status="checks-failing" />)

    expect(chip.getAttribute('data-status')).toBe('checks-failing')
    expect(chip.className).toContain('text-danger')
    expect(chip.querySelector('svg')).not.toBeNull()
    expect(chip.getAttribute('aria-label')).toContain('Checks failing')
  })

  it.each([
    ['merged', 'text-merged-text'],
    ['ready', 'text-success'],
    ['review-required', 'text-info'],
    ['changes-requested', 'text-danger'],
    ['closed', 'text-danger'],
    ['draft', 'text-muted-foreground'],
    ['open', 'text-success'],
    ['completed', 'text-accent-text'],
    ['not-planned', 'text-muted-foreground'],
  ] as const)('paints %s with the %s tone', (status, tone) => {
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status={status} />)
    expect(chip.className).toContain(tone)
  })

  it('keeps merged on reserved purple and completed on brand accent', () => {
    expect(REFERENCE_STATUS.merged.tone).toBe('merged')
    expect(REFERENCE_STATUS.completed.tone).toBe('accent')
    const merged = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="merged" />)
    cleanup()
    const completed = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="completed" />)
    expect(merged.className).toContain('text-merged-text')
    expect(merged.className).not.toContain('text-accent-text')
    expect(completed.className).toContain('text-accent-text')
    expect(completed.className).not.toContain('text-merged-text')
  })

  it('does not paint "waiting for review" the same as "merged"', () => {
    // They were both violet, which read as two shades of done — where one of them is the opposite
    // of done: it is waiting on a person.
    const toneOf = (status: 'review-required' | 'merged') =>
      chipOf(<ReferenceChip reference={PR} taskTitle="t" status={status} />).className
    const waiting = toneOf('review-required')
    cleanup()
    const merged = toneOf('merged')
    expect(waiting).not.toBe(merged)
    expect(waiting).not.toContain('text-accent-text')
  })

  it('turns the WHOLE chip amber while checks run, and uses the exact pulsing circle glyph', () => {
    // A neutral chip with one coloured dot reads as neutral when a table is scanned; the state
    // worth seeing at a glance is "something is happening to this right now".
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="checks-pending" />)
    const dot = chip.querySelector('[data-slot="status-dot"]')

    expect(chip.className).toContain('text-pending-strong')
    expect(dot?.getAttribute('data-tone')).toBe('pending')
    expect(dot?.getAttribute('class')).toContain('animate-pulse')
    expect(dot?.getAttribute('data-design-icon')).toBe('circle')
  })

  it('writes that amber with the INK token, not the dot fill', () => {
    // `--pending` is amber-400 in both themes and fails contrast as text on the light one, which
    // is what the design guardian's `no-amber-text` rule is protecting.
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="checks-pending" />)
    expect(chip.className).not.toMatch(/\btext-pending\b(?!-strong)/)
  })

  it('drops the native title so the two tooltips cannot fight', () => {
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="merged" />)
    expect(chip.getAttribute('title')).toBeNull()
    expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/402')
  })

  it('explains the status in words before the chip is ever clicked', async () => {
    render(<ReferenceChip reference={PR} taskTitle="t" status="changes-requested" />)
    // Focus, not hover: it is the one trigger every input method shares, and it opens on it.
    fireEvent.focus(screen.getByRole('link'))

    await waitFor(() => {
      expect(panelText()).toContain(REFERENCE_STATUS['changes-requested'].hint)
    })
  })

  it('renders a status from a LATER version as the neutral chip rather than throwing', () => {
    // The vocabulary is additive by contract (BACKWARD_COMPATIBILITY.md, `/github/ref-status`):
    // "an unknown one renders neutral". Two real paths reach this bundle with a value it has
    // never heard of — a newer server answering an older tab, and a `sessionStorage` payload a
    // newer cockpit wrote in this same tab — and each used to be a `TypeError` inside the
    // accessible name, which takes the whole table down rather than the one chip.
    const chip = chipOf(
      <ReferenceChip reference={PR} taskTitle="Add checkout" status={'queued-for-merge' as ReferenceStatus} />,
    )

    expect(chip.className).toContain('text-accent-text')
    expect(chip.querySelector('svg[data-slot="status-dot"]')).toBeNull()
    // The neutral chip's own tooltip, not a described status: the URL, exactly as before statuses.
    expect(chip.getAttribute('title')).toBe('https://github.com/o/r/pull/402')
    expect(chip.getAttribute('aria-label')).toBe('Open the pull request for Add checkout')
  })

  it('keeps a non-http reference inert while still saying where it stands', () => {
    // #431: a transcript-scraped `javascript:` URL degrades to text — it must not gain a link
    // just because a status arrived.
    const chip = chipOf(
      <ReferenceChip
        reference={{ kind: 'Issue', number: 12, url: 'javascript:void(0)' }}
        taskTitle="t"
        status="completed"
      />,
    )
    expect(chip.tagName).toBe('SPAN')
    expect(chip.getAttribute('data-status')).toBe('completed')
  })
})

describe('ReferenceChip on a pull request that will not merge', () => {
  it('takes the chip over — its own colour, not a second chip and not a shade of red', () => {
    // The reported case: `ready` is still the honest answer to "whose move is it on the review",
    // and it was painting green next to a pull request GitHub was refusing to merge. The chip that
    // LINKS to the PR is the one that has to say so, in a colour no other status wears.
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="ready" conflicting />)

    expect(chip.className).toContain('text-conflict')
    expect(chip.className).not.toContain('text-success')
    // Not red either: `danger` already means "checks failed" and "changes requested" here.
    expect(chip.className).not.toContain('text-danger')
    expect(chip.getAttribute('data-conflicting')).toBe('true')
    expect(chip.getAttribute('aria-label')).toContain(REFERENCE_CONFLICT.label)
  })

  it('keeps the status it painted over, in the attribute and in the tooltip', async () => {
    // Both axes are true at once. The colour can only carry one, so the other is still said —
    // losing "the checks are green" would be the same defect one level down.
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="ready" conflicting />)
    expect(chip.getAttribute('data-status')).toBe('ready')

    fireEvent.focus(screen.getByRole('link'))
    await waitFor(() => {
      expect(panelText()).toContain(REFERENCE_CONFLICT.hint)
      expect(panelText()).toContain(REFERENCE_STATUS.ready.hint)
    })
  })

  it('swaps the glyph too, including the pulsing dot of a PR whose checks are still running', () => {
    // Colour is invisible to a colourblind reader, so the icon has to move with it — and a branch
    // that will not merge is not a state that is still moving.
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="checks-pending" conflicting />)

    expect(chip.querySelector('[data-slot="status-dot"]')).toBeNull()
    expect(chip.querySelector('svg')).not.toBeNull()
  })

  it('says nothing at all until the forge says CONFLICTING', () => {
    // Absent is not `false` (contract: a missing `conflicts` means "nothing is known about
    // mergeability"). A chip that coloured itself on silence would invent the one answer this
    // axis must never invent.
    for (const conflicting of [undefined, false]) {
      const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status="ready" conflicting={conflicting} />)
      expect(chip.className).toContain('text-success')
      expect(chip.getAttribute('data-conflicting')).toBeNull()
      cleanup()
    }
  })

  it('never speaks for an issue, which has no base branch to conflict with', () => {
    const chip = chipOf(
      <ReferenceChip reference={{ kind: 'Issue', number: 12 }} taskTitle="t" status="open" conflicting />,
    )
    expect(chip.className).not.toContain('text-conflict')
    expect(chip.getAttribute('data-conflicting')).toBeNull()
  })
})

describe('the conflict chip’s offered action', () => {
  /** A stand-in for whatever a surface hands the panel — the chip is not supposed to know. */
  function Probe({ onMount }: { onMount?: () => void }) {
    const close = useCloseReferenceCard()
    onMount?.()
    return (
      <button type="button" onClick={close}>
        Resolve conflicts
      </button>
    )
  }

  const openPanel = async () => {
    // Focus, not hover: it is the trigger every input method shares, and it is what makes the
    // button reachable from the keyboard at all.
    fireEvent.focus(screen.getByRole('link'))
    return waitFor(() => screen.getByRole('button', { name: 'Resolve conflicts' }))
  }

  it('leaves the chip’s own link alone — no cancelled taps on a touch device', async () => {
    // The regression this panel was rebuilt for. Radix's hover card, which it used to be, calls
    // `preventDefault()` on `touchstart` in its TRIGGER — deliberately, because a hover card is
    // for pointers — and on a chip that IS a link that means a tap stops opening the pull request.
    // A popover ANCHOR attaches no handlers at all, which is why the chip keeps every native
    // behaviour it had before any of this existed.
    render(<ReferenceChip reference={PR} taskTitle="t" status="ready" conflicting conflictAction={<Probe />} />)
    const link = screen.getByRole('link')
    const touch = new Event('touchstart', { bubbles: true, cancelable: true })
    link.dispatchEvent(touch)

    expect(touch.defaultPrevented).toBe(false)
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/402')
  })

  it('keeps the button reachable by keyboard, in the panel and in the tab order', async () => {
    // The other half: the hover card re-wrote `tabindex="-1"` onto everything focusable inside it
    // on every render, so this button was pointer-only. And because the panel is portalled, Tab
    // from the chip would sail past it — so the chip hands focus over itself.
    render(<ReferenceChip reference={PR} taskTitle="t" status="ready" conflicting conflictAction={<Probe />} />)
    const link = screen.getByRole('link')
    fireEvent.focus(link)
    const button = await waitFor(() => screen.getByRole('button', { name: 'Resolve conflicts' }))

    expect(button.getAttribute('tabindex')).not.toBe('-1')
    fireEvent.keyDown(link, { key: 'Tab' })
    await waitFor(() => expect(document.activeElement).toBe(button))
  })

  it('does not touch the tab order of a chip with nothing to press', async () => {
    // Several hundred chips in the cockpit are this one. Intercepting Tab for them would move
    // focus into a panel of words and out of the reading order the page already had.
    render(<ReferenceChip reference={PR} taskTitle="t" status="ready" />)
    const link = screen.getByRole('link')
    fireEvent.focus(link)
    await waitFor(() => expect(panelText()).toContain(REFERENCE_STATUS.ready.hint))

    const tab = fireEvent.keyDown(link, { key: 'Tab' })
    expect(tab).toBe(true) // not prevented — the browser's own tab order stands
  })

  it('offers it in a panel the pointer can actually reach', async () => {
    // A tooltip closes the moment the pointer leaves the chip and takes any control with it, so a
    // chip with something to press has to open a hover CARD instead. Everything the tooltip said
    // is still in it.
    render(<ReferenceChip reference={PR} taskTitle="t" status="ready" conflicting conflictAction={<Probe />} />)
    await openPanel()

    const card = document.querySelector('[data-slot="reference-status-card"]')
    expect(card?.textContent).toContain(REFERENCE_CONFLICT.hint)
    expect(card?.textContent).toContain(REFERENCE_STATUS.ready.hint)
    expect(document.querySelector('[data-slot="reference-status-tooltip"]')).toBeNull()
  })

  it('lets the action shut the panel once its work is done', async () => {
    // Left open, a panel whose button is spent invites a second press of something that has
    // already happened. The chip owns the panel, so it is the chip that offers the way out.
    render(<ReferenceChip reference={PR} taskTitle="t" status="ready" conflicting conflictAction={<Probe />} />)
    fireEvent.click(await openPanel())

    await waitFor(() => expect(screen.queryByRole('button', { name: 'Resolve conflicts' })).toBeNull())
  })

  it('mounts it only when the panel opens — never just because a row was painted', async () => {
    // Load-bearing, not an optimisation: the action carries a run delivery with it, and a
    // hundred-row table that built one per row would need a react-query client to paint chips
    // nobody has hovered.
    const onMount = vi.fn()
    render(
      <ReferenceChip reference={PR} taskTitle="t" status="ready" conflicting conflictAction={<Probe onMount={onMount} />} />,
    )
    expect(onMount).not.toHaveBeenCalled()

    await openPanel()
    expect(onMount).toHaveBeenCalled()
  })

  it('leaves a chip that is NOT conflicting with the panel and nothing in it', async () => {
    // The action is offered by the surface, not by the state: a green PR gets the same panel every
    // chip gets, and no button — the surface would have had one ready if it had gone red.
    const onMount = vi.fn()
    render(<ReferenceChip reference={PR} taskTitle="t" status="ready" conflictAction={<Probe onMount={onMount} />} />)
    fireEvent.focus(screen.getByRole('link'))

    await waitFor(() => expect(panelText()).toContain(REFERENCE_STATUS.ready.hint))
    expect(screen.queryByRole('button', { name: 'Resolve conflicts' })).toBeNull()
    expect(onMount).not.toHaveBeenCalled()
  })
})

describe('ReferenceChip plain (the sidebar meta line, #617)', () => {
  it('keeps the label muted without a chip border, spelling PR #N and #N', () => {
    const pr = chipOf(<ReferenceChip reference={PR} taskTitle="Add checkout" status="checks-failing" plain />)
    expect(pr.textContent).toBe('PR #402')
    expect(pr.className).not.toMatch(/\bborder\b/)
    expect(pr.className).not.toContain('text-accent-text')
    expect(pr.className).not.toContain('text-danger')
    expect(pr.querySelector('svg')).not.toBeNull()
    expect(pr.querySelector('span')?.className).toContain('group-hover/reference:underline')
    expect(pr.querySelector('span')?.className).toContain('group-focus-visible/reference:underline')
    cleanup()
    const issue = chipOf(<ReferenceChip reference={{ kind: 'Issue', number: 451, url: 'https://github.com/o/r/issues/451' }} taskTitle="t" plain />)
    expect(issue.textContent).toBe('#451')
  })

  it('stays a keyboard-reachable link whose name still carries the status', () => {
    render(<ReferenceChip reference={PR} taskTitle="Add checkout" status="checks-failing" plain />)
    const link = screen.getByRole('link', { name: `Open the pull request for Add checkout — ${REFERENCE_STATUS['checks-failing'].label}` })
    expect(link.getAttribute('href')).toBe('https://github.com/o/r/pull/402')
    expect(link.getAttribute('tabindex')).not.toBe('-1')
  })

  it('opens the same status panel on focus', async () => {
    render(<ReferenceChip reference={PR} taskTitle="t" status="changes-requested" plain />)
    fireEvent.focus(screen.getByRole('link'))
    await waitFor(() => {
      expect(panelText()).toContain(REFERENCE_STATUS['changes-requested'].hint)
    })
  })
})


// Literal expectations from #677: a wrong tone, missing glyph or full-chip palette leak fails.
const PLAIN_STATUSES = [
  ['draft', 'git-pull-request-draft', 'text-soft-foreground'],
  ['review-required', 'git-pull-request', 'text-info'],
  ['changes-requested', 'message-square-warning', 'text-danger'],
  ['checks-pending', 'circle', 'text-pending-strong'],
  ['checks-failing', 'circle-x', 'text-danger'],
  ['ready', 'circle-check', 'text-success'],
  ['merged', 'git-merge', 'text-merged-text'],
  ['closed', 'git-pull-request-closed', 'text-danger'],
  ['open', 'circle-dot', 'text-success'],
  ['completed', 'circle-check', 'text-merged-text'],
  ['not-planned', 'circle-slash', 'text-soft-foreground'],
] as const

describe.each([false, true])('plain status visibility (#677), inert=%s', (inert) => {
  it.each(PLAIN_STATUSES)('%s shows its %s glyph in %s', (status, icon, tone) => {
    const kind = ['open', 'completed', 'not-planned'].includes(status) ? 'Issue' : 'PR'
    const chip = chipOf(<ReferenceChip reference={{ ...PR, kind }} taskTitle="t" status={status} plain inert={inert} />)
    const glyph = chip.querySelector('svg')
    expect(glyph?.getAttribute('data-design-icon')).toBe(icon)
    expect(glyph?.getAttribute('class')).toContain(tone)
    expect(glyph?.getAttribute('class')).toContain('size-2.5')
    expect(chip.firstElementChild).toBe(glyph)
    expect(chip.className).toContain('gap-1')
    expect(chip.className).toContain('text-inherit')
    expect(chip.className).not.toMatch(/text-(accent|danger|success|merged|pending|info)/)
    expect(chip.querySelector('span')?.className).not.toMatch(/text-(accent|danger|success|merged|pending|info)/)
    if (status === 'checks-pending') {
      expect(glyph?.getAttribute('class')).toContain('animate-pulse')
      expect(glyph?.getAttribute('class')).toContain('motion-reduce:animate-none')
    }
    if (inert) {
      expect(chip.tagName).toBe('SPAN')
      expect(chip.hasAttribute('href')).toBe(false)
      expect(chip.hasAttribute('tabindex')).toBe(false)
      fireEvent.focus(chip)
      fireEvent.pointerEnter(chip, { pointerType: 'touch' })
      expect(document.querySelector('[data-slot="reference-status-card"]')).toBeNull()
    }
  })

  it('covers the complete status vocabulary', () => {
    expect(PLAIN_STATUSES.map(([status]) => status).sort()).toEqual(Object.keys(REFERENCE_STATUS).sort())
  })

  it.each(['ready', 'checks-pending', undefined, 'future-status'] as const)('conflict overrides %s for both glyph and label', (status) => {
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status={status as ReferenceStatus} conflicting plain inert={inert} />)
    expect(chip.getAttribute('data-conflicting')).toBe('true')
    expect(chip.querySelector('svg')?.getAttribute('data-design-icon')).toBe('triangle-alert')
    expect(chip.className).toContain('text-conflict')
    expect(chip.className).toContain('font-medium')
    expect(chip.querySelector('[data-slot="status-dot"]')).toBeNull()
    expect(chip.className).not.toContain('hover:text-muted-foreground')
  })

  it.each([undefined, 'future-status'] as const)('keeps %s status muted without a glyph', (status) => {
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="t" status={status as ReferenceStatus} plain inert={inert} />)
    expect(chip.querySelector('svg')).toBeNull()
    expect(chip.className).toContain('text-inherit')
    expect(chip.outerHTML).not.toContain('text-accent')
  })
})

describe('ReferenceChip with an in-app destination (#692)', () => {
  it('links to the internal path in the same tab, with the accessible name', () => {
    const chip = chipOf(
      <MemoryRouter>
        <ReferenceChip reference={PR} taskTitle="Add checkout" status="ready" to="/p/api/tasks/r1/pr/402" />
      </MemoryRouter>,
    )

    expect(chip.tagName).toBe('A')
    expect(chip.getAttribute('href')).toBe('/p/api/tasks/r1/pr/402')
    expect(chip.getAttribute('target')).toBeNull()
    expect(chip.getAttribute('aria-label')).toBe('Open the pull request for Add checkout — Ready to merge')
  })

  it('keeps the status panel and its conflict action keyboard-reachable on the router link', async () => {
    render(
      <MemoryRouter>
        <ReferenceChip
          reference={PR}
          taskTitle="t"
          status="ready"
          conflicting
          to="/p/api/tasks/r1/pr/402"
          conflictAction={<button type="button">Resolve conflicts</button>}
        />
      </MemoryRouter>,
    )
    const link = screen.getByRole('link')
    fireEvent.focus(link)
    const button = await waitFor(() => screen.getByRole('button', { name: 'Resolve conflicts' }))

    expect(panelText()).toContain(REFERENCE_CONFLICT.hint)
    expect(panelText()).toContain(REFERENCE_STATUS.ready.hint)
    expect(button.getAttribute('tabindex')).not.toBe('-1')
    fireEvent.keyDown(link, { key: 'Tab' })
    await waitFor(() => expect(document.activeElement).toBe(button))
  })

  it('still opens GitHub in a new tab without a destination', () => {
    const chip = chipOf(<ReferenceChip reference={PR} taskTitle="Add checkout" />)

    expect(chip.getAttribute('href')).toBe('https://github.com/o/r/pull/402')
    expect(chip.getAttribute('target')).toBe('_blank')
  })
})
