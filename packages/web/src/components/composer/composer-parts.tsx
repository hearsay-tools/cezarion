import type { ReactNode } from 'react'

import { PlayIcon } from 'lucide-react'

import { ArrowUpIcon, CheckIcon, ChevronDownIcon, MicIcon, PaperclipIcon, SquareIcon, TerminalIcon, XIcon } from '@/components/design-icons'
import { Button } from '@/components/ui/button'
import { Command, CommandItem, CommandList } from '@/components/ui/command'
import { Popover, PopoverAnchor, PopoverContent } from '@/components/ui/popover'

import { useNow } from '@/lib/use-now'
import { formatElapsed } from './dictation'
import {
  composerAriaBusy,
  composerAriaControls,
  composerChevronClass,
  composerDescribedBy,
  composerDictationButtonClass,
  composerDictationInTools,
  composerEditorClass,
  composerEmptyMenuCopy,
  composerFeedbackClass,
  composerFooterEndClass,
  composerFooterStartClass,
  composerInert,
  composerLabelClass,
  composerLabelText,
  composerMenuLabelClass,
  composerPlaceholder,
  composerSendDisabled,
  composerShowPlayIcon,
  composerShowSend,
  composerShowSendIcon,
  composerShowSubmitLabel,
  composerStopClass,
  composerSubmitClass,
  composerSubmitRowClass,
  composerTextareaClass,
  composerThumbClass,
  type ComposerMenuCandidate,
  type ComposerRecordingView,
  type ComposerSubmitMode,
  type ComposerThumb,
} from './composer-view'

export function ComposerDictationButton({
  mode,
  onStart,
}: {
  mode: ComposerSubmitMode
  onStart: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      disabled={mode.disabled || mode.readOnly}
      aria-label="Start dictation"
      title="Dictation"
      className={composerDictationButtonClass(mode.mobileCompact)}
      onClick={onStart}
    >
      <MicIcon aria-hidden="true" className="size-3.5" />
      {composerDictationInTools(mode.executionOptions, mode.sessionControls) ? null : 'Dictation'}
    </Button>
  )
}

// Deliberately NOT gated on `disabled`, which is the SENDING gate — a disconnected or
// disabled provider cannot carry a message, but finishing only settles the run the engine
// already owns and needs no credentials. `stopControl` above has always been independent of
// it for exactly that reason. Gating Finish here would strand a Needs-you task whose
// provider went away with no way out of the list, since the Session tab's kebab no longer
// carries Finish once this button has it.
export function ComposerFinishButton({
  mode,
  onFinish,
}: {
  mode: ComposerSubmitMode
  onFinish: () => void
}) {
  return (
    <Button
      type="button"
      data-slot="composer-finish"
      aria-label={mode.finishLabel}
      aria-busy={mode.finishing || undefined}
      title={mode.finishTitle}
      disabled={mode.busy || mode.stopPending || mode.finishing}
      className="h-11 w-auto gap-[7px] px-5 active:opacity-80"
      onClick={onFinish}
    >
      <CheckIcon aria-hidden="true" />
      {mode.finishLabel}
    </Button>
  )
}

export function ComposerStopButton({
  mode,
  onStop,
}: {
  mode: ComposerSubmitMode
  onStop: () => void
}) {
  return (
    <Button
      type="button"
      variant="outline"
      size="icon-sm"
      aria-label={mode.stopPending ? 'Stopping…' : 'Stop'}
      aria-busy={mode.stopPending || undefined}
      title={mode.stopPending ? 'Waiting for execution to stop' : 'Stop execution; keep existing work'}
      disabled={mode.busy || mode.stopPending}
      className={composerStopClass(mode.labelledStop)}
      onClick={onStop}
    >
      <SquareIcon aria-hidden="true" className="size-3 fill-current" />
      {mode.labelledStop ? (mode.stopPending ? 'Stopping…' : 'Stop') : null}
    </Button>
  )
}

export function ComposerFeedback({
  shown,
  compactFeedback,
  hasCompactFeedback,
  textareaId,
  submissionError,
  stopPending,
  busy,
  pendingLabel,
  failureHint,
  idleFeedback,
}: {
  shown: boolean
  compactFeedback: boolean
  hasCompactFeedback: boolean
  textareaId: string
  submissionError: string | null
  stopPending: boolean
  busy: boolean
  pendingLabel: string
  failureHint: string | undefined
  idleFeedback: ReactNode
}) {
  if (!shown) return null
  return (
    <div className={composerFeedbackClass(compactFeedback, hasCompactFeedback)}>
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
        ) : idleFeedback ?? null}
      </div>
    </div>
  )
}

export function ComposerSubmitRow({
  mode,
  emptySubmitLabel,
  optionsId,
  dictationButton,
  footerEnd,
  stopControl,
  secondaryAction,
  finishControl,
  onSubmit,
}: {
  mode: ComposerSubmitMode
  emptySubmitLabel: string | undefined
  optionsId: string
  dictationButton: ReactNode
  footerEnd: ReactNode
  stopControl: ReactNode
  secondaryAction: ReactNode
  finishControl: ReactNode
  onSubmit: () => void
}) {
  return (
    <div data-slot="composer-submit-row" className={composerSubmitRowClass(mode.executionOptions)}>
      {composerDictationInTools(mode.executionOptions, mode.sessionControls) ? null : dictationButton}
      {footerEnd ? (
        <div id={optionsId} data-slot="composer-footer-end" className={composerFooterEndClass(mode)}>
          <div className="contents" inert={composerInert(mode.readOnly)}>{footerEnd}</div>
        </div>
      ) : null}
      <div className="flex min-w-[100px] items-center justify-end gap-1" data-slot="composer-actions">
        {/* One outline slot: Stop while the host offers it, the host's own control
            otherwise. Never both — the host hands over one or the other. */}
        {stopControl ?? secondaryAction}
        {finishControl}
        {composerShowSend(mode.primaryStop, mode.primaryFinish) ? (
          <Button
            type="button"
            size="icon-sm"
            aria-label={mode.submitLabel}
            aria-busy={composerAriaBusy(mode.busy, mode.stopPending)}
            disabled={composerSendDisabled(mode)}
            className={composerSubmitClass(mode, emptySubmitLabel)}
            onClick={onSubmit}
          >
            {composerShowPlayIcon(mode, emptySubmitLabel) ? <PlayIcon aria-hidden="true" /> : null}
            {composerShowSubmitLabel(mode, emptySubmitLabel) ? mode.submitLabel : null}
            {composerShowSendIcon(mode, emptySubmitLabel) ? <ArrowUpIcon aria-hidden="true" /> : null}
          </Button>
        ) : null}
      </div>
    </div>
  )
}

export function ComposerThumbs({
  images,
  readOnly,
  onRemove,
}: {
  images: readonly ComposerThumb[]
  readOnly: boolean
  onRemove: (index: number) => void
}) {
  if (images.length === 0) return null
  return (
    <div data-slot="composer-thumbs" className="flex flex-nowrap items-center gap-2 overflow-x-auto px-4 pbs-3 md:flex-wrap md:overflow-visible">
      {images.map((attachment, index) => (
        <button
          key={`${attachment.name}-${index}`}
          type="button"
          aria-label={`Remove ${attachment.name}`}
          title={readOnly ? 'Attachment submitted' : 'Click to remove'}
          disabled={readOnly}
          className={composerThumbClass(attachment.isImage)}
          onClick={() => onRemove(index)}
        >
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
  )
}

export function ComposerMenuList({
  menuListRef,
  trigger,
  activeValue,
  skillsPending,
  candidates,
  onValueChange,
  onPick,
}: {
  menuListRef: React.Ref<HTMLDivElement>
  trigger: string | undefined
  activeValue: string | undefined
  skillsPending: boolean
  candidates: readonly ComposerMenuCandidate[]
  onValueChange: (value: string) => void
  onPick: (candidate: ComposerMenuCandidate) => void
}) {
  return (
    <Command shouldFilter={false} value={activeValue ?? ''} onValueChange={onValueChange}>
      <CommandList
        ref={menuListRef}
        data-slot="composer-menu"
        data-trigger={trigger}
        // Clamped to the popper's reported space so the open keyboard (collisionPadding
        // via the shared PopoverContent) shrinks the menu instead of hiding its tail.
        className="max-h-[min(16rem,var(--radix-popover-content-available-height))] p-1"
      >
        {candidates.length === 0 ? (
          <p className="px-3 py-4 text-center text-xs text-muted-foreground">
            {composerEmptyMenuCopy(trigger, skillsPending)}
          </p>
        ) : (
          candidates.map((candidate) => (
            <CommandItem
              key={candidate.value}
              value={candidate.value}
              data-slot="composer-menu-item"
              data-emphasized={candidate.emphasized || undefined}
              onSelect={() => onPick(candidate)}
            >
              <span className={composerMenuLabelClass(candidate.emphasized, trigger === '@')}>
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
  )
}

/**
 * The recording overlay (paseo `DictationOverlay`): swaps in for the footer bar — pulsing
 * indicator, mm:ss, the growing partial transcript, then ✕ cancel / ✓ insert / ↑ insert-and-send.
 */
export function ComposerDictationBar({
  recording,
  insertionDisabled,
  onCancel,
  onInsert,
  onInsertAndSend,
  now,
}: {
  recording: ComposerRecordingView
  insertionDisabled: boolean
  onCancel: () => void
  onInsert: () => void
  onInsertAndSend: () => void
  now: number
}) {
  return (
    <div
      data-slot="dictation-overlay"
      role="status"
      aria-label="Dictation in progress"
      className="flex items-center gap-2.5 rounded-b-xl border-bs border-border bg-muted/60 px-3 py-2"
    >
      <span
        aria-hidden="true"
        className="size-2 flex-none animate-pulse rounded-full bg-danger motion-reduce:animate-none"
      />
      <span data-slot="dictation-timer" className="text-xs font-medium text-muted-foreground tabular-nums">
        {formatElapsed(recording.startedAt, now)}
      </span>
      <span
        data-slot="dictation-transcript"
        aria-live="polite"
        className="min-w-0 flex-1 truncate text-sm text-foreground"
      >
        {recording.transcript === '' ? (
          <span className="text-muted-foreground">Listening…</span>
        ) : (
          recording.transcript
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

export function ComposerExpandButton({
  mobileOpen,
  controls,
  onToggle,
}: {
  mobileOpen: boolean
  controls: string
  onToggle: () => void
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-sm"
      className="size-11 md:hidden"
      aria-label={mobileOpen ? 'Collapse composer' : 'Expand composer'}
      aria-expanded={mobileOpen}
      aria-controls={controls}
      onClick={onToggle}
    >
      <ChevronDownIcon aria-hidden="true" className={composerChevronClass(mobileOpen)} />
    </Button>
  )
}

export function ComposerSkillHint() {
  return (
    <p data-slot="composer-skill-hint" className="flex items-center gap-2 px-5 pbs-3 pbe-2 text-xs text-muted-foreground">
      <TerminalIcon aria-hidden="true" className="size-[15px] shrink-0" />
      Type / for a skill or workflow
    </p>
  )
}

/** The paperclip + its hidden multi-file input (legacy `#msg-attach`). */
export function ComposerAttachButton({
  disabled,
  onFiles,
  inputRef,
}: {
  disabled: boolean
  onFiles: (files: readonly File[]) => void
  inputRef: React.RefObject<HTMLInputElement | null>
}) {
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

export function ComposerEditor({
  mode,
  executionOptions,
  sessionControls,
  images,
  onRemoveImage,
  textareaId,
  textareaRef,
  text,
  disabled,
  retainDraftUntilSuccess,
  ariaLabel,
  disabledReason,
  placeholder,
  onTextChange,
  onKeyDown,
  onSelect,
  onPaste,
  recording,
  onCancelDictation,
  onInsertTranscript,
  onInsertAndSend,
  stopControl,
  mobileCollapsible,
  mobileOpen,
  optionsId,
  footerEnd,
  onToggleMobile,
  footerStart,
  attachInputRef,
  addFiles,
  dictationButton,
  submissionControls,
  feedback,
  agentOptions,
}: {
  mode: ComposerSubmitMode
  executionOptions: ReactNode
  sessionControls: ReactNode
  images: readonly ComposerThumb[]
  onRemoveImage: (index: number) => void
  textareaId: string
  textareaRef: React.Ref<HTMLTextAreaElement>
  text: string
  disabled: boolean
  retainDraftUntilSuccess: boolean
  ariaLabel: string
  disabledReason: string | undefined
  placeholder: string
  onTextChange: (value: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onSelect: () => void
  onPaste: (event: React.ClipboardEvent<HTMLTextAreaElement>) => void
  recording: ComposerRecordingView | null
  onCancelDictation: () => void
  onInsertTranscript: () => void
  onInsertAndSend: () => void
  stopControl: ReactNode
  mobileCollapsible: boolean
  mobileOpen: boolean
  optionsId: string
  footerEnd: ReactNode
  onToggleMobile: () => void
  footerStart: ReactNode
  attachInputRef: React.RefObject<HTMLInputElement | null>
  addFiles: (files: readonly File[]) => void
  dictationButton: ReactNode
  submissionControls: ReactNode
  feedback: ReactNode
  agentOptions: ReactNode
}) {
  return (
    <>
      <div data-slot="composer-editor" className={composerEditorClass(executionOptions)}>
        <ComposerThumbs images={images} readOnly={mode.readOnly} onRemove={onRemoveImage} />
        <label htmlFor={textareaId} className={composerLabelClass(executionOptions)}>{composerLabelText(executionOptions, ariaLabel)}</label>
        <textarea
          ref={textareaRef}
          id={textareaId}
          autoComplete="off"
          rows={1}
          value={text}
          disabled={disabled}
          readOnly={mode.readOnly}
          aria-busy={mode.readOnly || undefined}
          aria-describedby={composerDescribedBy(retainDraftUntilSuccess, textareaId)}
          aria-label={ariaLabel}
          placeholder={composerPlaceholder(disabled, disabledReason, placeholder)}
          className={composerTextareaClass(mode.mobileCompact, executionOptions)}
          onChange={(event) => onTextChange(event.target.value)}
          onKeyDown={onKeyDown}
          onSelect={onSelect}
          onPaste={onPaste}
        />
        {executionOptions ? <ComposerSkillHint /> : null}
        {sessionControls && recording ? <div data-slot="session-controls" inert={composerInert(mode.readOnly)}>{sessionControls}</div> : null}
        {recording ? (
          <ComposerRecordingFooter recording={recording} mode={mode} onCancel={onCancelDictation} onInsert={onInsertTranscript} onInsertAndSend={onInsertAndSend} stopControl={stopControl} />
        ) : (
          <ComposerToolbar
            mode={mode}
            sessionControls={sessionControls}
            executionOptions={executionOptions}
            mobileCollapsible={mobileCollapsible}
            mobileOpen={mobileOpen}
            optionsId={optionsId}
            textareaId={textareaId}
            footerEnd={footerEnd}
            onToggleMobile={onToggleMobile}
            footerStart={footerStart}
            attachInputRef={attachInputRef}
            addFiles={addFiles}
            disabled={disabled}
            dictationButton={dictationButton}
            submissionControls={submissionControls}
          />
        )}
        {executionOptions ? null : feedback}
      </div>
      {executionOptions ? (
        <ComposerNewTaskPanels mode={mode} agentOptions={agentOptions} executionOptions={executionOptions} submissionControls={submissionControls} feedback={feedback} />
      ) : null}
    </>
  )
}

function ComposerRecordingFooter({
  recording, mode, onCancel, onInsert, onInsertAndSend, stopControl,
}: {
  recording: ComposerRecordingView
  mode: ComposerSubmitMode
  onCancel: () => void
  onInsert: () => void
  onInsertAndSend: () => void
  stopControl: ReactNode
}) {
  // The clock starts when recording starts: this footer mounts only then.
  const now = useNow(1000)
  return (
    <div>
      <ComposerDictationBar
        recording={recording}
        insertionDisabled={mode.readOnly}
        onCancel={onCancel}
        onInsert={onInsert}
        onInsertAndSend={onInsertAndSend}
        now={now}
      />
      {stopControl ? <div className="flex justify-end px-2 pbe-2">{stopControl}</div> : null}
    </div>
  )
}

// The footer may WRAP (the /new pill row on narrow widths), but the trailing
// controls wrap on phones to keep long model/account labels inside the viewport.
function ComposerToolbar(input: {
  mode: ComposerSubmitMode
  sessionControls: ReactNode
  executionOptions: ReactNode
  mobileCollapsible: boolean
  mobileOpen: boolean
  optionsId: string
  textareaId: string
  footerEnd: ReactNode
  onToggleMobile: () => void
  footerStart: ReactNode
  attachInputRef: React.RefObject<HTMLInputElement | null>
  addFiles: (files: readonly File[]) => void
  disabled: boolean
  dictationButton: ReactNode
  submissionControls: ReactNode
}) {
  return (
    <div data-slot="composer-toolbar" className="flex flex-wrap items-center gap-1 gap-y-1 px-1.5 pbs-1 pbe-1.5 md:gap-y-1.5 md:px-2 md:pbs-1.5 md:pbe-2">
      {input.sessionControls ? <div data-slot="session-controls" inert={composerInert(input.mode.readOnly)}>{input.sessionControls}</div> : null}
      {/* Tools and context wrap together. New-task execution options get their own
          section; thread composers retain their compact, wrapping footer. */}
      <div data-slot="composer-footer-start" className={composerFooterStartClass(input.executionOptions)}>
        <ComposerAttachButton disabled={input.disabled || input.mode.readOnly} onFiles={input.addFiles} inputRef={input.attachInputRef} />
        {input.mobileCollapsible ? (
          <ComposerExpandButton
            mobileOpen={input.mobileOpen}
            controls={composerAriaControls(Boolean(input.footerEnd), input.textareaId, input.optionsId)}
            onToggle={input.onToggleMobile}
          />
        ) : null}
        <div className="contents" inert={composerInert(input.mode.readOnly)}>{input.footerStart}</div>
        {composerDictationInTools(input.executionOptions, input.sessionControls) ? <div>{input.dictationButton}</div> : null}
      </div>
      {input.executionOptions ? null : input.submissionControls}
    </div>
  )
}

function ComposerNewTaskPanels({
  mode, agentOptions, executionOptions, submissionControls, feedback,
}: {
  mode: ComposerSubmitMode
  agentOptions: ReactNode
  executionOptions: ReactNode
  submissionControls: ReactNode
  feedback: ReactNode
}) {
  return (
    <>
      <div data-slot="composer-agent-options" inert={composerInert(mode.readOnly)}>{agentOptions}</div>
      <div data-slot="composer-execution-panel" inert={composerInert(mode.readOnly)}>{executionOptions}</div>
      {submissionControls}
      <div data-slot="composer-feedback">{feedback}</div>
    </>
  )
}

/** The popover shell. Children are the editor and the menu, in that order. */
export function ComposerFrame({
  open,
  onClose,
  rootRef,
  disabled,
  voiceProposal,
  onDrop,
  className,
  children,
  menu,
}: {
  open: boolean
  onClose: () => void
  rootRef: React.RefObject<HTMLDivElement | null>
  disabled: boolean
  voiceProposal: boolean
  onDrop: (event: React.DragEvent) => void
  className: string
  children: ReactNode
  menu: ReactNode
}) {
  return (
    <Popover open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      <PopoverAnchor asChild>
        <div
          ref={rootRef}
          data-slot="composer"
          data-disabled={disabled || undefined}
          data-voice-proposal={voiceProposal || undefined}
          onDrop={onDrop}
          onDragOver={(event) => event.preventDefault()}
          className={className}
        >
          {children}
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
        {menu}
      </PopoverContent>
    </Popover>
  )
}
