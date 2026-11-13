import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { paintClasses } from '@/test/paint'

import { StatusDot, type StatusDotTone } from './status-dot'

// Explicit rather than relying on RTL's auto-cleanup, which only runs when vitest `globals` is on.
afterEach(cleanup)

function renderDot(ui: React.ReactElement) {
  const { container } = render(ui)
  const dot = container.querySelector('[data-slot="status-dot"]')
  if (!dot) throw new Error('StatusDot did not render')
  return dot
}

describe('StatusDot', () => {
  const TONES = ['success', 'pending', 'danger', 'accent', 'info', 'running', 'neutral'] as const satisfies readonly StatusDotTone[]
  const fillOf = (dot: Element) => paintClasses(dot, 'fill')

  it('names every tone in data-tone', () => {
    for (const tone of TONES) {
      expect(renderDot(<StatusDot tone={tone} />).getAttribute('data-tone')).toBe(tone)
      cleanup()
    }
  })

  it('defaults to the neutral tone', () => {
    const dot = renderDot(<StatusDot />)

    expect(dot.getAttribute('data-tone')).toBe('neutral')
    const neutral = fillOf(dot)
    cleanup()
    expect(fillOf(renderDot(<StatusDot tone="neutral" />))).toEqual(neutral)
  })

  it('pulses only when asked to', () => {
    expect(renderDot(<StatusDot tone="success" pulse />).getAttribute('data-pulse')).toBe('true')
    cleanup()
    expect(renderDot(<StatusDot tone="success" />).hasAttribute('data-pulse')).toBe(false)
    cleanup()
    expect(renderDot(<StatusDot tone="success" pulse={false} />).hasAttribute('data-pulse')).toBe(false)
  })

  it('lets a caller className override the tone', () => {
    const dot = renderDot(<StatusDot tone="success" className="bg-accent-strong" />)

    expect(dot.className).toContain('bg-accent-strong')
    expect(dot.className).not.toContain('bg-success')
  })

  describe('shape (#617 status key)', () => {
    it('defaults to a filled dot', () => {
      const dot = renderDot(<StatusDot tone="success" />)
      expect(dot.getAttribute('data-shape')).toBe('filled')
    })

    it.each(TONES)('renders a %s ring as the ring shape', (tone) => {
      const ring = renderDot(<StatusDot tone={tone} shape="ring" />)
      expect(ring.getAttribute('data-shape')).toBe('ring')
      expect(ring.getAttribute('data-tone')).toBe(tone)
    })

    it('renders the workers shape as a bot glyph with the same accessible name', () => {
      const dot = renderDot(<StatusDot tone="running" shape="workers" role="img" aria-label="waiting on 2 workers" />)
      expect(dot.getAttribute('data-shape')).toBe('workers')
      expect(dot.getAttribute('role')).toBe('img')
      expect(dot.getAttribute('aria-label')).toBe('waiting on 2 workers')
      expect(dot.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true')
    })

    it('pulses a ring when asked, like a filled dot', () => {
      expect(renderDot(<StatusDot tone="running" shape="ring" pulse />).getAttribute('data-pulse')).toBe('true')
    })
  })
})
