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
  // A painted fill: some bg- class, none of them transparent.
  const painted = (fill: readonly string[]) => fill.length > 0 && !fill.includes('bg-transparent')

  it('gives every tone its own fill and names it in data-tone', () => {
    // The resolved colours (the sidebar-safe violet for running, #617) are sampled in quick-list.e2e.ts.
    const fills = TONES.map((tone) => {
      const dot = renderDot(<StatusDot tone={tone} />)
      expect(dot.getAttribute('data-tone')).toBe(tone)
      const fill = fillOf(dot)
      expect(painted(fill), tone).toBe(true)
      cleanup()
      return fill.join(' ')
    })
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

    it.each(TONES)('renders a %s ring hollow, with a visible stroke', (tone) => {
      const ring = renderDot(<StatusDot tone={tone} shape="ring" />)
      const classes = ring.className.split(/\s+/)
      expect(ring.getAttribute('data-shape')).toBe('ring')
      // No fill: the centre stays clear.
      expect(fillOf(ring).filter((cls) => cls !== 'bg-transparent')).toEqual([])
      // A stroke wider than zero: plain `border`, `border-N` or `border-[Npx]` with N > 0.
      expect(classes.some((cls) => /^border(?:-[1-9]\d*|-\[(?:0?\.\d*[1-9]|[1-9][\d.]*)px\])?$/.test(cls))).toBe(true)
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
