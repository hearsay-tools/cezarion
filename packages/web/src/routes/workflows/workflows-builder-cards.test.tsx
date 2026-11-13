import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Skill, WorkflowStepDef } from '@open-mercato/cezar-api-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { StepCardBody, WbDragPreview } from './workflows-builder-sections'

const skills: Skill[] = [
  { name: 'other', description: 'Other skill', path: '.ai/skills/other.md', body: '', source: 'ai' },
  { name: 'check', description: 'Check the result', path: '.ai/skills/check.md', body: '', source: 'ai' },
]

afterEach(cleanup)

describe('workflow step summaries', () => {
  it.each([
    { step: { id: 's', name: 'Named', skill: 'check', prompt: '  Specific instructions  ' }, title: 'Named', summary: 'Specific instructions', kind: 'Skill step' },
    { step: { id: 's', skill: 'check', prompt: '  {{task}}  ' }, title: 'check', summary: 'Check the result', kind: 'Skill step' },
    { step: { id: 's', skill: 'check' }, title: 'check', summary: 'Check the result', kind: 'Skill step' },
    { step: { id: 'raw', prompt: 'Plain instructions' }, title: 'raw', summary: 'Plain instructions', kind: 'Prompt step' },
    { step: { id: 'cmd', command: 'npm test' }, title: 'cmd', summary: '$ npm test', kind: 'Command step' },
    { step: { id: 'cmd', command: 'npm test', onFail: { retry: 'fix', max: 2 } }, title: 'cmd', summary: '$ npm test — on fail retry from "fix" (×2)', kind: 'Command step · Retry ×2' },
    { step: { id: 'cmd', command: 'npm test', onFail: { retry: 'fix', max: 4 } }, title: 'cmd', summary: '$ npm test — on fail retry from "fix" (×4)', kind: 'Command step · Retry ×4' },
  ])('shows the title and summary for $title / $summary', ({ step, title, summary, kind }) => {
    render(<StepCardBody step={step} index={1} skills={skills} />)
    expect(screen.getByText(title)).toBeTruthy()
    expect(screen.getByText(summary)).toBeTruthy()
    expect(screen.getByText(kind)).toBeTruthy()
    const grip = screen.getByRole('button', { name: `Reorder step 2: ${title}` })
    expect(grip.textContent).toBe('02')
    expect(screen.queryByText('unknown')).toBeNull()
  })

  it('marks a missing skill and explains how its plain prompt runs', () => {
    render(<StepCardBody step={{ id: 's', skill: 'missing' }} index={0} skills={skills} />)
    expect(screen.getByText('missing')).toBeTruthy()
    expect(screen.getByText('unknown')).toBeTruthy()
    expect(screen.getByText(/plain prompt/)).toBeTruthy()
  })

  it('leaves an empty prompt step without a summary or unknown badge', () => {
    const { container } = render(<StepCardBody step={{ id: 'empty' }} index={0} skills={skills} />)
    expect(container.querySelector('[data-slot="wb-step-summary"]')).toBeNull()
    expect(screen.queryByText('unknown')).toBeNull()
    expect(screen.getByText('Prompt step')).toBeTruthy()
  })

  it('forwards accessible grip properties and move actions', () => {
    const onMoveUp = vi.fn()
    const onMoveDown = vi.fn()
    const { rerender } = render(<StepCardBody step={{ id: 's' }} index={1} skills={[]} onMoveUp={onMoveUp} onMoveDown={onMoveDown} gripProps={{ 'aria-describedby': 'drag-help' }} />)
    expect(screen.getByRole('button', { name: 'Reorder step 2: s' }).getAttribute('aria-describedby')).toBe('drag-help')
    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 up' }))
    fireEvent.click(screen.getByRole('button', { name: 'Move step 2 down' }))
    expect(onMoveUp).toHaveBeenCalledOnce()
    expect(onMoveDown).toHaveBeenCalledOnce()
    rerender(<StepCardBody step={{ id: 's' }} index={1} skills={[]} />)
    expect((screen.getByRole('button', { name: 'Move step 2 up' }) as HTMLButtonElement).disabled).toBe(true)
    expect((screen.getByRole('button', { name: 'Move step 2 down' }) as HTMLButtonElement).disabled).toBe(true)
    expect(screen.queryByRole('button', { name: 'Step 2 actions: s' })).toBeNull()
  })
})

describe('workflow drag preview', () => {
  const steps: WorkflowStepDef[] = [{ id: 'first', prompt: 'First prompt' }, { id: 'second', prompt: 'Second prompt' }]

  it('shows nothing when there is no active drag', () => {
    const { container } = render(<WbDragPreview dragging={null} steps={steps} skills={skills} />)
    expect(container.textContent).toBe('')
  })

  it('shows the skill being copied from the palette', () => {
    render(<WbDragPreview dragging={{ type: 'palette', skill: 'check' }} steps={steps} skills={skills} />)
    expect(screen.getByText('check')).toBeTruthy()
    expect(screen.queryByRole('button')).toBeNull()
  })

  it('shows the dragged step at its canvas position without move controls', () => {
    render(<WbDragPreview dragging={{ type: 'step', step: steps[1]! }} steps={steps} skills={skills} />)
    expect(screen.getByText('Second prompt')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Reorder step 2: second' }).textContent).toBe('02')
    expect(screen.queryByRole('button', { name: /Move step/ })).toBeNull()
  })
})
