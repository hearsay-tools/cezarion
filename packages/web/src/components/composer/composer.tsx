import { useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'

import { putUiState } from '@/api/client'
import { queryKeys, useSkills, useUiState } from '@/api/queries'
import type { AttachmentInput, Skill } from '@open-mercato/cezar-api-client'
import { toast } from '@/components/ui/toaster'
import { insertTemplate } from '@/lib/prompt-templates'
import { isEditableTarget } from '@/lib/use-command-shortcut'
import { bumpSkillUsage, filterSkills, fuzzyMatch, isProjectSkill } from '@/lib/skills'
import { useNow } from '@/lib/use-now'
import { isSubmitShortcut } from '@/lib/use-submit-shortcut'

import {
  fileToPendingAttachment,
  MAX_ATTACHMENTS,
  screenFiles,
  type PendingAttachment,
} from './composer-attachments'
import { applyCompletion, detectTrigger, type TriggerState } from './composer-text'
import { useDictation } from './dictation'
import {
  ComposerDictationButton,
  ComposerEditor,
  ComposerFeedback,
  composerFinishLabel,
  ComposerFinishButton,
  ComposerFrame,
  ComposerMenuList,
  ComposerStopButton,
  ComposerSubmitRow,
} from './composer-parts'
import {
  composerAttachmentReadError,
  composerCaret,
  composerDictationBlocked,
  composerDisclosureKey,
  composerDropFiles,
  composerEditsBlocked,
  composerErrorMessage,
  composerFeedbackShown,
  composerFieldSizing,
  composerHasCompactFeedback,
  composerHasContent,
  composerLabelledStop,
  composerMergeTranscript,
  composerMobileCompact,
  composerMobileOpen,
  composerNextMenuIndex,
  composerPasteFiles,
  composerPrimaryFinish,
  composerPrimaryStop,
  composerReadOnly,
  composerRestoreText,
  composerRootClass,
  composerSendRefused,
  composerShowStop,
  composerStopRefused,
  composerSubmitLabel,
  composerVoiceClear,
  composerWidthChanged,
  type ComposerMenuCandidate,
  type ComposerSubmitMode,
} from './composer-view'

/**
 * The SHARED composer (spec §"Task thread" composer + §"New task" composer intelligence —
 * one component, two hosts): auto-growing textarea, Enter-sends / Shift+Enter-newline /
 * ⌘↵+Ctrl+↵ (`isSubmitShortcut`), attachment attach/paste/drag-drop with the legacy 4×5MB caps
 * and thumbnail row (images) or named chips (PDF/TXT/MD, #950), `/` skills autocomplete (#380),
 * `@` file mentions behind a provider seam,
 * the Dictation mic (paseo pattern), and the Alt+A / Alt+C quick replies.
 *
 * Visual contract: docs/mockups/thread.html `.composer` — card, borderless textarea, footer
 * bar with paperclip · spacer · labeled Dictation · gold send.
 */
// Session memory, matching run details: task tab navigation may remount the composer.
const mobileOpenByTask = new Map<string, boolean>()

export interface ComposerProps {
  /** Deliver the message. A rejection restores optimistic replies; retained task drafts show
   *  the error without assuming a timeout means creation failed. */
  onSubmit: (text: string, attachments: AttachmentInput[]) => Promise<unknown>
  /** Keep text and attachments visible until submission succeeds. */
  retainDraftUntilSuccess?: boolean
  /** Execution actions stay in the composer; keyboard submission never invokes Stop. */
  onStop?: (() => Promise<unknown>) | undefined
  stopOnEmpty?: boolean
  stopping?: boolean
  /**
   * Finish, as the gold primary on an EMPTY draft (#281). Passed only where the host has decided
   * the slot is free — `offersComposerFinish` — so this component never has to arbitrate between
   * Finish, Stop and Continue: whoever is handed the slot owns it. Typing anything hands it
   * straight back to Send, because a draft is an intent to say something, not to close the task.
   * Keyboard submission never invokes it, exactly as it never invokes Stop.
   */
  onFinish?: (() => Promise<unknown>) | undefined
  finishing?: boolean
  /**
   * The outline control beside the primary, for a host whose run offers no Stop (#281). Stop and
   * Archive partition the statuses — `cancel` is active, `archive` is not — so the slot holds one
   * or the other and is never contested. A node rather than a callback because the composer has
   * no business knowing what archiving is, the same seam `footerEnd` and `sessionControls` use.
   */
  secondaryAction?: ReactNode
  emptySubmitLabel?: string | undefined
  compactFeedback?: boolean
  /** Idle guidance occupies the already-reserved submission status space. */
  idleFeedback?: ReactNode
  pendingLabel?: string
  failureHint?: string | undefined
  clearOnSuccess?: boolean
  onPendingChange?: (pending: boolean) => void
  /**
   * Controlled text (pass BOTH or neither): the /new host owns the draft so it survives
   * navigation (spec: "Queued form state survives navigation"). Every internal edit — typing,
   * completions, the optimistic clear, the on-error restore — flows through `onValueChange`.
   */
  value?: string
  onValueChange?: (text: string) => void
  /** Focus the textarea on mount — the /new hero, where typing is the whole point of arriving. */
  autoFocus?: boolean
  /** Phone reading mode for task threads; /new retains its full composer. */
  mobileCollapsible?: boolean
  /** Project/run identity: disclosure changes must not remount draft or attachment state. */
  mobileDisclosureKey?: string
  /** Rendered in the footer bar after the paperclip — the /new picker pill row. */
  footerStart?: ReactNode
  /** Rendered between Dictation and the send button — the /new mode segment + kbd hint. */
  footerEnd?: ReactNode
  /** Session runner/model/effort settings, owned by the continuation hook. */
  sessionControls?: ReactNode
  /** New-task settings below a dedicated submission row; replies keep their compact footer. */
  agentOptions?: ReactNode
  executionOptions?: ReactNode
  /** The send button's accessible name. */
  sendAriaLabel?: string
  disabled?: boolean
  /** Shown as the placeholder while disabled — e.g. the legacy "Session closed — Continue to
   *  reopen." */
  disabledReason?: string | undefined
  /**
   * Let the send button fire on an empty draft. Off by default (an empty message is not a
   * message); ON for the thread's closed-but-resumable state, where submitting IS "Continue"
   * and continuing with no prompt is the legacy one-click behavior.
   */
  allowEmptySubmit?: boolean
  placeholder?: string
  ariaLabel?: string
  /** `/` opens the project-first skills autocomplete (#380). */
  autocompleteSkills?: boolean
  /** Alt+A → "Yes, approved." / Alt+C → "Continue." — the legacy quick replies, window-global
   *  while the composer is enabled. */
  quickReplies?: boolean
  /**
   * The `@` mention source seam. TODAY the thread feeds it the file paths its tool items
   * touched (real data — edit/read locations and diffs); R5's `/files` API upgrades this same
   * prop to a worktree-wide fuzzy search without touching the composer. Absent ⇒ `@` stays
   * plain text.
   */
  getMentionCandidates?: () => string[]
  /** A voice proposal is filling this draft (spec 2026-10-21-voice-mode): marks the root so the
   *  host's confirm prompt and a test can find it. Changes nothing else. */
  voiceProposal?: boolean
  /** Exposes `ComposerHandle` — see there for why this exists. */
  ref?: Ref<ComposerHandle>
}

/** The imperative seam a host needs when it wants to write INTO the draft the composer owns —
 *  today only the /new prompt-template menu (#413 follow-up), which must land a snippet at the
 *  caret the same way the GitHub composer do with their own textarea refs. */
export interface ComposerHandle {
  /** Insert `snippet` at the caret, blank-line separated (`insertTemplate`), then refocus with
   *  the caret parked end after it. */
  insertAtCaret: (snippet: string) => void
  /** The draft as the textarea shows it now. */
  getDraft: () => string
  /** Replace the draft. True when the draft now holds `text`; false (nothing written) while edits
   *  are blocked by a pending Stop or a retained send, like every other edit. */
  setDraft: (text: string) => boolean
  /** Empty the draft only when it still equals `text` (voice-owned, unedited) and no send is in
   *  flight; it does not check the Stop-pending guard. True when the draft is empty afterwards. */
  clearVoiceDraft: (text: string) => boolean
  /** Run the send button's path (`submitDraft`): the same guards, the same `onSubmit`. True when the
   *  send started; false when the composer is disabled, stopping, busy or the draft is empty. */
  submit: () => boolean
}

const QUICK_REPLIES: Record<string, string> = { KeyA: 'Yes, approved.', KeyC: 'Continue.' }

const COMPOSER_DEFAULTS = {
  retainDraftUntilSuccess: false,
  finishing: false,
  stopOnEmpty: false,
  stopping: false,
  compactFeedback: false,
  pendingLabel: 'Starting task…',
  failureHint: 'Could not confirm submission. Check Tasks before you retry. Your draft is kept.',
  clearOnSuccess: true,
  autoFocus: false,
  mobileCollapsible: false,
  sendAriaLabel: 'Send',
  disabled: false,
  disabledReason: 'Session closed — Continue to reopen.',
  allowEmptySubmit: false,
  placeholder: 'Reply — / for skills, @ for files…',
  ariaLabel: 'Reply to the agent',
  autocompleteSkills: true,
  quickReplies: false,
  voiceProposal: false,
}

function defined<T>(value: T | undefined, fallback: T): T {
  return value === undefined ? fallback : value
}

function composerInput(props: ComposerProps): Required<Pick<ComposerProps,
  'retainDraftUntilSuccess' | 'finishing' | 'stopOnEmpty' | 'stopping' | 'compactFeedback' | 'pendingLabel' | 'failureHint' | 'clearOnSuccess' | 'autoFocus' | 'mobileCollapsible' | 'sendAriaLabel' | 'disabled' | 'disabledReason' | 'allowEmptySubmit' | 'placeholder' | 'ariaLabel' | 'autocompleteSkills' | 'quickReplies' | 'voiceProposal'
>> & ComposerProps {
  return {
    ...props,
    retainDraftUntilSuccess: defined(props.retainDraftUntilSuccess, COMPOSER_DEFAULTS.retainDraftUntilSuccess),
    finishing: defined(props.finishing, COMPOSER_DEFAULTS.finishing),
    stopOnEmpty: defined(props.stopOnEmpty, COMPOSER_DEFAULTS.stopOnEmpty),
    stopping: defined(props.stopping, COMPOSER_DEFAULTS.stopping),
    compactFeedback: defined(props.compactFeedback, COMPOSER_DEFAULTS.compactFeedback),
    pendingLabel: defined(props.pendingLabel, COMPOSER_DEFAULTS.pendingLabel),
    failureHint: defined(props.failureHint, COMPOSER_DEFAULTS.failureHint),
    clearOnSuccess: defined(props.clearOnSuccess, COMPOSER_DEFAULTS.clearOnSuccess),
    autoFocus: defined(props.autoFocus, COMPOSER_DEFAULTS.autoFocus),
    mobileCollapsible: defined(props.mobileCollapsible, COMPOSER_DEFAULTS.mobileCollapsible),
    sendAriaLabel: defined(props.sendAriaLabel, COMPOSER_DEFAULTS.sendAriaLabel),
    disabled: defined(props.disabled, COMPOSER_DEFAULTS.disabled),
    disabledReason: defined(props.disabledReason, COMPOSER_DEFAULTS.disabledReason),
    allowEmptySubmit: defined(props.allowEmptySubmit, COMPOSER_DEFAULTS.allowEmptySubmit),
    placeholder: defined(props.placeholder, COMPOSER_DEFAULTS.placeholder),
    ariaLabel: defined(props.ariaLabel, COMPOSER_DEFAULTS.ariaLabel),
    autocompleteSkills: defined(props.autocompleteSkills, COMPOSER_DEFAULTS.autocompleteSkills),
    quickReplies: defined(props.quickReplies, COMPOSER_DEFAULTS.quickReplies),
    voiceProposal: defined(props.voiceProposal, COMPOSER_DEFAULTS.voiceProposal),
  }
}

function composerMenuCandidates(
  trigger: TriggerState | null,
  skills: readonly Skill[],
  skillUsage: Parameters<typeof filterSkills>[2],
  getMentionCandidates: (() => string[]) | undefined,
): ComposerMenuCandidate[] {
  if (trigger === null) return []
  if (trigger.trigger === '/') {
    return filterSkills(skills, trigger.query, skillUsage).map((skill) => ({
      value: `${skill.name} ${skill.path}`,
      insert: skill.name,
      label: skill.name,
      description: skill.description,
      emphasized: isProjectSkill(skill),
    }))
  }
  return (getMentionCandidates?.() ?? [])
    .filter((path) => fuzzyMatch(path, trigger.query))
    .map((path) => ({ value: path, insert: path, label: path, emphasized: false }))
}

function composerActiveValue(candidates: readonly ComposerMenuCandidate[], menuValue: string): string | undefined {
  return candidates.some((candidate) => candidate.value === menuValue) ? menuValue : candidates[0]?.value
}

function composerClearSuccessfulDraft(
  mounted: boolean,
  retain: boolean,
  clearOnSuccess: boolean,
  textMatches: boolean,
  imagesMatch: boolean,
  clearText: () => void,
  clearImages: () => void,
): void {
  if (!mounted || !retain || !clearOnSuccess) return
  if (textMatches) clearText()
  if (imagesMatch) clearImages()
}

function composerRestoreFailedDraft(
  retain: boolean,
  restoreOnError: boolean,
  message: string,
  messageText: string,
  messageImages: PendingAttachment[],
  setError: (message: string) => void,
  setText: (next: string | ((current: string) => string)) => void,
  setImages: (next: PendingAttachment[] | ((current: PendingAttachment[]) => PendingAttachment[])) => void,
): void {
  if (retain) {
    setError(message)
    return
  }
  toast(message, { tone: 'danger' })
  if (!restoreOnError) return
  setText((current) => composerRestoreText(current, messageText))
  setImages((current) => [...messageImages, ...current].slice(0, MAX_ATTACHMENTS))
}

function useComposerText(value: string | undefined, onValueChange: ((text: string) => void) | undefined) {
  const [internalText, setInternalText] = useState('')
  const text = value ?? internalText
  const textRef = useRef(text)
  textRef.current = text
  const onValueChangeRef = useRef(onValueChange)
  onValueChangeRef.current = onValueChange
  const setText = useCallback((next: string | ((current: string) => string)) => {
    const resolved = typeof next === 'function' ? next(textRef.current) : next
    setInternalText(resolved)
    onValueChangeRef.current?.(resolved)
  }, [])
  return { text, textRef, setText }
}

export function Composer(props: ComposerProps) {
  const {
    onSubmit, retainDraftUntilSuccess, onStop, onFinish, finishing, secondaryAction, stopOnEmpty,
    stopping, emptySubmitLabel, compactFeedback, idleFeedback, pendingLabel, failureHint,
    clearOnSuccess, onPendingChange, value, onValueChange, autoFocus, mobileCollapsible,
    mobileDisclosureKey, footerStart, footerEnd, sessionControls, executionOptions, agentOptions,
    sendAriaLabel, disabled, disabledReason, allowEmptySubmit, placeholder, ariaLabel,
    autocompleteSkills, quickReplies, getMentionCandidates, voiceProposal, ref,
  } = composerInput(props)
  const { text, textRef, setText } = useComposerText(value, onValueChange)
  const [images, setImages] = useState<PendingAttachment[]>([])
  // Mirrors `images` for reads inside event handlers that must not run through a setState updater
  // (StrictMode double-invokes those in dev — see addFiles / #double-paste).
  const imagesRef = useRef(images)
  imagesRef.current = images
  const [stoppingLocally, setStoppingLocally] = useState(false)
  const stopPending = stopping || stoppingLocally
  const stopPendingRef = useRef(stopPending)
  stopPendingRef.current = stopPending
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const attachmentEpoch = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const editsBlocked = () => composerEditsBlocked(stopPendingRef.current, retainDraftUntilSuccess, busyRef.current)
  const [trigger, setTrigger] = useState<TriggerState | null>(null)
  const [menuValue, setMenuValue] = useState('')
  // Skills load on the FIRST `/` trigger and stay cached — not on every thread visit.
  const [skillsWanted, setSkillsWanted] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const textareaId = useId()
  const optionsId = useId()
  const attachInputRef = useRef<HTMLInputElement>(null)
  const localMobileDisclosures = useRef(new Map<string, boolean>())
  const mobileDisclosures = mobileDisclosureKey === undefined ? localMobileDisclosures.current : mobileOpenByTask
  const disclosureKey = composerDisclosureKey(mobileDisclosureKey)
  const [, bumpMobileDisclosure] = useReducer((count: number) => count + 1, 0)
  const mobileOpen = composerMobileOpen(mobileDisclosures, disclosureKey)
  const rootRef = useRef<HTMLDivElement>(null)
  const menuListRef = useRef<HTMLDivElement>(null)
  const pendingCaretRef = useRef<number | null>(null)

  const skills = useSkills(autocompleteSkills && skillsWanted)
  const uiState = useUiState()
  const queryClient = useQueryClient()
  const disabledRef = useRef(disabled)
  disabledRef.current = disabled
  const dictation = useDictation((message, retry) =>
    toast(message, {
      tone: 'danger',
      ...(retry
        ? { action: { label: 'Try again', onAction: () => { if (!disabledRef.current && !editsBlocked()) retry() } } }
        : {}),
    }),
  )

  // On-mount only, by design: re-focusing on a later `autoFocus` flip would steal focus mid-visit.
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, []) // deliberately not [autoFocus]

  const syncTrigger = useCallback(() => {
    const element = textareaRef.current
    if (!element || disabled || editsBlocked()) {
      setTrigger(null)
      return
    }
    const next = detectTrigger(element.value, composerCaret(element.selectionStart, element.value.length))
    if (next?.trigger === '/' && !autocompleteSkills) return setTrigger(null)
    if (next?.trigger === '@' && getMentionCandidates === undefined) return setTrigger(null)
    if (next?.trigger === '/') setSkillsWanted(true)
    setTrigger(next)
  }, [autocompleteSkills, disabled, getMentionCandidates, retainDraftUntilSuccess])

  const candidates = useMemo(
    () => composerMenuCandidates(trigger, skills.data ?? [], uiState.data?.skillUsage, getMentionCandidates),
    [getMentionCandidates, skills.data, trigger, uiState.data?.skillUsage],
  )
  const activeValue = composerActiveValue(candidates, menuValue)
  const menuOpen = trigger !== null

  useLayoutEffect(() => {
    if (!menuOpen || !activeValue) return
    const items = menuListRef.current?.querySelectorAll('[data-slot="composer-menu-item"]')
    const selected = [...(items ?? [])].find((item) => item.getAttribute('data-value') === activeValue)
    selected?.scrollIntoView({ block: 'nearest' })
  }, [activeValue, menuOpen])

  const closeMenu = useCallback(() => setTrigger(null), [])

  const pick = (candidate: ComposerMenuCandidate) => {
    const element = textareaRef.current
    if (!element || trigger === null || editsBlocked()) return
    const caret = composerCaret(element.selectionStart, element.value.length)
    const next = applyCompletion(element.value, trigger, caret, candidate.insert)
    if (trigger.trigger === '/' && uiState.data !== undefined) {
      putUiState({ skillUsage: bumpSkillUsage(uiState.data.skillUsage, candidate.insert) })
        .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
        .catch(() => {})
    }
    setText(next.text)
    pendingCaretRef.current = next.caret
    setTrigger(null)
    element.focus()
  }

  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    const element = textareaRef.current
    if (caret !== null && element) {
      element.setSelectionRange(caret, caret)
      pendingCaretRef.current = null
    }
  }, [text])

  useLayoutEffect(() => {
    const element = textareaRef.current
    if (!element || composerFieldSizing()) return
    const resize = () => {
      element.style.height = 'auto'
      element.style.height = `${Math.min(element.scrollHeight, 220)}px`
    }
    resize()
    let width = element.clientWidth
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => {
      if (!composerWidthChanged(element.clientWidth, width)) return
      width = element.clientWidth
      resize()
    })
    observer?.observe(element)
    let disposed = false
    void document.fonts?.ready.then(() => { if (!disposed) resize() })
    return () => { disposed = true; observer?.disconnect() }
  }, [text, mobileOpen])

  const addFiles = useCallback((files: readonly File[]) => {
    if (disabled || editsBlocked()) return
    const epoch = attachmentEpoch.current
    const intake = screenFiles(files, imagesRef.current.length)
    for (const reason of intake.rejected) toast(reason, { tone: 'danger' })
    for (const file of intake.accepted) {
      void fileToPendingAttachment(file).then(
        (attachment) => {
          const stale = !mounted.current
            || (retainDraftUntilSuccess && busyRef.current && !stopPendingRef.current)
            || epoch !== attachmentEpoch.current
          if (stale) return
          setImages((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, attachment]))
        },
        () => toast(composerAttachmentReadError(file.name), { tone: 'danger' }),
      )
    }
  }, [disabled, retainDraftUntilSuccess])

  const onDrop = (event: DragEvent) => {
    const files = composerDropFiles(event.dataTransfer?.files)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  const sendRefused = useCallback(
    (messageText: string, messageImages: PendingAttachment[]) => composerSendRefused(
      disabled, stopping, busyRef.current, allowEmptySubmit, messageText, messageImages.length,
    ),
    [disabled, stopping, allowEmptySubmit],
  )

  const send = useCallback(async (messageText: string, messageImages: PendingAttachment[], restoreOnError: boolean) => {
    const body = messageText.trim()
    if (sendRefused(messageText, messageImages)) return
    busyRef.current = true
    if (retainDraftUntilSuccess) attachmentEpoch.current += 1
    setBusy(true)
    setSubmissionError(null)
    onPendingChange?.(true)
    setTrigger(null)
    if (restoreOnError && !retainDraftUntilSuccess) {
      setText('')
      setImages([])
    }
    try {
      await onSubmit(body, messageImages.map(({ mediaType, data }) => ({ mediaType, data })))
      composerClearSuccessfulDraft(
        mounted.current, retainDraftUntilSuccess, clearOnSuccess,
        textRef.current === messageText, imagesRef.current === messageImages,
        () => setText(''), () => setImages([]),
      )
    } catch (error) {
      if (!mounted.current && retainDraftUntilSuccess) return
      composerRestoreFailedDraft(
        retainDraftUntilSuccess, restoreOnError, composerErrorMessage(error), messageText, messageImages,
        setSubmissionError, setText, setImages,
      )
    } finally {
      busyRef.current = false
      if (mounted.current) {
        onPendingChange?.(false)
        setBusy(false)
      }
    }
  }, [sendRefused, onSubmit, retainDraftUntilSuccess, clearOnSuccess, onPendingChange, setText])

  const submitDraft = useCallback(() => {
    if (sendRefused(textRef.current, imagesRef.current)) return false
    void send(textRef.current, imagesRef.current, true)
    return true
  }, [sendRefused, send])

  useImperativeHandle(ref, () => ({
    insertAtCaret: (snippet: string) => {
      if (editsBlocked()) return
      const element = textareaRef.current
      const caret = composerCaret(element?.selectionStart ?? null, textRef.current.length)
      const result = insertTemplate(textRef.current, caret, snippet)
      setText(result.text)
      pendingCaretRef.current = result.caret
      element?.focus()
    },
    getDraft: () => textRef.current,
    setDraft: (next: string) => {
      if (editsBlocked()) return false
      setText(next)
      return true
    },
    clearVoiceDraft: (voiceText: string) => {
      const outcome = composerVoiceClear(textRef.current, busyRef.current, voiceText)
      if (outcome === 'empty') return true
      if (outcome === 'blocked') return false
      setText('')
      return true
    },
    submit: submitDraft,
  }), [setText, retainDraftUntilSuccess, submitDraft])

  const stop = async () => {
    if (composerStopRefused(onStop, stopping, busyRef.current)) return
    busyRef.current = true
    setBusy(true)
    setStoppingLocally(true)
    setSubmissionError(null)
    try {
      await onStop?.()
    } catch (error) {
      if (mounted.current) setSubmissionError(composerErrorMessage(error))
    } finally {
      busyRef.current = false
      if (mounted.current) {
        setBusy(false)
        setStoppingLocally(false)
      }
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen && moveMenu(event)) return
    if (!isSubmitShortcut(submitEvent(event))) return
    event.preventDefault()
    submitDraft()
  }

  const moveMenu = (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      if (candidates.length === 0) return true
      const at = candidates.findIndex((candidate) => candidate.value === activeValue)
      const delta = event.key === 'ArrowDown' ? 1 : -1
      const next = candidates[composerNextMenuIndex(at, delta, candidates.length)]!
      setMenuValue(next.value)
      return true
    }
    if (event.key === 'Escape') {
      event.preventDefault()
      closeMenu()
      return true
    }
    if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
      const active = candidates.find((candidate) => candidate.value === activeValue)
      if (active) {
        event.preventDefault()
        pick(active)
        return true
      }
      closeMenu()
    }
    return false
  }

  useEffect(() => {
    if (!quickReplies || disabled) return
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.repeat) return
      if (isEditableTarget(event.target)) return
      const reply = QUICK_REPLIES[event.code]
      if (reply === undefined) return
      event.preventDefault()
      void send(reply, [], false)
    }
    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [disabled, quickReplies, send])

  const insertTranscript = (alsoSend: boolean) => {
    if (composerDictationBlocked(disabled, stopPendingRef.current, busyRef.current, alsoSend, retainDraftUntilSuccess)) return
    const transcript = dictation.finish()
    if (transcript === '') return
    const merged = composerMergeTranscript(text, transcript)
    if (alsoSend) {
      if (retainDraftUntilSuccess) setText(merged)
      void send(merged, images, true)
      return
    }
    setText(merged)
    pendingCaretRef.current = merged.length
    textareaRef.current?.focus()
  }

  const hasContent = composerHasContent(text, images.length)
  const primaryStop = composerPrimaryStop(hasContent, onStop, stopOnEmpty, stopPending)
  const primaryFinish = composerPrimaryFinish(hasContent, primaryStop, onFinish)
  const mode: ComposerSubmitMode = {
    hasContent,
    primaryStop,
    primaryFinish,
    labelledStop: composerLabelledStop(primaryStop, primaryFinish, hasContent, emptySubmitLabel),
    submitLabel: composerSubmitLabel(hasContent, emptySubmitLabel, sendAriaLabel),
    busy,
    stopPending,
    finishing,
    finishLabel: composerFinishLabel(finishing),
    finishTitle: 'Close the session and mark this task done',
    disabled,
    allowEmptySubmit,
    readOnly: composerReadOnly(stopPending, retainDraftUntilSuccess, busy),
    mobileCompact: composerMobileCompact(mobileCollapsible, mobileOpen),
    mobileCollapsible,
    executionOptions: executionOptions != null,
    sessionControls: sessionControls != null,
    showStop: composerShowStop(onStop, stopPending),
  }
  const recording = dictation.recording
  const now = useNow(1000)
  const dictationButton = dictation.supported ? <ComposerDictationButton mode={mode} onStart={() => { if (!editsBlocked()) dictation.start() }} /> : null
  const finishControl = mode.primaryFinish ? <ComposerFinishButton mode={mode} onFinish={() => void onFinish?.()} /> : null
  const stopControl = mode.showStop ? <ComposerStopButton mode={mode} onStop={() => void stop()} /> : null
  const feedback = (
    <ComposerFeedback
      shown={composerFeedbackShown(retainDraftUntilSuccess, onStop, stopping)}
      compactFeedback={compactFeedback}
      hasCompactFeedback={composerHasCompactFeedback(stopPending, busy, submissionError, idleFeedback)}
      textareaId={textareaId}
      submissionError={submissionError}
      stopPending={stopPending}
      busy={busy}
      pendingLabel={pendingLabel}
      failureHint={failureHint}
      idleFeedback={idleFeedback}
    />
  )
  const submissionControls = (
    <ComposerSubmitRow
      mode={mode}
      emptySubmitLabel={emptySubmitLabel}
      optionsId={optionsId}
      dictationButton={dictationButton}
      footerEnd={footerEnd}
      stopControl={stopControl}
      secondaryAction={secondaryAction}
      finishControl={finishControl}
      onSubmit={submitDraft}
    />
  )

  return (
    <ComposerFrame
      open={menuOpen}
      onClose={closeMenu}
      rootRef={rootRef}
      disabled={disabled}
      voiceProposal={voiceProposal}
      onDrop={onDrop}
      className={composerRootClass(executionOptions, sessionControls, disabled)}
      menu={(
        <ComposerMenuList
          menuListRef={menuListRef}
          trigger={trigger?.trigger}
          activeValue={activeValue}
          skillsPending={skills.isPending}
          candidates={candidates}
          onValueChange={setMenuValue}
          onPick={pick}
        />
      )}
    >
      <ComposerEditor
        mode={mode}
        executionOptions={executionOptions}
        sessionControls={sessionControls}
        images={images}
        onRemoveImage={(index) => { if (!editsBlocked()) setImages((current) => current.filter((_, item) => item !== index)) }}
        textareaId={textareaId}
        textareaRef={textareaRef}
        text={text}
        disabled={disabled}
        retainDraftUntilSuccess={retainDraftUntilSuccess}
        ariaLabel={ariaLabel}
        disabledReason={disabledReason}
        placeholder={placeholder}
        onTextChange={(next) => { if (!editsBlocked()) { setText(next); syncTrigger() } }}
        onKeyDown={onKeyDown}
        onSelect={syncTrigger}
        onPaste={(event) => {
          const files = composerPasteFiles(event.clipboardData?.items)
          if (files.length === 0) return
          event.preventDefault()
          addFiles(files)
        }}
        recording={recording}
        onCancelDictation={dictation.cancel}
        onInsertTranscript={() => insertTranscript(false)}
        onInsertAndSend={() => insertTranscript(true)}
        now={now}
        stopControl={stopControl}
        mobileCollapsible={mobileCollapsible}
        mobileOpen={mobileOpen}
        optionsId={optionsId}
        footerEnd={footerEnd}
        onToggleMobile={() => { mobileDisclosures.set(disclosureKey, !mobileOpen); bumpMobileDisclosure() }}
        footerStart={footerStart}
        attachInputRef={attachInputRef}
        addFiles={addFiles}
        dictationButton={dictationButton}
        submissionControls={submissionControls}
        feedback={feedback}
        agentOptions={agentOptions}
      />
    </ComposerFrame>
  )
}

function submitEvent(event: KeyboardEvent<HTMLTextAreaElement>) {
  return {
    key: event.key,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    repeat: event.repeat,
    isComposing: event.nativeEvent.isComposing,
  }
}
