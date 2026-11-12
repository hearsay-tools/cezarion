import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { isPainted, paintClasses } from '@/test/paint'

import { Pill } from './pill'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

function pillOf(ui: React.ReactElement) {
  const { container } = render(ui)
  const pill = container.querySelector('[data-slot="pill"]')
  if (!pill) throw new Error('Pill did not render')
  return pill
}

describe('Pill', () => {
  it('renders its children as a neutral chip', () => {
    const pill = pillOf(<Pill>3 running</Pill>)

    expect(pill.textContent).toBe('3 running')
  })

  it('has no dot unless one is requested', () => {
    const pill = pillOf(<Pill>Idle</Pill>)

    expect(pill.querySelector('[data-slot="status-dot"]')).toBeNull()
  })

  it('composes a StatusDot in the requested tone', () => {
    const pill = pillOf(<Pill dot="success">Passed</Pill>)
    const dot = pill.querySelector('[data-slot="status-dot"]')

    expect(dot).not.toBeNull()
    expect(dot?.getAttribute('data-tone')).toBe('success')
    expect(pill.textContent).toBe('Passed')
  })

  it('forwards pulse to the dot', () => {
    const pill = pillOf(
      <Pill dot="pending" pulse>
        Working
      </Pill>
    )

    expect(pill.querySelector('[data-slot="status-dot"]')?.className).toContain('animate-pulse')
  })

  // The design system's grammar: status is expressed by the dot, so the chip's own fill never changes.
  it('keeps the chip itself unchanged whatever the dot tone', () => {
    const plain = pillOf(<Pill>Label</Pill>).className
    cleanup()
    const toned = (['success', 'pending', 'danger', 'accent', 'neutral'] as const).map((tone) => {
      const className = pillOf(<Pill dot={tone}>Label</Pill>).className
      cleanup()
      return className
    })
    expect(toned).toEqual(toned.map(() => plain))
    // …and that one chip is painted: a fill and an ink of its own.
    const chip = pillOf(<Pill>Label</Pill>)
    expect(isPainted(paintClasses(chip, 'fill'))).toBe(true)
    expect(isPainted(paintClasses(chip, 'ink'))).toBe(true)
  })

  it('passes through span attributes', () => {
    render(<Pill title="tooltip">Label</Pill>)

    expect(screen.getByTitle('tooltip').textContent).toBe('Label')
  })
})
