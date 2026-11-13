import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { createRef } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'

import { Composer } from './composer'
import {
  ComposerAttachButton,
  ComposerDictationButton,
  ComposerFeedback,
  ComposerFinishButton,
  ComposerStopButton,
} from './composer-parts'
import type { ComposerSubmitMode } from './composer-view'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function mode(overrides: Partial<ComposerSubmitMode> = {}): ComposerSubmitMode {
  return {
    hasContent: false,
    primaryStop: false,
    primaryFinish: false,
    labelledStop: false,
    submitLabel: 'Send',
    busy: false,
    stopPending: false,
    finishing: false,
    finishLabel: 'Finish',
    finishTitle: 'Finish this task',
    disabled: false,
    allowEmptySubmit: false,
    readOnly: false,
    mobileCompact: false,
    mobileCollapsible: false,
    executionOptions: false,
    sessionControls: false,
    showStop: false,
    ...overrides,
  }
}

describe('composer action availability', () => {
  it.each(['disabled', 'readOnly'] as const)('blocks dictation when %s', (flag) => {
    const onStart = vi.fn()
    render(<ComposerDictationButton mode={mode({ [flag]: true })} onStart={onStart} />)
    const button = screen.getByRole('button', { name: 'Start dictation' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onStart).not.toHaveBeenCalled()
  })

  it('starts dictation when the draft is editable', () => {
    const onStart = vi.fn()
    render(<ComposerDictationButton mode={mode()} onStart={onStart} />)
    const button = screen.getByRole('button', { name: 'Start dictation' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onStart).toHaveBeenCalledOnce()
  })

  it.each(['busy', 'stopPending', 'finishing'] as const)('blocks Finish when %s', (flag) => {
    const onFinish = vi.fn()
    render(<ComposerFinishButton mode={mode({ [flag]: true })} onFinish={onFinish} />)
    const button = screen.getByRole('button', { name: 'Finish' }) as HTMLButtonElement
    expect(button.disabled).toBe(true)
    fireEvent.click(button)
    expect(onFinish).not.toHaveBeenCalled()
  })

  it('allows Finish when sending is disabled and announces only an active finish as busy', () => {
    const onFinish = vi.fn()
    const { rerender } = render(<ComposerFinishButton mode={mode({ disabled: true })} onFinish={onFinish} />)
    const button = screen.getByRole('button', { name: 'Finish' }) as HTMLButtonElement
    expect(button.disabled).toBe(false)
    expect(button.hasAttribute('aria-busy')).toBe(false)
    fireEvent.click(button)
    expect(onFinish).toHaveBeenCalledOnce()

    rerender(<ComposerFinishButton mode={mode({ finishing: true, finishLabel: 'Finishing…' })} onFinish={onFinish} />)
    expect(screen.getByRole('button', { name: 'Finishing…' }).getAttribute('aria-busy')).toBe('true')
  })

  it('announces a pending Stop and keeps its visible label', () => {
    const onStop = vi.fn()
    const { rerender } = render(<ComposerStopButton mode={mode({ labelledStop: true })} onStop={onStop} />)
    const button = screen.getByRole('button', { name: 'Stop' }) as HTMLButtonElement
    expect(button.hasAttribute('aria-busy')).toBe(false)
    expect(button.disabled).toBe(false)
    fireEvent.click(button)
    expect(onStop).toHaveBeenCalledOnce()

    rerender(<ComposerStopButton mode={mode({ labelledStop: true, stopPending: true })} onStop={onStop} />)
    const stopping = screen.getByRole('button', { name: 'Stopping…' }) as HTMLButtonElement
    expect(stopping.textContent).toBe('Stopping…')
    expect(stopping.getAttribute('aria-busy')).toBe('true')
    expect(stopping.disabled).toBe(true)
    fireEvent.click(stopping)
    expect(onStop).toHaveBeenCalledOnce()
  })
})

describe('composer submission feedback', () => {
  const defaults = {
    shown: true,
    compactFeedback: false,
    hasCompactFeedback: true,
    textareaId: 'reply',
    submissionError: null,
    stopPending: false,
    busy: false,
    pendingLabel: 'Sending draft',
    failureHint: 'Try sending again',
    idleFeedback: <span>Ready for your reply</span>,
  }

  it('renders no feedback when hidden', () => {
    const { container } = render(<ComposerFeedback {...defaults} shown={false} />)
    expect(container.childElementCount).toBe(0)
  })

  it('links the idle status to the draft without adding it to the tab order', () => {
    render(<ComposerFeedback {...defaults} />)
    const status = screen.getByRole('status')
    expect(status.id).toBe('reply-submission')
    expect(status.textContent).toBe('Ready for your reply')
    expect(status.hasAttribute('tabindex')).toBe(false)
    expect(status.getAttribute('aria-atomic')).toBe('true')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('makes a submission error focusable and includes the recovery hint', () => {
    render(<ComposerFeedback {...defaults} submissionError="Connection lost" />)
    const alert = screen.getByRole('alert')
    expect(alert.tabIndex).toBe(0)
    expect(alert.textContent).toContain('Connection lost')
    expect(alert.textContent).toContain('Try sending again')
    alert.focus()
    expect(document.activeElement).toBe(alert)
    expect(screen.queryByText('Ready for your reply')).toBeNull()
  })

  it('shows sending feedback, then gives stopping feedback priority', () => {
    const { rerender } = render(<ComposerFeedback {...defaults} busy />)
    expect(screen.getByRole('status').textContent).toBe('Sending draft')
    rerender(<ComposerFeedback {...defaults} busy stopPending />)
    expect(screen.getByRole('status').textContent).toBe('Stopping execution. Your draft is kept.')
  })
})

describe('composer file picker', () => {
  it('opens the picker and keeps the hidden input out of the tab order', () => {
    const inputRef = createRef<HTMLInputElement>()
    render(<ComposerAttachButton disabled={false} inputRef={inputRef} onFiles={vi.fn()} />)
    const input = inputRef.current!
    const click = vi.spyOn(input, 'click')
    expect(input.tabIndex).toBe(-1)
    expect(input.multiple).toBe(true)
    fireEvent.click(screen.getByRole('button', { name: 'Attach files' }))
    expect(click).toHaveBeenCalledOnce()
  })

  it('forwards every selected file and clears the picker for another selection', () => {
    const inputRef = createRef<HTMLInputElement>()
    const onFiles = vi.fn()
    render(<ComposerAttachButton disabled={false} inputRef={inputRef} onFiles={onFiles} />)
    const input = inputRef.current!
    const files = [new File(['notes'], 'notes.md'), new File(['log'], 'trace.txt')]
    // A browser supplies a fake path; jsdom rejects assigning a nonempty file value.
    Object.defineProperty(input, 'value', { configurable: true, writable: true, value: 'C:\\fakepath\\notes.md' })
    fireEvent.change(input, { target: { files } })
    expect(onFiles).toHaveBeenCalledExactlyOnceWith(files)
    expect(input.value).toBe('')
    fireEvent.change(input, { target: { files } })
    expect(onFiles).toHaveBeenNthCalledWith(2, files)
  })

  it('treats a picker change without a file list as an empty selection', () => {
    const inputRef = createRef<HTMLInputElement>()
    const onFiles = vi.fn()
    render(<ComposerAttachButton disabled={false} inputRef={inputRef} onFiles={onFiles} />)
    fireEvent.change(inputRef.current!, { target: { files: null } })
    expect(onFiles).toHaveBeenCalledExactlyOnceWith([])
  })
})

describe('composer draft accessibility', () => {
  it('marks a retained draft busy while sending and unlocks it after success', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('{}'))))
    let complete!: () => void
    const onSubmit = vi.fn(() => new Promise<void>((resolve) => { complete = resolve }))
    render(
      <QueryClientProvider client={createQueryClient()}>
        <Composer onSubmit={onSubmit} retainDraftUntilSuccess />
      </QueryClientProvider>,
    )
    const textarea = screen.getByRole('textbox') as HTMLTextAreaElement
    expect(textarea.hasAttribute('aria-busy')).toBe(false)
    expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(false)
    fireEvent.change(textarea, { target: { value: 'Keep this draft until sent' } })
    fireEvent.click(screen.getByRole('button', { name: 'Send' }))
    expect(textarea.getAttribute('aria-busy')).toBe('true')
    expect(textarea.readOnly).toBe(true)
    expect(textarea.value).toBe('Keep this draft until sent')
    expect((screen.getByRole('button', { name: 'Attach files' }) as HTMLButtonElement).disabled).toBe(true)
    await act(async () => complete())
    expect(textarea.hasAttribute('aria-busy')).toBe(false)
    expect(textarea.readOnly).toBe(false)
    expect(textarea.value).toBe('')
  })
})
