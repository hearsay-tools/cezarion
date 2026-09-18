import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { AgentList } from './agents-dock'
import type { SubagentSummary } from './subagent-dock'

afterEach(cleanup)

const agent = (over: Partial<SubagentSummary> = {}): SubagentSummary => ({
  id: 'a',
  title: 'Audit the auth flow',
  status: 'running',
  toolCalls: 0,
  ...over,
})

/** Since #402 the rows have no head of their own: the Run activity accordion owns the title,
 *  the odometer and the collapse (`run-activity-dock.test.tsx`). These are the rows. */
const list = () => document.querySelector('[data-slot="agents-list"]')
const rows = () => Array.from(document.querySelectorAll('[data-slot="agent-item"]'))
const glyph = (row: Element) => row.querySelector('[data-slot="agent-glyph"]')!

describe('AgentList — visibility', () => {
  it('renders nothing at all when there is no fan-out', () => {
    render(<AgentList agents={[]} />)
    expect(list()).toBeNull()
  })

  it('mounts once there is at least one agent', () => {
    render(<AgentList agents={[agent()]} />)
    expect(list()).not.toBeNull()
  })
})

describe('AgentList — rows', () => {
  it('shows title, type badge, activity and tool count, in stream order', () => {
    render(
      <AgentList
        agents={[
          agent({ id: 'a', title: 'Audit the auth flow', agentType: 'general-purpose', activity: 'Ran npm test', toolCalls: 3 }),
          agent({ id: 'b', title: 'Review the store layer', status: 'completed', toolCalls: 1 }),
        ]}
      />,
    )
    const [first, second] = rows()
    expect(first!.textContent).toContain('Audit the auth flow')
    expect(first!.querySelector('[data-slot="agent-type"]')!.textContent).toBe('general-purpose')
    expect(first!.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('Ran npm test')
    expect(first!.querySelector('[data-slot="agent-tools"]')!.textContent).toBe('3 tools')
    // Singular, because "1 tools" is the kind of detail that makes a UI feel unfinished.
    expect(second!.querySelector('[data-slot="agent-tools"]')!.textContent).toBe('1 tool')
    expect(second!.textContent).toContain('Review the store layer')
  })

  it('renders "starting…" for an agent with no attributed output yet', () => {
    render(<AgentList agents={[agent({ activity: undefined })]} />)
    expect(document.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('starting…')
  })

  it('omits the type badge when the backend declares none (codex)', () => {
    render(<AgentList agents={[agent({ agentType: undefined })]} />)
    expect(document.querySelector('[data-slot="agent-type"]')).toBeNull()
  })

  it('distinguishes status by GLYPH SHAPE, never by color alone', () => {
    render(
      <AgentList
        agents={[
          agent({ id: 'a', status: 'running' }),
          agent({ id: 'b', status: 'completed' }),
          agent({ id: 'c', status: 'failed' }),
        ]}
      />,
    )
    const [running, completed, failed] = rows().map(glyph)
    // The running glyph is the pulsing half-disc; the other two are stroked paths.
    expect(running!.querySelector('.fill-pending')).not.toBeNull()
    expect(running!.classList.contains('animate-pulse')).toBe(true)
    // Reduced motion must silence the pulse.
    expect(running!.classList.contains('motion-reduce:animate-none')).toBe(true)
    expect(completed!.classList.contains('text-success')).toBe(true)
    expect(failed!.classList.contains('text-danger')).toBe(true)
    // Shapes differ, so the three are told apart without perceiving hue at all.
    const path = (svg: Element) => svg.querySelector('path')!.getAttribute('d')
    expect(new Set([path(running!), path(completed!), path(failed!)]).size).toBe(3)
  })

  it('renders a stalled agent as interrupted — not pulsing, not a checkmark', () => {
    render(<AgentList agents={[agent({ status: 'running', stalled: true })]} />)
    const svg = glyph(rows()[0]!)
    expect(svg.getAttribute('data-stalled')).toBe('true')
    // Not the live glyph: no pulse, no amber fill — the run ended, nothing is working.
    expect(svg.classList.contains('animate-pulse')).toBe(false)
    expect(svg.querySelector('.fill-pending')).toBeNull()
    // Not a success glyph either — it did not finish.
    expect(svg.classList.contains('text-success')).toBe(false)
    expect(document.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('never finished')
  })

  it('keeps a stalled agent’s real activity line when it produced one', () => {
    render(
      <AgentList agents={[agent({ status: 'running', stalled: true, activity: 'Ran npm test' })]} />,
    )
    expect(document.querySelector('[data-slot="agent-activity"]')!.textContent).toBe('Ran npm test')
  })

  it('exposes each status on the row for styling and tests', () => {
    render(<AgentList agents={[agent({ status: 'declined' })]} />)
    expect(rows()[0]!.getAttribute('data-status')).toBe('declined')
  })
})

describe('AgentList — row interaction', () => {
  it('rows are static display when no handler is passed (Phase 1)', () => {
    render(<AgentList agents={[agent()]} />)
    expect(rows()[0]!.querySelector('button')).toBeNull()
  })

  it('rows become dialog-opening buttons once a handler is passed (Phase 2)', () => {
    const opened: string[] = []
    render(<AgentList agents={[agent({ id: 'agent-42' })]} onSelect={(id) => opened.push(id)} />)
    const button = rows()[0]!.querySelector('button')!
    expect(button.getAttribute('aria-haspopup')).toBe('dialog')
    fireEvent.click(button)
    expect(opened).toEqual(['agent-42'])
  })
})
