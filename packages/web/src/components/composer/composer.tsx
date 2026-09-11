import { useQueryClient } from '@tanstack/react-query'
import { ArrowUpIcon, CheckIcon, ChevronDownIcon, MicIcon, PaperclipIcon, PlayIcon, SquareIcon, XIcon } from 'lucide-react'
import {
  useCallback,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useReducer,
  useState,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from 'react'

import { putUiState } from '@/api/client'
import { queryKeys, useSkills, useUiState } from '@/api/queries'
import type { AttachmentInput } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'
import { toast } from '@/components/ui/toaster'
import { insertTemplate } from '@/lib/prompt-templates'
import { isEditableTarget } from '@/lib/use-command-shortcut'
import { bumpSkillUsage, filterSkills, fuzzyMatch, isProjectSkill } from '@/lib/skills'
import { useNow } from '@/lib/use-now'
import { isSubmitShortcut } from '@/lib/use-submit-shortcut'
import { cn } from '@/lib/utils'

import {
  fileToPendingAttachment,
  MAX_ATTACHMENTS,
  screenFiles,
  type PendingAttachment,
} from './composer-attachments'
import { applyCompletion, detectTrigger, type TriggerState } from './composer-text'
import { formatElapsed, useDictation } from './dictation'

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
  onStop?: () => Promise<unknown>
  stopOnEmpty?: boolean
  stopping?: boolean
  emptySubmitLabel?: string
  compactFeedback?: boolean
  pendingLabel?: string
  failureHint?: string
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
  /** New-task settings below a dedicated submission row; replies keep their compact footer. */
  executionOptions?: ReactNode
  /** The send button's accessible name. */
  sendAriaLabel?: string
  disabled?: boolean
  /** Shown as the placeholder while disabled — e.g. the legacy "Session closed — Continue to
   *  reopen." */
  disabledReason?: string
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
  /** Exposes `ComposerHandle` — see there for why this exists. */
  ref?: Ref<ComposerHandle>
}

/** The imperative seam a host needs when it wants to write INTO the draft the composer owns —
 *  today only the /new prompt-template menu (#413 follow-up), which must land a snippet at the
 *  caret the same way the GitHub/Inbox composers do with their own textarea refs. */
export interface ComposerHandle {
  /** Insert `snippet` at the caret, blank-line separated (`insertTemplate`), then refocus with
   *  the caret parked right after it. */
  insertAtCaret: (snippet: string) => void
}

const QUICK_REPLIES: Record<string, string> = { KeyA: 'Yes, approved.', KeyC: 'Continue.' }

export function Composer({
  onSubmit,
  retainDraftUntilSuccess = false,
  onStop,
  stopOnEmpty = false,
  stopping = false,
  emptySubmitLabel,
  compactFeedback = false,
  pendingLabel = 'Starting task…',
  failureHint = 'Could not confirm submission. Check Tasks before you retry. Your draft is kept.',
  clearOnSuccess = true,
  onPendingChange,
  value,
  onValueChange,
  autoFocus = false,
  mobileCollapsible = false,
  mobileDisclosureKey,
  footerStart,
  footerEnd,
  executionOptions,
  sendAriaLabel = 'Send',
  disabled = false,
  disabledReason = 'Session closed — Continue to reopen.',
  allowEmptySubmit = false,
  placeholder = 'Reply — / for skills, @ for files…',
  ariaLabel = 'Reply to the agent',
  autocompleteSkills = true,
  quickReplies = false,
  getMentionCandidates,
  ref,
}: ComposerProps) {
  // Optionally controlled: `value` (when given) shadows the internal state, and every write is
  // mirrored to both — updater functions resolve against whichever is authoritative right now.
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
  const [images, setImages] = useState<PendingAttachment[]>([])
  // Mirrors `images` for reads inside event handlers that must not run through a setState updater
  // (StrictMode double-invokes those in dev — see addFiles / #double-paste).
  const imagesRef = useRef(images)
  imagesRef.current = images
  const [stoppingLocally, setStoppingLocally] = useState(false)
  const stopPending = stopping || stoppingLocally
  const stopPendingRef = useRef(stopPending)
  stopPendingRef.current = stopPending
  const hasContent = text.trim() !== '' || images.length > 0
  const primaryStop = !hasContent && ((onStop !== undefined && stopOnEmpty) || stopPending)
  const submitLabel = !hasContent && emptySubmitLabel ? emptySubmitLabel : sendAriaLabel
  const [busy, setBusy] = useState(false)
  const busyRef = useRef(false)
  const attachmentEpoch = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => { mounted.current = false }
  }, [])
  const [submissionError, setSubmissionError] = useState<string | null>(null)
  const readOnly = stopPending || (retainDraftUntilSuccess && busy)
  const editsBlocked = () => stopPendingRef.current || (retainDraftUntilSuccess && busyRef.current)
  const [trigger, setTrigger] = useState<TriggerState | null>(null)
  const [menuValue, setMenuValue] = useState('')
  // Skills load on the FIRST `/` trigger and stay cached — not on every thread visit.
  const [skillsWanted, setSkillsWanted] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const textareaId = useId()
  const optionsId = useId()
  const localMobileDisclosures = useRef(new Map<string, boolean>())
  const mobileDisclosures = mobileDisclosureKey === undefined ? localMobileDisclosures.current : mobileOpenByTask
  const disclosureKey = mobileDisclosureKey ?? 'default'
  const [, bumpMobileDisclosure] = useReducer((n: number) => n + 1, 0)
  const mobileOpen = mobileDisclosures.get(disclosureKey) ?? false
  const mobileCompact = mobileCollapsible && !mobileOpen
  const rootRef = useRef<HTMLDivElement>(null)
  const pendingCaretRef = useRef<number | null>(null)

  const skills = useSkills(autocompleteSkills && skillsWanted)
  // The `/` list orders most-used first (#519) and a pick bumps `skillUsage`, so this — the
  // highest-traffic skill surface — both reads and feeds the same stats as the pickers.
  const uiState = useUiState()
  const queryClient = useQueryClient()
  const dictation = useDictation((message) => toast(message, { tone: 'danger' }))

  // On-mount only, by design: re-focusing on a later `autoFocus` flip would steal focus mid-visit.
  useEffect(() => {
    if (autoFocus) textareaRef.current?.focus()
  }, []) // deliberately not [autoFocus]

  // Rides the same `pendingCaretRef` + layout-effect restore the `/` autocomplete uses, rather
  // than a rAF: the caret is set in the same paint as the text, so there is no window in which a
  // closing dropdown can take the focus back (the QA finding on #413's first cut).
  useImperativeHandle(
    ref,
    () => ({
      insertAtCaret: (snippet: string) => {
        if (editsBlocked()) return
        const el = textareaRef.current
        const result = insertTemplate(textRef.current, el?.selectionStart ?? textRef.current.length, snippet)
        setText(result.text)
        pendingCaretRef.current = result.caret
        el?.focus()
      },
    }),
    [setText, retainDraftUntilSuccess],
  )

  // ---- autocomplete ------------------------------------------------------------------------

  /** Re-read the trigger from the real textarea (value + caret) — the one source of truth. */
  const syncTrigger = useCallback(() => {
    const el = textareaRef.current
    if (!el || disabled || editsBlocked()) {
      setTrigger(null)
      return
    }
    const next = detectTrigger(el.value, el.selectionStart ?? el.value.length)
    if (next?.trigger === '/' && !autocompleteSkills) return setTrigger(null)
    if (next?.trigger === '@' && getMentionCandidates === undefined) return setTrigger(null)
    if (next?.trigger === '/') setSkillsWanted(true)
    setTrigger(next)
  }, [autocompleteSkills, disabled, getMentionCandidates, retainDraftUntilSuccess])

  interface MenuCandidate {
    value: string
    insert: string
    label: string
    description?: string
    emphasized: boolean
  }

  const candidates = useMemo((): MenuCandidate[] => {
    if (trigger === null) return []
    if (trigger.trigger === '/') {
      return filterSkills(skills.data ?? [], trigger.query, uiState.data?.skillUsage).map((skill) => ({
        // The path suffix keeps values unique when a project skill shadows a global one.
        value: `${skill.name} ${skill.path}`,
        insert: skill.name,
        label: skill.name,
        description: skill.description,
        emphasized: isProjectSkill(skill),
      }))
    }
    const paths = getMentionCandidates?.() ?? []
    return paths
      .filter((path) => fuzzyMatch(path, trigger.query))
      .map((path) => ({ value: path, insert: path, label: path, emphasized: false }))
  }, [getMentionCandidates, skills.data, trigger, uiState.data?.skillUsage])

  const activeValue = candidates.some((c) => c.value === menuValue)
    ? menuValue
    : candidates[0]?.value
  const menuOpen = trigger !== null

  const closeMenu = useCallback(() => setTrigger(null), [])

  const pick = (candidate: MenuCandidate) => {
    const el = textareaRef.current
    if (!el || trigger === null || editsBlocked()) return
    const caret = el.selectionStart ?? el.value.length
    const next = applyCompletion(el.value, trigger, caret, candidate.insert)
    // Frequency sort (#519): a `/` completion is a skill pick, so it counts — same guard as
    // /new's submit (#408): only bump once the CURRENT map is known. The PUT merge is shallow,
    // so bumping off an unresolved/errored ui-state query would send a one-entry map and wipe
    // every accumulated count. Fire-and-forget; a lost bump costs one count, nothing more.
    if (trigger.trigger === '/' && uiState.data !== undefined) {
      putUiState({ skillUsage: bumpSkillUsage(uiState.data.skillUsage, candidate.insert) })
        .then(() => queryClient.invalidateQueries({ queryKey: queryKeys.uiState }))
        .catch(() => {})
    }
    setText(next.text)
    pendingCaretRef.current = next.caret
    setTrigger(null)
    el.focus()
  }

  // Restore the caret after a completion replaced the token mid-draft.
  useLayoutEffect(() => {
    const caret = pendingCaretRef.current
    const el = textareaRef.current
    if (caret !== null && el) {
      el.setSelectionRange(caret, caret)
      pendingCaretRef.current = null
    }
  }, [text])

  // ---- sizing (44px phone / 54px desktop; CSS caps reading mode without remounting) ----------

  useLayoutEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${Math.min(el.scrollHeight, 220)}px`
  }, [text, mobileOpen])

  // ---- attachments ---------------------------------------------------------------------------

  const addFiles = useCallback(
    (files: readonly File[]) => {
      if (disabled || editsBlocked()) return
      const epoch = attachmentEpoch.current
      // Side effects (screening toasts + async encode) run OUTSIDE any setState updater: React
      // StrictMode double-invokes updater functions in dev, so screening here would encode and
      // append each pasted file twice (#double-paste). `imagesRef` gives the current count
      // without reading through state; each async append re-checks the cap functionally.
      const intake = screenFiles(files, imagesRef.current.length)
      for (const reason of intake.rejected) toast(reason, { tone: 'danger' })
      for (const file of intake.accepted) {
        void fileToPendingAttachment(file).then(
          (attachment) => {
            // Stop never submits the draft: finish reads already accepted before it.
            if (!mounted.current || (retainDraftUntilSuccess && busyRef.current && !stopPendingRef.current) || epoch !== attachmentEpoch.current) return
            setImages((prev) => (prev.length >= MAX_ATTACHMENTS ? prev : [...prev, attachment]))
          },
          () => toast(`${file.name || 'Attachment'} could not be read — try attaching it again`, { tone: 'danger' }),
        )
      }
    },
    [disabled, retainDraftUntilSuccess],
  )

  const onPaste = (event: ClipboardEvent) => {
    // `kind: 'file'` rather than an `image/` type test (#950): the clipboard carries a pasted
    // `.md` as a file item too, and `screenFiles` is what decides whether cezar takes it. The
    // text half of the clipboard is left alone so an ordinary ⌘V still types.
    const files = [...(event.clipboardData?.items ?? [])]
      .filter((item) => item.kind === 'file')
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null)
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  const onDrop = (event: DragEvent) => {
    const files = [...(event.dataTransfer?.files ?? [])]
    if (files.length === 0) return
    event.preventDefault()
    addFiles(files)
  }

  // ---- submit --------------------------------------------------------------------------------

  const send = useCallback(
    async (messageText: string, messageImages: PendingAttachment[], restoreOnError: boolean) => {
      const body = messageText.trim()
      if (disabled || stopping || busyRef.current) return
      if (body === '' && messageImages.length === 0 && !allowEmptySubmit) return
      // Lock before any callback/state update: two keyboard events can share a render.
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
        if (mounted.current && retainDraftUntilSuccess && clearOnSuccess) {
          // A controlled host may have supplied a newer draft while the request was pending.
          if (textRef.current === messageText) setText('')
          if (imagesRef.current === messageImages) setImages([])
        }
      } catch (error) {
        if (!mounted.current && retainDraftUntilSuccess) return
        const message = error instanceof Error ? error.message : String(error)
        if (retainDraftUntilSuccess) {
          setSubmissionError(message)
        } else {
          toast(message, { tone: 'danger' })
          if (restoreOnError) {
            setText((current) => (current === '' ? messageText : `${messageText}\n${current}`))
            setImages((current) => [...messageImages, ...current].slice(0, MAX_ATTACHMENTS))
          }
        }
      } finally {
        busyRef.current = false
        if (mounted.current) {
          onPendingChange?.(false)
          setBusy(false)
        }
      }
    },
    [allowEmptySubmit, disabled, stopping, onSubmit, retainDraftUntilSuccess, clearOnSuccess, onPendingChange, setText],
  )

  const submitDraft = useCallback(() => {
    if (disabled || stopping || busyRef.current) return
    void send(textRef.current, imagesRef.current, true)
  }, [disabled, stopping, send])

  const stop = async () => {
    if (!onStop || stopping || busyRef.current) return
    busyRef.current = true
    setBusy(true)
    setStoppingLocally(true)
    setSubmissionError(null)
    try {
      await onStop()
    } catch (error) {
      if (mounted.current) setSubmissionError(error instanceof Error ? error.message : String(error))
    } finally {
      busyRef.current = false
      if (mounted.current) {
        setBusy(false)
        setStoppingLocally(false)
      }
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (menuOpen) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault()
        if (candidates.length === 0) return
        const at = candidates.findIndex((c) => c.value === activeValue)
        const delta = event.key === 'ArrowDown' ? 1 : -1
        const next = candidates[(at + delta + candidates.length) % candidates.length]!
        setMenuValue(next.value)
        return
      }
      if (event.key === 'Escape') {
        event.preventDefault()
        closeMenu()
        return
      }
      if ((event.key === 'Enter' || event.key === 'Tab') && !event.shiftKey) {
        const active = candidates.find((c) => c.value === activeValue)
        if (active) {
          event.preventDefault()
          pick(active)
          return
        }
        // No match to accept: the menu is inert — close it and let Enter mean "send".
        closeMenu()
      }
    }
    const shouldSend = isSubmitShortcut({
      key: event.key,
      shiftKey: event.shiftKey,
      metaKey: event.metaKey,
      ctrlKey: event.ctrlKey,
      altKey: event.altKey,
      repeat: event.repeat,
      isComposing: event.nativeEvent.isComposing,
    })
    if (shouldSend) {
      event.preventDefault()
      submitDraft()
    }
  }

  // ---- quick replies (legacy parity: window-global, only while the composer can send) --------

  useEffect(() => {
    if (!quickReplies || disabled) return
    const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
      if (!event.altKey || event.metaKey || event.ctrlKey || event.repeat) return
      // Option composes characters on macOS; leave typing and character insertion alone.
      if (isEditableTarget(event.target)) return
      const reply = QUICK_REPLIES[event.code]
      if (reply === undefined) return
      event.preventDefault()
      // Canned replies bypass the draft entirely — nothing to restore on failure.
      void send(reply, [], false)
    }
    window.addEventListener('keydown', onWindowKeyDown)
    return () => window.removeEventListener('keydown', onWindowKeyDown)
  }, [disabled, quickReplies, send])

  // ---- dictation actions -----------------------------------------------------------------------

  const insertTranscript = (alsoSend: boolean) => {
    if (disabled || stopPendingRef.current || (busyRef.current && (alsoSend || retainDraftUntilSuccess))) return
    const transcript = dictation.finish()
    if (transcript === '') return
    const merged = text.trim() === '' ? transcript : `${text.replace(/\s*$/, '')} ${transcript}`
    if (alsoSend) {
      if (retainDraftUntilSuccess) setText(merged)
      void send(merged, images, true)
      return
    }
    setText(merged)
    pendingCaretRef.current = merged.length
    textareaRef.current?.focus()
  }

  const recording = dictation.recording

  const dictationButton = dictation.supported ? (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={disabled || readOnly}
      aria-label="Start dictation"
      title="Dictation"
      className={cn('h-11 gap-1.5 px-2.5 text-xs font-medium text-muted-foreground md:h-8', mobileCompact && 'hidden md:inline-flex')}
      onClick={() => { if (!editsBlocked()) dictation.start() }}
    >
      <MicIcon aria-hidden="true" className="size-3.5" />
      Dictation
    </Button>
  ) : null

  const stopControl = onStop || stopPending ? (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={stopPending ? 'Stopping…' : 'Stop'}
      aria-busy={stopPending || undefined}
      title={stopPending ? 'Waiting for execution to stop' : 'Stop execution; keep existing work'}
      disabled={busy || stopPending}
      className={cn('h-11 min-w-11 active:opacity-80', primaryStop ? 'w-auto px-3' : 'w-11')}
      onClick={() => void stop()}
    >
      <SquareIcon aria-hidden="true" className="size-3 fill-current" />
      {primaryStop ? (stopPending ? 'Stopping…' : 'Stop') : null}
    </Button>
  ) : null

  return (
    <Popover open={menuOpen} onOpenChange={(open) => (open ? undefined : closeMenu())}>
      <PopoverAnchor asChild>
        <div
          ref={rootRef}
          data-slot="composer"
          data-disabled={disabled || undefined}
          onDrop={onDrop}
          onDragOver={(event) => event.preventDefault()}
          className={cn(
            executionOptions && 'grid gap-4 xl:grid-cols-[minmax(0,1fr)_330px] xl:items-start xl:gap-6',
            disabled && 'opacity-80',
          )}
        >
          <div
            data-slot="composer-editor"
            className="rounded-xl border border-[var(--composer-border)] bg-card shadow-none transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15"
          >
            {images.length > 0 ? (
            <div data-slot="composer-thumbs" className="flex flex-nowrap items-center gap-2 overflow-x-auto px-4 pt-3 md:flex-wrap md:overflow-visible">
              {images.map((attachment, index) => (
                <button
                  key={`${attachment.name}-${index}`}
                  type="button"
                  aria-label={`Remove ${attachment.name}`}
                  title={readOnly ? 'Attachment submitted' : 'Click to remove'}
                  disabled={readOnly}
                  className={cn(
                    'group relative shrink-0 overflow-hidden rounded-md border border-border',
                    attachment.isImage
                      ? 'size-12'
                      : 'flex h-12 min-w-11 max-w-[200px] items-center gap-1.5 bg-muted/40 px-2.5 text-xs text-muted-foreground',
                  )}
                  onClick={() => { if (!editsBlocked()) setImages((current) => current.filter((_, i) => i !== index)) }}
                >
                  {/* An image previews; a file (#950) has nothing to look at, so it gets its own
                      name instead — the one place the user's filename is used at all. */}
                  {attachment.isImage ? (
                    <img src={attachment.preview} alt="" className="size-full object-cover" />
                  ) : (
                    <>
                      <PaperclipIcon aria-hidden="true" className="size-3.5 shrink-0" />
                      <span className="truncate">{attachment.name}</span>
                    </>
                  )}
                  <span className="absolute inset-0 hidden items-center justify-center bg-background/70 group-hover:flex group-focus-visible:flex">
                    <XIcon aria-hidden="true" className="size-4" />
                  </span>
                </button>
              ))}
            </div>
            ) : null}

          {/* A real label keeps password managers from treating nearby page text as a
              one-time-code prompt on client-side navigation (#71); aria-label alone doesn't. */}
          <label htmlFor={textareaId} className="sr-only">{ariaLabel}</label>
          <textarea
            ref={textareaRef}
            id={textareaId}
            autoComplete="off"
            // One intrinsic row on phones; desktop minimum and autosize retain the full input.
            rows={1}
            value={text}
            disabled={disabled}
            readOnly={readOnly}
            aria-busy={readOnly || undefined}
            aria-describedby={retainDraftUntilSuccess ? `${textareaId}-submission` : undefined}
            aria-label={ariaLabel}
            placeholder={disabled ? disabledReason : placeholder}
            // 16px on touch widths — iOS zooms any focused input below 16px (spec mobile rule).
            className={cn(
              'block min-h-11 w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-base leading-normal outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed md:min-h-[54px] md:px-4 md:pt-3 md:text-sm',
              mobileCompact ? 'max-h-11 md:max-h-[220px]' : 'max-h-[220px]',
            )}
            onChange={(event) => {
              if (editsBlocked()) return
              setText(event.target.value)
              syncTrigger()
            }}
            onKeyDown={onKeyDown}
            onSelect={syncTrigger}
            onPaste={onPaste}
          />

          {recording ? (
            <div>
              <DictationBar
                transcript={recording.transcript}
                startedAt={recording.startedAt}
                insertionDisabled={readOnly}
                onCancel={dictation.cancel}
                onInsert={() => insertTranscript(false)}
                onInsertAndSend={() => insertTranscript(true)}
              />
              {stopControl ? <div className="flex justify-end px-2 pb-2">{stopControl}</div> : null}
            </div>
          ) : (
            // The footer may WRAP (the /new pill row on narrow widths), but the trailing
            // controls wrap on phones to keep long model/account labels inside the viewport.
            <div className="flex flex-wrap items-center gap-1 gap-y-1 px-1.5 pt-1 pb-1.5 md:gap-y-1.5 md:px-2 md:pt-1.5 md:pb-2">
              {/* Tools and context wrap together. New-task execution options get their own
                  section; thread composers retain their compact, wrapping footer. */}
              <div data-slot="composer-footer-start" className={cn('flex min-w-0 flex-wrap items-center gap-1', executionOptions && 'w-full')}>
                <AttachButton disabled={disabled || readOnly} onFiles={addFiles} />
                {mobileCollapsible ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="size-11 md:hidden"
                    aria-label={mobileOpen ? 'Collapse composer' : 'Expand composer'}
                    aria-expanded={mobileOpen}
                    aria-controls={footerEnd ? `${textareaId} ${optionsId}` : textareaId}
                    onClick={() => {
                      mobileDisclosures.set(disclosureKey, !mobileOpen)
                      bumpMobileDisclosure()
                    }}
                  >
                    <ChevronDownIcon aria-hidden="true" className={cn('transition-transform motion-reduce:transition-none', !mobileOpen && 'rotate-180')} />
                  </Button>
                ) : null}
                <div className="contents" inert={readOnly || undefined}>{footerStart}</div>
                {executionOptions ? <div className="ml-auto">{dictationButton}</div> : null}
              </div>
              <div data-slot="composer-submit-row" className={cn('ml-auto flex min-w-0 flex-wrap items-center justify-end gap-1 md:flex-nowrap', executionOptions && 'mt-1 w-full border-t border-border pt-2')}>
                {executionOptions ? null : dictationButton}
                {footerEnd ? (
                  <div id={optionsId} data-slot="composer-footer-end" className={cn('min-w-0 flex-wrap items-center gap-1.5 md:flex-nowrap', executionOptions && 'mr-auto', mobileCollapsible && 'max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11', mobileCompact ? 'hidden md:flex' : 'flex')}>
                    <div className="contents" inert={readOnly || undefined}>{footerEnd}</div>
                  </div>
                ) : null}
                <div className="flex min-w-[100px] items-center justify-end gap-1" data-slot="composer-actions">
                  {stopControl}
                  {!primaryStop ? (
                    <Button
                      type="button"
                      size="icon-sm"
                      aria-label={submitLabel}
                      aria-busy={busy && !stopPending || undefined}
                      disabled={disabled || busy || stopPending || (!hasContent && !allowEmptySubmit)}
                      className={cn(
                        executionOptions ? 'h-11 w-auto gap-1.5 px-3 md:h-8' : 'size-11',
                        !hasContent && emptySubmitLabel && 'w-auto px-3',
                        'active:opacity-80',
                      )}
                      onClick={submitDraft}
                    >
                      {!hasContent && emptySubmitLabel ? <PlayIcon aria-hidden="true" /> : null}
                      {executionOptions || (!hasContent && emptySubmitLabel) ? submitLabel : null}
                      {hasContent || !emptySubmitLabel ? <ArrowUpIcon aria-hidden="true" /> : null}
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>
          )}
          {retainDraftUntilSuccess || onStop || stopping ? (
            <div className={cn("overflow-y-auto px-3 pb-2 text-xs leading-5 text-muted-foreground md:px-4", compactFeedback ? "min-h-6" : "h-24 md:h-20")}>
              <div
                id={`${textareaId}-submission`}
                role={submissionError === null ? 'status' : 'alert'}
                aria-atomic="true"
                tabIndex={submissionError === null ? undefined : 0}
                className="break-words"
              >
                {stopPending ? 'Stopping execution. Your draft is kept.' : busy ? pendingLabel : submissionError !== null ? (
                  <>
                    <p className="font-medium text-foreground">{submissionError}</p>
                    <p>{failureHint}</p>
                  </>
                ) : null}
              </div>
            </div>
          ) : null}
          </div>
          {executionOptions ? <div inert={readOnly || undefined}>{executionOptions}</div> : null}
        </div>
      </PopoverAnchor>

      <PopoverContent
        side="top"
        align="start"
        sideOffset={8}
        className="w-80 max-w-[calc(100vw-2rem)] p-0"
        // Focus stays in the textarea — the menu is a suggestion surface, not a focus trap.
        onOpenAutoFocus={(event) => event.preventDefault()}
        // Interacting with the composer itself (typing, clicking the textarea) is not
        // "outside" — only a genuine elsewhere-click dismisses.
        onInteractOutside={(event) => {
          if (rootRef.current?.contains(event.target as Node)) event.preventDefault()
        }}
      >
        <Command shouldFilter={false} value={activeValue ?? ''} onValueChange={setMenuValue}>
          <CommandList
            data-slot="composer-menu"
            data-trigger={trigger?.trigger}
            // Clamped to the popper's reported space so the open keyboard (collisionPadding
            // via the shared PopoverContent) shrinks the menu instead of hiding its tail.
            className="max-h-[min(16rem,var(--radix-popover-content-available-height))] p-1"
          >
            {candidates.length === 0 ? (
              <p className="px-3 py-4 text-center text-xs text-muted-foreground">
                {trigger?.trigger === '@'
                  ? 'No files seen in this session yet — full file search arrives with the Files tab.'
                  : skills.isPending
                    ? 'Loading skills…'
                    : 'No matching skills.'}
              </p>
            ) : (
              candidates.map((candidate) => (
                <CommandItem
                  key={candidate.value}
                  value={candidate.value}
                  data-slot="composer-menu-item"
                  data-emphasized={candidate.emphasized || undefined}
                  onSelect={() => pick(candidate)}
                >
                  <span
                    className={cn(
                      'shrink-0 truncate',
                      candidate.emphasized && 'font-semibold',
                      trigger?.trigger === '@' && 'font-mono text-xs',
                    )}
                  >
                    {candidate.label}
                  </span>
                  {candidate.description ? (
                    <span className="min-w-0 flex-1 truncate text-xs text-soft-foreground">
                      {candidate.description}
                    </span>
                  ) : null}
                </CommandItem>
              ))
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** The paperclip + its hidden multi-file input (legacy `#msg-attach`). */
function AttachButton({
  disabled,
  onFiles,
}: {
  disabled: boolean
  onFiles: (files: readonly File[]) => void
}) {
  const inputRef = useRef<HTMLInputElement>(null)
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Attach files"
        title="Attach an image, PDF, TXT or MD file (or paste a screenshot)"
        disabled={disabled}
        className="size-11 text-muted-foreground"
        onClick={() => inputRef.current?.click()}
      >
        <PaperclipIcon aria-hidden="true" className="size-[15px]" />
      </Button>
      {/* Both spellings of every type: an OS dialog filters on the extension as often as on the
          MIME type, and `accept="image/*,text/plain"` alone greys out a `.md` on Windows (#950). */}
      <input
        ref={inputRef}
        type="file"
        accept="image/*,application/pdf,text/plain,text/markdown,.pdf,.txt,.md,.markdown,.log"
        multiple
        className="hidden"
        aria-hidden="true"
        tabIndex={-1}
        onChange={(event) => {
          onFiles([...(event.target.files ?? [])])
          event.target.value = ''
        }}
      />
    </>
  )
}

/**
 * The recording overlay (paseo `DictationOverlay`): swaps in for the footer bar — pulsing
 * indicator, mm:ss, the growing partial transcript, then ✕ cancel / ✓ insert / ↑ insert-and-send.
 */
function DictationBar({
  transcript,
  startedAt,
  insertionDisabled,
  onCancel,
  onInsert,
  onInsertAndSend,
}: {
  transcript: string
  startedAt: number
  insertionDisabled: boolean
  onCancel: () => void
  onInsert: () => void
  onInsertAndSend: () => void
}) {
  const now = useNow(1000)
  return (
    <div
      data-slot="dictation-overlay"
      role="status"
      aria-label="Dictation in progress"
      className="flex items-center gap-2.5 rounded-b-xl border-t border-border bg-muted/60 px-3 py-2"
    >
      <span
        aria-hidden="true"
        className="size-2 flex-none animate-pulse rounded-full bg-danger motion-reduce:animate-none"
      />
      <span data-slot="dictation-timer" className="text-xs font-medium text-muted-foreground tabular-nums">
        {formatElapsed(startedAt, now)}
      </span>
      <span
        data-slot="dictation-transcript"
        aria-live="polite"
        className="min-w-0 flex-1 truncate text-sm text-foreground"
      >
        {transcript === '' ? (
          <span className="text-muted-foreground">Listening…</span>
        ) : (
          transcript
        )}
      </span>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        aria-label="Cancel dictation"
        className="size-11 text-muted-foreground md:size-8"
        onClick={onCancel}
      >
        <XIcon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        variant="outline"
        size="icon-sm"
        disabled={insertionDisabled}
        aria-label="Insert transcription"
        className="size-11 md:size-8"
        onClick={onInsert}
      >
        <CheckIcon aria-hidden="true" />
      </Button>
      <Button
        type="button"
        size="icon-sm"
        disabled={insertionDisabled}
        aria-label="Insert transcription and send"
        className="size-11 md:size-8"
        onClick={onInsertAndSend}
      >
        <ArrowUpIcon aria-hidden="true" />
      </Button>
    </div>
  )
}
