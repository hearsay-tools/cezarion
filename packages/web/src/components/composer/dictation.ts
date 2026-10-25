import * as React from 'react'

/**
 * Dictation (spec §composer intelligence; the paseo pattern, `paseo-ui.md` §5): STT-only,
 * push-to-talk into the text box — never a hands-free voice mode. The composer shows a mic
 * labeled **Dictation**; recording swaps the composer footer for an overlay (pulsing
 * indicator, mm:ss timer, growing partial transcript, cancel / insert / insert-and-send).
 *
 * The browser seam is the Web Speech API. This module wraps it structurally so:
 *  - support detection is one honest function (mic hidden entirely when absent — no fake), and
 *  - tests stub `window.SpeechRecognition` with a plain class and drive `onresult`/`onerror`
 *    directly, no vendor globals or DOM events required.
 */

/** One recognized alternative. */
interface SpeechAlternativeLike {
  transcript: string
}

/** One result: indexable (best alternative at 0) + finality flag. */
interface SpeechResultLike {
  readonly isFinal: boolean
  readonly [index: number]: SpeechAlternativeLike
}

export interface SpeechResultEventLike {
  readonly resultIndex: number
  readonly results: {
    readonly length: number
    readonly [index: number]: SpeechResultLike
  }
}

/** The structural subset of `SpeechRecognition` the hook drives. */
export interface SpeechRecognitionLike {
  lang: string
  continuous: boolean
  interimResults: boolean
  start(): void
  stop(): void
  abort(): void
  onresult: ((event: SpeechResultEventLike) => void) | null
  onerror: ((event: { error?: string | undefined; message?: string }) => void) | null
  onend: (() => void) | null
}

export type SpeechRecognitionCtor = new () => SpeechRecognitionLike

/** The one place the vendor globals are read — at call time, so a test that stubs the global
 *  before clicking the mic is enough. Chrome/Safari ship the `webkit` name; Firefox neither. */
export function speechRecognitionCtor(): SpeechRecognitionCtor | undefined {
  const w = window as {
    SpeechRecognition?: SpeechRecognitionCtor
    webkitSpeechRecognition?: SpeechRecognitionCtor
  }
  return w.SpeechRecognition ?? w.webkitSpeechRecognition
}

export interface DictationState {
  /** Everything finalized so far + the current interim tail — what the overlay shows and what
   *  insert/insert-and-send deliver. */
  transcript: string
  /** Epoch ms when recording started — the overlay derives its mm:ss from it. */
  startedAt: number
}

export interface Dictation {
  /** undefined ⇒ the API is absent; the mic must not render at all. */
  supported: boolean
  /** null ⇒ idle. */
  recording: DictationState | null
  start(): void
  /** ✕ — discard everything, back to idle. */
  cancel(): void
  /** ✓ / ↑ — stop and hand back the transcript (possibly '' when nothing was heard). */
  finish(): string
}

/** Fold a result event into (final, interim): results before `resultIndex` are already folded;
 *  from it on, finals append and interims replace the tail. Exported for the table test. */
export function foldResults(
  finalText: string,
  event: SpeechResultEventLike,
): { finalText: string; interim: string } {
  let finals = finalText
  let interim = ''
  for (let i = event.resultIndex; i < event.results.length; i += 1) {
    const result = event.results[i]!
    const piece = result[0]?.transcript ?? ''
    if (result.isFinal) finals += piece
    else interim += piece
  }
  return { finalText: finals, interim }
}

/** What the composer tells the user about a failed recognition, and whether trying again can
 *  help. */
export interface DictationError {
  message: string
  retryable: boolean
}

/**
 * Plain words for the native `SpeechRecognitionErrorEvent.error` codes (#928). `null` means stay
 * silent. `network` is the common one: Chrome sends audio to a Google speech service, and
 * Chromium builds that cut Google services (Helium, ungoogled-chromium) keep the API but fail
 * every attempt with it, however healthy the cockpit connection is. An unknown code keeps the
 * browser's own word.
 */
export function describeDictationError(code: string | undefined, lang: string): DictationError | null {
  switch (code) {
    case 'aborted':
      return null
    case 'network':
    case 'service-not-allowed':
      return {
        message:
          "Dictation couldn't reach this browser's speech service. Some Chromium builds, such as Helium, block it. " +
          'Use your system dictation instead (macOS: press Fn/Globe twice), or open the cockpit in Chrome or Safari.',
        // `network` can be a passing outage in Chrome; a refused service stays refused.
        retryable: code === 'network',
      }
    case 'not-allowed':
      return {
        message: "Microphone access is blocked. Allow it in this site's browser settings, then try again.",
        retryable: true,
      }
    case 'audio-capture':
      return { message: 'No microphone was found. Connect one, then try again.', retryable: true }
    case 'language-not-supported':
      return {
        message: `This browser can't recognize speech in ${lang}. Use your system dictation instead (macOS: press Fn/Globe twice).`,
        retryable: false,
      }
    case 'no-speech':
      return { message: 'No speech was heard. Check the microphone, then try again.', retryable: true }
    default:
      return { message: `Dictation failed${code ? ` — ${code}` : ''}`, retryable: true }
  }
}

/** `retry` restarts dictation; present only when the error is one trying again can fix. */
export function useDictation(onError: (message: string, retry?: () => void) => void): Dictation {
  const [recording, setRecording] = React.useState<DictationState | null>(null)
  const recognitionRef = React.useRef<SpeechRecognitionLike | null>(null)
  const finalRef = React.useRef('')
  // A toast's Try again can outlive the composer; it must not reopen the mic after unmount.
  const mountedRef = React.useRef(false)
  const startRef = React.useRef<() => void>(() => {})
  // The mic renders (or not) per browser capability; the ctor itself is re-read on start so a
  // test stub installed after mount still wins.
  const [supported] = React.useState(() => speechRecognitionCtor() !== undefined)

  const teardown = React.useCallback(() => {
    const recognition = recognitionRef.current
    recognitionRef.current = null
    finalRef.current = ''
    setRecording(null)
    if (recognition) {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.abort()
    }
  }, [])

  // An unmounted composer must not keep the mic hot.
  React.useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      teardown()
    }
  }, [teardown])

  const retry = React.useCallback(() => startRef.current(), [])

  const start = React.useCallback(() => {
    if (!mountedRef.current || recognitionRef.current) return
    const Ctor = speechRecognitionCtor()
    if (!Ctor) return
    let recognition: SpeechRecognitionLike
    try {
      recognition = new Ctor()
      recognition.lang = navigator.language || 'en-US'
      recognition.continuous = true
      recognition.interimResults = true
      const startedAt = Date.now()
      recognition.onresult = (event) => {
        const folded = foldResults(finalRef.current, event)
        finalRef.current = folded.finalText
        setRecording({ transcript: folded.finalText + folded.interim, startedAt })
      }
      recognition.onerror = (event) => {
        // The native details, so the next report carries what the toast summarizes.
        console.warn('[dictation] recognition error', event.error, event.message)
        const described = describeDictationError(event.error, recognition.lang)
        teardown()
        if (described) onError(described.message, described.retryable ? retry : undefined)
      }
      recognition.start()
      recognitionRef.current = recognition
      setRecording({ transcript: '', startedAt })
    } catch {
      onError('Dictation failed — the microphone could not be started', retry)
      teardown()
    }
  }, [onError, retry, teardown])
  startRef.current = start

  const cancel = React.useCallback(() => teardown(), [teardown])

  const finish = React.useCallback((): string => {
    const recognition = recognitionRef.current
    const transcript = (finalRef.current + '').trim() === '' ? '' : finalRef.current
    // Prefer what the state saw last (finals + interim tail): stop() would eventually finalize
    // the tail, but the user already chose to take what is on screen.
    const onScreen = recording?.transcript ?? transcript
    if (recognition) {
      recognition.onresult = null
      recognition.onerror = null
      recognition.onend = null
      recognition.stop()
    }
    recognitionRef.current = null
    finalRef.current = ''
    setRecording(null)
    return onScreen.trim()
  }, [recording])

  return { supported, recording, start, cancel, finish }
}

/** mm:ss for the overlay timer. */
export function formatElapsed(startedAt: number, now: number): string {
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000))
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`
}
