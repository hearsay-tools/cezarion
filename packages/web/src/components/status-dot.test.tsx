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
  describe('tone → class mapping', () => {
    it.each([
      { tone: 'success', expected: 'bg-success' },
      { tone: 'pending', expected: 'bg-pending' },
      { tone: 'danger', expected: 'bg-danger' },
      { tone: 'accent', expected: 'bg-accent-strong' },
      { tone: 'info', expected: 'bg-info' },
      // #617: the running family paints the sidebar-safe violet, never the `--running` fill.
      { tone: 'running', expected: 'bg-status-running' },
      { tone: 'neutral', expected: 'bg-soft-foreground' },
    ] as const satisfies readonly { tone: StatusDotTone; expected: string }[])(
      '$tone',
      ({ tone, expected }) => {
        const dot = renderDot(<StatusDot tone={tone} />)

        expect(dot.className).toContain(expected)
        expect(dot.getAttribute('data-tone')).toBe(tone)
      }
    )
  })

  it('defaults to the neutral tone', () => {
    const dot = renderDot(<StatusDot />)

    expect(dot.getAttribute('data-tone')).toBe('neutral')
    expect(dot.className).toContain('bg-soft-foreground')
  })

  it('renders at the design system 7px size', () => {
    const dot = renderDot(<StatusDot />)

    expect(dot.className).toContain('size-[7px]')
    expect(dot.className).toContain('rounded-full')
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
      expect(dot.className).toContain('bg-success')
    })

    it('renders a ring as the same 7px box with a 1.5px stroke and a transparent centre', () => {
      const dot = renderDot(<StatusDot tone="running" shape="ring" />)
      expect(dot.getAttribute('data-shape')).toBe('ring')
      expect(dot.className).toContain('size-[7px]')
      expect(dot.className).toContain('rounded-full')
      expect(dot.className).toContain('border-[1.5px]')
      expect(dot.className).toContain('border-status-running')
      expect(dot.className).toContain('bg-transparent')
      expect(dot.className).not.toContain('bg-status-running')
    })

    it('renders the workers shape as the 12px bot glyph with the same accessible name', () => {
      const dot = renderDot(<StatusDot tone="running" shape="workers" role="img" aria-label="waiting on 2 workers" />)
      expect(dot.getAttribute('data-shape')).toBe('workers')
      expect(dot.getAttribute('role')).toBe('img')
      expect(dot.getAttribute('aria-label')).toBe('waiting on 2 workers')
      expect(dot.className).toContain('text-status-running')
      expect(dot.className).toContain('size-3')
      expect(dot.className).not.toContain('rounded-full')
      const svg = dot.querySelector('svg')
      expect(svg).not.toBeNull()
      expect(svg?.getAttribute('aria-hidden')).toBe('true')
      expect(svg?.getAttribute('data-design-icon')).toBe('bot')
    })

    it('pulses a ring when asked, like a filled dot', () => {
      expect(renderDot(<StatusDot tone="running" shape="ring" pulse />).className).toContain('animate-pulse')
    })
  })
})
