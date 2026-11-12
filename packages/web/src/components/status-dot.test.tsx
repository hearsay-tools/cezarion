import { cleanup, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

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
  const fillOf = (dot: Element) => dot.className.split(/\s+/).filter((cls) => cls.startsWith('bg-'))

  it('gives every tone its own fill and names it in data-tone', () => {
    // The resolved colours (the sidebar-safe violet for running, #617) are sampled in quick-list.e2e.ts.
    const fills = TONES.map((tone) => {
      const dot = renderDot(<StatusDot tone={tone} />)
      expect(dot.getAttribute('data-tone')).toBe(tone)
      const fill = fillOf(dot)
      cleanup()
      return fill.join(' ')
    })
    expect(fills.every(Boolean)).toBe(true)
    expect(new Set(fills).size).toBe(TONES.length)
  })

  it('defaults to the neutral tone', () => {
    const dot = renderDot(<StatusDot />)

    expect(dot.getAttribute('data-tone')).toBe('neutral')
    const neutral = fillOf(dot)
    cleanup()
    expect(fillOf(renderDot(<StatusDot tone="neutral" />))).toEqual(neutral)
  })

  it('pulses only when asked to', () => {
    expect(renderDot(<StatusDot tone="success" pulse />).className).toContain('animate-pulse')
    expect(renderDot(<StatusDot tone="success" />).className).not.toContain('animate-pulse')
    expect(renderDot(<StatusDot tone="success" pulse={false} />).className).not.toContain(
      'animate-pulse'
    )
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

    it('renders a ring hollow: a tone border instead of the filled dot\'s fill', () => {
      const filled = fillOf(renderDot(<StatusDot tone="running" />))
      cleanup()
      const ring = renderDot(<StatusDot tone="running" shape="ring" />)
      expect(ring.getAttribute('data-shape')).toBe('ring')
      expect(fillOf(ring)).not.toEqual(filled)
      expect(ring.className.split(/\s+/).some((cls) => /^border-(?!\[)/.test(cls))).toBe(true)
    })

    it('renders the workers shape as a bot glyph with the same accessible name', () => {
      const dot = renderDot(<StatusDot tone="running" shape="workers" role="img" aria-label="waiting on 2 workers" />)
      expect(dot.getAttribute('data-shape')).toBe('workers')
      expect(dot.getAttribute('role')).toBe('img')
      expect(dot.getAttribute('aria-label')).toBe('waiting on 2 workers')
      // The 12px box under every density and the lucide `bot` glyph: quick-list.e2e.ts.
      const svg = dot.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg?.getAttribute('aria-hidden')).toBe('true')
      expect(svg?.getAttribute('data-design-icon')).toBeNull()
    })

    it('pulses a ring when asked, like a filled dot', () => {
      expect(renderDot(<StatusDot tone="running" shape="ring" pulse />).className).toContain('animate-pulse')
    })
  })
})
