import { createRef } from 'react'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import type { Skill, WorkflowDef } from '@open-mercato/cezar-api-client'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { WB_MAX_STEPS } from '@/lib/workflow-builder'
import { WbAddStepDialog, WbAside, WbAutoPanel, WbConfirmDialogs, WbImportDialog, WbMetadata } from './workflows-builder-sections'

const skill: Skill = { name: 'check', description: 'Check the result', path: '.ai/skills/check.md', body: '', source: 'ai' }
const saved: WorkflowDef = { name: 'saved', source: 'file', path: '.ai/cezar/workflows/saved.yaml', steps: [{ id: 's', skill: 'check' }] }

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('workflow metadata', () => {
  it('keeps draft fields when editing and loads the selected workflow', () => {
    const draft = { name: 'draft', description: 'Description', steps: saved.steps }
    const onDraft = vi.fn()
    const onLoadWorkflow = vi.fn()
    const props = { workflows: [{ ...saved, name: 'other' }, saved], draft, trimmedName: 'unsaved', nameRef: createRef<HTMLInputElement>(), onDraft, onLoadWorkflow }
    const { rerender } = render(<WbMetadata {...props} />)
    const picker = screen.getByLabelText('Load an existing workflow') as HTMLSelectElement
    expect(picker.value).toBe('')
    fireEvent.change(screen.getByLabelText('Workflow name'), { target: { value: 'renamed' } })
    expect(onDraft).toHaveBeenLastCalledWith({ ...draft, name: 'renamed' })
    fireEvent.change(screen.getByLabelText('Description'), { target: { value: 'Updated' } })
    expect(onDraft).toHaveBeenLastCalledWith({ ...draft, description: 'Updated' })
    fireEvent.change(picker, { target: { value: 'saved' } })
    expect(onLoadWorkflow).toHaveBeenCalledExactlyOnceWith(saved)
    rerender(<WbMetadata {...props} trimmedName="saved" />)
    expect(picker.value).toBe('saved')
    fireEvent.change(picker, { target: { value: '' } })
    expect(onLoadWorkflow).toHaveBeenCalledOnce()
  })
})

describe('auto chain panel', () => {
  it('runs on either platform shortcut and leaves other keys alone', () => {
    const onRun = vi.fn()
    const onCancel = vi.fn()
    const onTextChange = vi.fn()
    render(<WbAutoPanel text="Build it" pending={false} onRun={onRun} onCancel={onCancel} onTextChange={onTextChange} />)
    const input = screen.getByRole('textbox')
    fireEvent.change(input, { target: { value: 'New chain' } })
    expect(onTextChange).toHaveBeenCalledWith('New chain')
    expect(fireEvent.keyDown(input, { key: 'Enter', ctrlKey: true })).toBe(false)
    expect(fireEvent.keyDown(input, { key: 'Enter', metaKey: true })).toBe(false)
    expect(onRun).toHaveBeenCalledTimes(2)
    expect(fireEvent.keyDown(input, { key: 'Enter' })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'a', ctrlKey: true })).toBe(true)
    expect(fireEvent.keyDown(input, { key: 'a', metaKey: true })).toBe(true)
    expect(onRun).toHaveBeenCalledTimes(2)
    fireEvent.click(screen.getByRole('button', { name: 'Build chain' }))
    expect(onRun).toHaveBeenCalledTimes(3)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it.each([
    { text: '  ', pending: false, label: 'Build chain' },
    { text: 'Build it', pending: true, label: 'Building…' },
  ])('disables building for $text / pending=$pending', ({ text, pending, label }) => {
    const onRun = vi.fn()
    render(<WbAutoPanel text={text} pending={pending} onRun={onRun} onCancel={vi.fn()} onTextChange={vi.fn()} />)
    const button = screen.getByRole('button', { name: label }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onRun).not.toHaveBeenCalled()
  })
})

describe('workflow skill picker', () => {
  function pickerProps() {
    return { open: true, onOpenChange: vi.fn(), query: '', onQueryChange: vi.fn(), matches: [skill], skillsCount: 1, error: null, selectedSkill: null, onSelectSkill: vi.fn(), stepsCount: 0, onCloseAutoFocus: vi.fn(), onCancel: vi.fn(), onAdd: vi.fn() }
  }

  it('selects a skill, filters, adds the selection and cancels', () => {
    const props = pickerProps()
    const { rerender } = render(<WbAddStepDialog {...props} />)
    const add = screen.getByRole('button', { name: 'Add selected skill' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect((screen.getByRole('radio', { name: /check/ }) as HTMLInputElement).checked).toBe(false)
    fireEvent.click(screen.getByRole('radio', { name: /check/ }))
    expect(props.onSelectSkill).toHaveBeenCalledWith('check')
    fireEvent.change(screen.getByLabelText('Filter skills'), { target: { value: 'query' } })
    expect(props.onQueryChange).toHaveBeenCalledWith('query')
    rerender(<WbAddStepDialog {...props} selectedSkill="check" stepsCount={WB_MAX_STEPS - 1} />)
    expect((screen.getByRole('radio') as HTMLInputElement).checked).toBe(true)
    expect(add.disabled).toBe(false)
    expect(screen.queryByRole('status')).toBeNull()
    expect(screen.queryByText(/No matching skills/)).toBeNull()
    fireEvent.click(add)
    expect(props.onAdd).toHaveBeenCalledExactlyOnceWith('check')
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledOnce()
  })

  it('refuses to add a selected skill at the step cap', () => {
    const props = pickerProps()
    render(<WbAddStepDialog {...props} selectedSkill="check" stepsCount={WB_MAX_STEPS} />)
    const add = screen.getByRole('button', { name: 'Add selected skill' }) as HTMLButtonElement
    expect(add.disabled).toBe(true)
    expect(screen.getByRole('status').textContent).toContain(`up to ${WB_MAX_STEPS} steps`)
    fireEvent.click(add)
    expect(props.onAdd).not.toHaveBeenCalled()
  })

  it('distinguishes an empty catalog, no matches and a load error', () => {
    const props = pickerProps()
    const { rerender } = render(<WbAddStepDialog {...props} matches={[]} skillsCount={0} />)
    expect(screen.getByText('No skills available in this project.')).toBeTruthy()
    rerender(<WbAddStepDialog {...props} matches={[]} />)
    expect(screen.getByText('No matching skills.')).toBeTruthy()
    rerender(<WbAddStepDialog {...props} error="offline" />)
    expect(screen.getByRole('alert').textContent).toContain('offline')
    expect(screen.queryByRole('radiogroup')).toBeNull()
  })
})

describe('workflow import and confirmation dialogs', () => {
  it('hides import errors until present and disables a pending import', () => {
    const props = { open: true, onOpenChange: vi.fn(), text: 'name: saved', onTextChange: vi.fn(), error: '', pending: false, onRun: vi.fn(), onCancel: vi.fn() }
    const { rerender } = render(<WbImportDialog {...props} />)
    expect(screen.queryByRole('alert')).toBeNull()
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'name: new' } })
    expect(props.onTextChange).toHaveBeenCalledWith('name: new')
    fireEvent.click(screen.getByRole('button', { name: 'Import' }))
    expect(props.onRun).toHaveBeenCalledOnce()
    rerender(<WbImportDialog {...props} error="Invalid YAML" pending />)
    expect(screen.getByRole('alert').textContent).toBe('Invalid YAML')
    expect((screen.getByRole('button', { name: 'Import' }) as HTMLButtonElement).disabled).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(props.onCancel).toHaveBeenCalledOnce()
  })

  it.each(['overwrite', 'delete'] as const)('dismisses the %s confirmation without accepting it', (kind) => {
    const onOverwriteDismiss = vi.fn()
    const onDeleteDismiss = vi.fn()
    const onOverwrite = vi.fn()
    const onDelete = vi.fn()
    render(<WbConfirmDialogs trimmedName="saved" savedFile={saved} overwriteOpen={kind === 'overwrite'} deleteOpen={kind === 'delete'} onOverwriteDismiss={onOverwriteDismiss} onDeleteDismiss={onDeleteDismiss} onOverwrite={onOverwrite} onDelete={onDelete} />)
    if (kind === 'delete') expect(screen.getByRole('alertdialog').textContent).toContain('Removes saved.yaml from')
    fireEvent.click(screen.getByRole('button', { name: 'Keep the file' }))
    expect(kind === 'overwrite' ? onOverwriteDismiss : onDeleteDismiss).toHaveBeenCalledOnce()
    expect(onOverwrite).not.toHaveBeenCalled()
    expect(onDelete).not.toHaveBeenCalled()
  })

  it('uses a readable filename fallback without a saved path', () => {
    render(<WbConfirmDialogs trimmedName="saved" savedFile={{ ...saved, path: undefined }} overwriteOpen={false} deleteOpen onOverwriteDismiss={vi.fn()} onDeleteDismiss={vi.fn()} onOverwrite={vi.fn()} onDelete={vi.fn()} />)
    expect(screen.getByRole('alertdialog').textContent).toContain('Removes the saved file from')
  })
})

describe('workflow palette and YAML', () => {
  function asideProps() {
    return { paletteSkills: [skill], query: '', onQueryChange: vi.fn(), error: null, inFlow: new Set<string>(), onAdd: vi.fn(), yaml: 'name: saved\nsteps: []' }
  }

  it('filters skills and reports an unavailable catalog', () => {
    const props = asideProps()
    const { rerender } = render(<WbAside {...props} />)
    fireEvent.change(screen.getByLabelText('Filter skills'), { target: { value: 'missing' } })
    expect(props.onQueryChange).toHaveBeenCalledWith('missing')
    fireEvent.click(screen.getByRole('button', { name: 'Add check to the flow' }))
    expect(props.onAdd).toHaveBeenCalledWith('check')
    rerender(<WbAside {...props} query="zzzzz" />)
    expect(screen.getByText('No skills match.')).toBeTruthy()
    rerender(<WbAside {...props} error="offline" />)
    expect(screen.getByText('Could not load skills: offline')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Add check to the flow' })).toBeNull()
  })

  it('copies the current YAML and restarts the feedback period on each copy', () => {
    vi.useFakeTimers()
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const props = asideProps()
    render(<WbAside {...props} />)
    fireEvent.click(screen.getByText('View YAML'))
    fireEvent.click(screen.getByRole('button', { name: 'Copy' }))
    expect(writeText).toHaveBeenCalledWith(props.yaml)
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(1000))
    fireEvent.click(screen.getByRole('button', { name: 'Copied' }))
    act(() => vi.advanceTimersByTime(600))
    expect(screen.getByRole('button', { name: 'Copied' })).toBeTruthy()
    act(() => vi.advanceTimersByTime(1000))
    expect(screen.getByRole('button', { name: 'Copy' })).toBeTruthy()
    expect(writeText).toHaveBeenCalledTimes(2)
  })
})
