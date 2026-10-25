import { QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { createQueryClient } from '@/api/query-client'
import { resetToasts, Toaster } from '@/components/ui/toaster'

import { Composer, type ComposerProps } from './composer'
import {
  describeDictationError,
  foldResults,
  formatElapsed,
  type SpeechRecognitionLike,
  type SpeechResultEventLike,
} from './dictation'

afterEach(() => {
  cleanup()
  resetToasts()
  vi.unstubAllGlobals()
})

/** A scriptable Web Speech stand-in: tests drive `onresult`/`onerror` by hand — exactly the
 *  seam the adapter promises (`speechRecognitionCtor` reads the global at call time). */
class FakeRecognition implements SpeechRecognitionLike {
  static instances: FakeRecognition[] = []
  static failOnStart = false
  lang = ''
  continuous = false
  interimResults = false
  started = false
  stopped = false
  aborted = false
  onresult: ((event: SpeechResultEventLike) => void) | null = null
  onerror: ((event: { error?: string | undefined; message?: string }) => void) | null = null
  onend: (() => void) | null = null

  start(): void {
    if (FakeRecognition.failOnStart) throw new Error('not allowed')
    this.started = true
  }
  stop(): void {
    this.stopped = true
  }
  abort(): void {
    this.aborted = true
  }
}

function stubSpeech() {
  FakeRecognition.instances = []
  FakeRecognition.failOnStart = false
  const Ctor = class extends FakeRecognition {
    constructor() {
      super()
      FakeRecognition.instances.push(this)
    }
  }
  vi.stubGlobal('SpeechRecognition', Ctor)
}

const result = (transcript: string, isFinal: boolean, resultIndex = 0): SpeechResultEventLike => ({
  resultIndex,
  results: [{ isFinal, 0: { transcript } }],
})

function renderComposer(onSubmit = vi.fn(() => Promise.resolve({})), props: Partial<ComposerProps> = {}) {
  vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))))
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Composer onSubmit={onSubmit} {...props} />
      <Toaster />
    </QueryClientProvider>,
  )
  return { onSubmit, textarea: screen.getByLabelText('Reply to the agent') as HTMLTextAreaElement }
}

const startDictation = () => {
  fireEvent.click(screen.getByLabelText('Start dictation'))
  return FakeRecognition.instances.at(-1)!
}

describe('foldResults — pure transcript folding', () => {
  it('finals accumulate, interims replace the tail', () => {
    let state = foldResults('', { resultIndex: 0, results: [{ isFinal: false, 0: { transcript: 'hel' } }] })
    expect(state).toEqual({ finalText: '', interim: 'hel' })
    state = foldResults(state.finalText, { resultIndex: 0, results: [{ isFinal: true, 0: { transcript: 'hello ' } }] })
    expect(state).toEqual({ finalText: 'hello ', interim: '' })
    state = foldResults(state.finalText, {
      resultIndex: 1,
      results: [
        { isFinal: true, 0: { transcript: 'hello ' } }, // already folded — before resultIndex
        { isFinal: false, 0: { transcript: 'wor' } },
      ],
    })
    expect(state).toEqual({ finalText: 'hello ', interim: 'wor' })
  })
})

describe('formatElapsed', () => {
  it('renders mm:ss', () => {
    expect(formatElapsed(0, 0)).toBe('0:00')
    expect(formatElapsed(0, 61_000)).toBe('1:01')
    expect(formatElapsed(0, 600_000)).toBe('10:00')
  })
})

describe('the dictation overlay (paseo pattern)', () => {
  it('the mic renders labeled "Dictation" when the API exists, left of send', () => {
    stubSpeech()
    renderComposer()
    const mic = screen.getByLabelText('Start dictation')
    expect(mic.textContent).toContain('Dictation')
    const send = screen.getByRole('button', { name: 'Send' })
    expect(mic.compareDocumentPosition(send) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)

  })

  it('recording swaps the footer for the overlay: timer, pulsing dot, growing partial transcript', () => {
    stubSpeech()
    renderComposer()
    const recognition = startDictation()
    expect(recognition.started).toBe(true)
    expect(recognition.interimResults).toBe(true)
    expect(recognition.continuous).toBe(true)

    const overlay = document.querySelector('[data-slot="dictation-overlay"]')!
    expect(overlay).not.toBeNull()
    expect(screen.queryByLabelText('Send')).toBeNull() // the footer is REPLACED
    expect(overlay.querySelector('[data-slot="dictation-timer"]')!.textContent).toBe('0:00')
    expect(overlay.textContent).toContain('Listening…')

    act(() => recognition.onresult!(result('summarize the', false)))
    expect(document.querySelector('[data-slot="dictation-transcript"]')!.textContent).toBe('summarize the')
    act(() => recognition.onresult!(result('summarize the thread', true)))
    expect(document.querySelector('[data-slot="dictation-transcript"]')!.textContent).toBe(
      'summarize the thread',
    )
  })

  it('✓ insert puts the transcript into the textarea (appended to a draft) and stops the mic', () => {
    stubSpeech()
    const { textarea } = renderComposer()
    fireEvent.change(textarea, { target: { value: 'Also:' } })
    const recognition = startDictation()
    act(() => recognition.onresult!(result('check the tests', true)))
    fireEvent.click(screen.getByLabelText('Insert transcription'))

    expect(textarea.value).toBe('Also: check the tests')
    expect(recognition.stopped).toBe(true)
    expect(document.querySelector('[data-slot="dictation-overlay"]')).toBeNull()
  })

  it('↑ insert-and-send submits the transcript in one tap', async () => {
    stubSpeech()
    const { onSubmit } = renderComposer()
    const recognition = startDictation()
    act(() => recognition.onresult!(result('ship it', true)))
    fireEvent.click(screen.getByLabelText('Insert transcription and send'))
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith('ship it', []))
  })

  it('✕ cancel aborts and restores the footer without touching the draft', () => {
    stubSpeech()
    const { textarea } = renderComposer()
    fireEvent.change(textarea, { target: { value: 'my draft' } })
    const recognition = startDictation()
    act(() => recognition.onresult!(result('noise', false)))
    expect(screen.getByLabelText('Cancel dictation').className).toContain('size-11 text-muted-foreground md:size-8')
    fireEvent.click(screen.getByLabelText('Cancel dictation'))

    expect(recognition.aborted).toBe(true)
    expect(textarea.value).toBe('my draft')
    expect(document.querySelector('[data-slot="dictation-overlay"]')).toBeNull()
    expect(screen.getByLabelText('Send')).toBeTruthy()
  })

  it('an unknown recognition error surfaces the browser word as a toast and returns to idle', async () => {
    stubSpeech()
    renderComposer()
    const recognition = startDictation()
    act(() => recognition.onerror!({ error: 'bad-grammar' }))
    expect(await screen.findByText('Dictation failed — bad-grammar')).toBeTruthy()
    expect(document.querySelector('[data-slot="dictation-overlay"]')).toBeNull()
    expect(recognition.aborted).toBe(true)
  })

  // #928: Helium (ungoogled-chromium) keeps the API but cuts the Google speech service, so
  // every attempt ends in the native `network` code — explain it, keep the draft, recover.
  it('a network error explains the speech service, keeps the draft and restores the composer', async () => {
    stubSpeech()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { textarea } = renderComposer()
    fireEvent.change(textarea, { target: { value: 'my typed draft ' } })
    const recognition = startDictation()
    act(() => recognition.onresult!(result('half heard', false)))
    act(() => recognition.onerror!({ error: 'network', message: 'service unreachable' }))

    expect(await screen.findByText(/couldn't reach this browser's speech service/)).toBeTruthy()
    expect(screen.getByText(/press Fn\/Globe twice/)).toBeTruthy()
    expect(textarea.value).toBe('my typed draft ')
    expect(document.querySelector('[data-slot="dictation-overlay"]')).toBeNull()
    expect(recognition.aborted).toBe(true)
    expect(recognition.onresult).toBeNull()
    expect(screen.getByLabelText('Send')).toBeTruthy()
    expect(screen.getByLabelText('Start dictation')).toBeTruthy()
    expect(warn).toHaveBeenCalledWith('[dictation] recognition error', 'network', 'service unreachable')
    warn.mockRestore()
  })

  it('Try again on a recognition error starts a fresh recognizer', async () => {
    stubSpeech()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderComposer()
    const first = startDictation()
    act(() => first.onerror!({ error: 'no-speech' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))

    expect(FakeRecognition.instances).toHaveLength(2)
    expect(FakeRecognition.instances[1]!.started).toBe(true)
    expect(document.querySelector('[data-slot="dictation-overlay"]')).not.toBeNull()
  })

  it('an error that a retry cannot fix offers no Try again', async () => {
    stubSpeech()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    renderComposer()
    const recognition = startDictation()
    act(() => recognition.onerror!({ error: 'language-not-supported' }))
    expect(await screen.findByText(/can't recognize speech in/)).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Try again' })).toBeNull()
  })

  it('Try again on a composer disabled since the error does not reopen the microphone', async () => {
    stubSpeech()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('[]', { status: 200 }))))
    const client = createQueryClient()
    const onSubmit = vi.fn(() => Promise.resolve({}))
    const tree = (disabled: boolean) => (
      <QueryClientProvider client={client}>
        <Composer onSubmit={onSubmit} disabled={disabled} />
        <Toaster />
      </QueryClientProvider>
    )
    const { rerender } = render(tree(false))
    const recognition = startDictation()
    act(() => recognition.onerror!({ error: 'no-speech' }))
    const retry = await screen.findByRole('button', { name: 'Try again' })
    rerender(tree(true))
    fireEvent.click(retry)
    expect(FakeRecognition.instances).toHaveLength(1)
  })

  it('Try again after the composer unmounts does not reopen the microphone', async () => {
    stubSpeech()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { unmount } = render(
      <QueryClientProvider client={createQueryClient()}>
        <Composer onSubmit={vi.fn(() => Promise.resolve({}))} />
      </QueryClientProvider>,
    )
    render(<Toaster />)
    const recognition = startDictation()
    act(() => recognition.onerror!({ error: 'no-speech' }))
    const retry = await screen.findByRole('button', { name: 'Try again' })
    unmount()
    fireEvent.click(retry)
    expect(FakeRecognition.instances).toHaveLength(1)
  })

  it('a mic that will not start (permissions) toasts honestly instead of hanging the overlay', async () => {
    stubSpeech()
    FakeRecognition.failOnStart = true
    renderComposer()
    fireEvent.click(screen.getByLabelText('Start dictation'))
    expect(
      await screen.findByText('Dictation failed — the microphone could not be started'),
    ).toBeTruthy()
    expect(document.querySelector('[data-slot="dictation-overlay"]')).toBeNull()
  })
})


it('keeps execution Stop reachable while dictating without discarding either draft (#201)', async () => {
  stubSpeech()
  const onStop = vi.fn(async () => {})
  const { textarea } = renderComposer(undefined, { onStop, stopOnEmpty: true })
  fireEvent.change(textarea, { target: { value: 'typed draft' } })
  const recognition = startDictation()
  act(() => recognition.onresult?.(result('spoken draft', true)))
  fireEvent.click(screen.getByRole('button', { name: 'Stop' }))
  await waitFor(() => expect(onStop).toHaveBeenCalledOnce())
  expect(textarea.value).toBe('typed draft')
  expect(screen.getByText('spoken draft')).toBeTruthy()
})

describe('describeDictationError', () => {
  it.each([
    ['network', /speech service/, true],
    ['service-not-allowed', /speech service/, false],
    ['not-allowed', /Microphone access is blocked/, true],
    ['audio-capture', /No microphone/, true],
    ['language-not-supported', /can't recognize speech in pl-PL/, false],
    ['no-speech', /No speech was heard/, true],
    ['bad-grammar', /^Dictation failed — bad-grammar$/, true],
    [undefined, /^Dictation failed$/, true],
  ])('%s', (code, message, retryable) => {
    const described = describeDictationError(code, 'pl-PL')
    expect(described?.message).toMatch(message)
    expect(described?.retryable).toBe(retryable)
  })

  it('stays silent on aborted: cancel already said what happened', () => {
    expect(describeDictationError('aborted', 'en-US')).toBeNull()
  })
})
