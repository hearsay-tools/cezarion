import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

/** One row of the `/` or `@` menu. The path suffix keeps skill values unique when a project skill shadows a global one. */
export interface ComposerMenuCandidate {
  value: string
  insert: string
  label: string
  description?: string | undefined
  emphasized: boolean
}

/** One attachment chip the composer is holding before send. */
export interface ComposerThumb {
  name: string
  isImage: boolean
  preview?: string | undefined
}

/** The recording overlay the composer swaps in for the footer. */
export interface ComposerRecordingView {
  transcript: string
  startedAt: number
}

/** Flags the send row reads. Computed once in `Composer` so the row does not re-derive them. */
export interface ComposerSubmitMode {
  hasContent: boolean
  primaryStop: boolean
  primaryFinish: boolean
  labelledStop: boolean
  submitLabel: string
  busy: boolean
  stopPending: boolean
  finishing: boolean
  finishLabel: string
  finishTitle: string
  disabled: boolean
  allowEmptySubmit: boolean
  readOnly: boolean
  mobileCompact: boolean
  mobileCollapsible: boolean
  executionOptions: boolean
  sessionControls: boolean
  showStop: boolean
}

export function composerHasContent(text: string, imageCount: number): boolean {
  return text.trim() !== '' || imageCount > 0
}

export function composerPrimaryStop(
  hasContent: boolean,
  onStop: unknown,
  stopOnEmpty: boolean,
  stopPending: boolean,
): boolean {
  return !hasContent && ((onStop !== undefined && stopOnEmpty) || stopPending)
}

// Never displaces a live primary (#281): Stop keeps the slot wherever it already had it, and a
// host only passes `onFinish` for a status whose empty-draft primary would otherwise be a
// disabled Send. The `!hasContent` guard is the whole affordance — a typed draft means Send.
export function composerPrimaryFinish(hasContent: boolean, primaryStop: boolean, onFinish: unknown): boolean {
  return !hasContent && !primaryStop && onFinish !== undefined
}

// Stop wears its word whenever the control beside it does (#281). Next to the bare arrow Send it
// reads fine as an icon — two icons, one row — but next to a labelled Finish or Continue it read
// as an unexplained square beside a verb. The condition follows the PRIMARY's own label rule
// rather than naming Finish, so a future promoted primary cannot reintroduce the mismatch.
export function composerLabelledStop(
  primaryStop: boolean,
  primaryFinish: boolean,
  hasContent: boolean,
  emptySubmitLabel: string | undefined,
): boolean {
  return primaryStop || primaryFinish || (!hasContent && emptySubmitLabel !== undefined)
}

export function composerSubmitLabel(
  hasContent: boolean,
  emptySubmitLabel: string | undefined,
  sendAriaLabel: string,
): string {
  return !hasContent && emptySubmitLabel ? emptySubmitLabel : sendAriaLabel
}

export function composerReadOnly(stopPending: boolean, retainDraftUntilSuccess: boolean, busy: boolean): boolean {
  return stopPending || (retainDraftUntilSuccess && busy)
}

/** Same rule as `composerReadOnly`, read from refs at click time rather than from the last render. */
export function composerEditsBlocked(stopPending: boolean, retainDraftUntilSuccess: boolean, busy: boolean): boolean {
  return stopPending || (retainDraftUntilSuccess && busy)
}

export function composerSendRefused(
  disabled: boolean,
  stopping: boolean,
  busy: boolean,
  allowEmptySubmit: boolean,
  messageText: string,
  imageCount: number,
): boolean {
  return disabled || stopping || busy || (messageText.trim() === '' && imageCount === 0 && !allowEmptySubmit)
}

export function composerMobileCompact(mobileCollapsible: boolean, mobileOpen: boolean): boolean {
  return mobileCollapsible && !mobileOpen
}

export function composerDisclosureKey(mobileDisclosureKey: string | undefined): string {
  return mobileDisclosureKey ?? 'default'
}

export function composerMobileOpen(disclosures: Map<string, boolean>, key: string): boolean {
  return disclosures.get(key) ?? false
}

export function composerErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function composerRestoreText(current: string, messageText: string): string {
  return current === '' ? messageText : `${messageText}\n${current}`
}

export function composerAttachmentReadError(name: string): string {
  return `${name || 'Attachment'} could not be read — try attaching it again`
}

// `kind: 'file'` rather than an `image/` type test (#950): the clipboard carries a pasted
// `.md` as a file item too, and `screenFiles` is what decides whether Squawk takes it. The
// text half of the clipboard is start alone so an ordinary ⌘V still types.
export function composerPasteFiles(items: DataTransferItemList | undefined): File[] {
  return [...(items ?? [])]
    .filter((item) => item.kind === 'file')
    .map((item) => item.getAsFile())
    .filter((file): file is File => file !== null)
}

export function composerDropFiles(files: FileList | undefined): File[] {
  return [...(files ?? [])]
}

export function composerMergeTranscript(text: string, transcript: string): string {
  return text.trim() === '' ? transcript : `${text.replace(/\s*$/, '')} ${transcript}`
}

export function composerDictationBlocked(
  disabled: boolean,
  stopPending: boolean,
  busy: boolean,
  alsoSend: boolean,
  retainDraftUntilSuccess: boolean,
): boolean {
  return disabled || stopPending || (busy && (alsoSend || retainDraftUntilSuccess))
}

/** 'empty' when the draft is already blank, 'blocked' while a send owns it or the user edited it, else 'clear'. */
export function composerVoiceClear(current: string, busy: boolean, voiceText: string): 'empty' | 'blocked' | 'clear' {
  if (current === '') return 'empty'
  if (busy || current !== voiceText) return 'blocked'
  return 'clear'
}

export function composerStopRefused(onStop: unknown, stopping: boolean, busy: boolean): boolean {
  return !onStop || stopping || busy
}

export function composerNextMenuIndex(at: number, delta: number, length: number): number {
  return (at + delta + length) % length
}

export function composerCaret(selectionStart: number | null, textLength: number): number {
  return selectionStart ?? textLength
}

export function composerFieldSizing(): boolean {
  return typeof CSS !== 'undefined' && CSS.supports('field-sizing', 'content')
}

export function composerWidthChanged(clientWidth: number, width: number): boolean {
  return clientWidth !== width
}

export function composerInert(readOnly: boolean): true | undefined {
  return readOnly || undefined
}

export function composerAriaBusy(busy: boolean, stopPending: boolean): true | undefined {
  return (busy && !stopPending) || undefined
}

export function composerPlaceholder(disabled: boolean, disabledReason: string | undefined, placeholder: string): string {
  return disabled ? (disabledReason ?? '') : placeholder
}

export function composerDescribedBy(retainDraftUntilSuccess: boolean, textareaId: string): string | undefined {
  return retainDraftUntilSuccess ? `${textareaId}-submission` : undefined
}

export function composerAriaControls(footerEnd: boolean, textareaId: string, optionsId: string): string {
  return footerEnd ? `${textareaId} ${optionsId}` : textareaId
}

export function composerHasCompactFeedback(
  stopPending: boolean,
  busy: boolean,
  submissionError: string | null,
  idleFeedback: unknown,
): boolean {
  return stopPending || busy || submissionError !== null || idleFeedback != null
}

export function composerFeedbackShown(retainDraftUntilSuccess: boolean, onStop: unknown, stopping: boolean): boolean {
  return retainDraftUntilSuccess || Boolean(onStop) || stopping
}

export function composerShowStop(onStop: unknown, stopPending: boolean): boolean {
  return Boolean(onStop) || stopPending
}

export function composerShowSend(primaryStop: boolean, primaryFinish: boolean): boolean {
  return !primaryStop && !primaryFinish
}

export function composerDictationInTools(executionOptions: ReactNode, sessionControls: ReactNode): boolean {
  return Boolean(executionOptions) || Boolean(sessionControls)
}

export function composerEmptyMenuCopy(trigger: string | undefined, skillsPending: boolean): string {
  if (trigger === '@') return 'No files seen in this session yet — full file search arrives with the Files tab.'
  return skillsPending ? 'Loading skills…' : 'No matching skills.'
}

export function composerMenuLabelClass(emphasized: boolean, mention: boolean): string {
  return cn('shrink-0 truncate', emphasized && 'font-semibold', mention && 'font-mono text-xs')
}

export function composerRootClass(executionOptions: ReactNode, sessionControls: ReactNode, disabled: boolean): string {
  return cn(executionOptions && 'new-task-composer', sessionControls && 'session-composer', disabled && 'opacity-80')
}

export function composerEditorClass(executionOptions: ReactNode): string {
  return cn(
    'rounded-xl border border-[var(--composer-border)] bg-card shadow-none transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/15',
    executionOptions && 'new-task-editor',
  )
}

// An image previews; a file (#950) has nothing to look at, so it gets its own
// name instead — the one place the user's filename is used at all.
export function composerThumbClass(isImage: boolean): string {
  return cn(
    'group relative shrink-0 overflow-hidden rounded-md border border-border',
    isImage ? 'size-12' : 'flex h-12 min-w-11 max-w-[200px] items-center gap-1.5 bg-muted/40 px-2.5 text-xs text-muted-foreground',
  )
}

// One intrinsic row on phones; desktop minimum and autosize retain the full input.
// 16px on touch widths — iOS zooms any focused input below 16px (spec mobile rule).
export function composerTextareaClass(mobileCompact: boolean, executionOptions: ReactNode): string {
  return cn(
    'block field-sizing-content min-h-11 w-full overflow-y-auto resize-none bg-transparent px-3 pbs-2.5 pbe-1 text-base leading-normal outline-hidden placeholder:text-muted-foreground disabled:cursor-not-allowed md:min-h-[54px] md:px-4 md:pbs-3 md:text-sm',
    mobileCompact ? 'max-h-11 md:max-h-[220px]' : 'max-h-[220px]',
    executionOptions && 'md:text-base',
  )
}

export function composerLabelText(executionOptions: ReactNode, ariaLabel: string): string {
  return executionOptions ? 'Task description' : ariaLabel
}

// A real label keeps password managers from treating nearby page text as a
// one-time-code prompt on client-side navigation (#71); aria-label alone doesn't.
export function composerLabelClass(executionOptions: ReactNode): string {
  return executionOptions ? 'hidden px-5 pbs-5 text-xs text-muted-foreground md:block' : 'sr-only'
}

export function composerSubmitRowClass(executionOptions: ReactNode): string {
  return cn('ms-auto flex min-w-0 flex-wrap items-center justify-end gap-1 md:flex-nowrap', executionOptions && 'new-task-submission')
}

export function composerFooterEndClass(mode: ComposerSubmitMode): string {
  return cn(
    'min-w-0 flex-wrap items-center gap-1.5 md:flex-nowrap',
    mode.executionOptions && 'me-auto',
    mode.mobileCollapsible && 'max-md:[&_button]:min-h-11 max-md:[&_button]:min-w-11',
    mode.mobileCompact ? 'hidden md:flex' : 'flex',
  )
}

export function composerSubmitClass(mode: ComposerSubmitMode, emptySubmitLabel: string | undefined): string {
  return cn(
    mode.executionOptions ? 'h-12 w-full gap-2 px-6' : mode.sessionControls ? 'h-11 w-auto gap-2 px-5' : 'size-11',
    !mode.hasContent && emptySubmitLabel && 'w-auto px-3',
    'active:opacity-80',
  )
}

export function composerFeedbackClass(compactFeedback: boolean, hasCompactFeedback: boolean): string {
  return cn(
    'overflow-y-auto text-xs leading-5 text-muted-foreground',
    compactFeedback && !hasCompactFeedback ? 'h-0' : 'px-3 pbe-2 md:px-4',
    compactFeedback ? hasCompactFeedback && 'min-h-6' : 'h-24 md:h-20',
  )
}

export function composerStopClass(labelledStop: boolean): string {
  return cn('h-11 min-w-11 active:opacity-80', labelledStop ? 'w-auto px-3' : 'w-11')
}

export function composerFooterStartClass(executionOptions: ReactNode): string {
  return cn('flex min-w-0 flex-wrap items-center gap-1', executionOptions && 'w-full')
}

export function composerChevronClass(mobileOpen: boolean): string {
  return cn('transition-transform motion-reduce:transition-none', !mobileOpen && 'rotate-180')
}

export function composerDictationButtonClass(mobileCompact: boolean): string {
  return cn('h-11 gap-1.5 px-2.5 text-xs font-medium text-muted-foreground md:h-8', mobileCompact && 'hidden md:inline-flex')
}

export function composerSendDisabled(mode: ComposerSubmitMode): boolean {
  return mode.disabled || mode.busy || mode.stopPending || (!mode.hasContent && !mode.allowEmptySubmit)
}

export function composerShowPlayIcon(mode: ComposerSubmitMode, emptySubmitLabel: string | undefined): boolean {
  return !mode.sessionControls && !mode.hasContent && Boolean(emptySubmitLabel)
}

export function composerShowSubmitLabel(mode: ComposerSubmitMode, emptySubmitLabel: string | undefined): boolean {
  return mode.executionOptions || mode.sessionControls || (!mode.hasContent && Boolean(emptySubmitLabel))
}

export function composerShowSendIcon(mode: ComposerSubmitMode, emptySubmitLabel: string | undefined): boolean {
  return mode.sessionControls || mode.hasContent || !emptySubmitLabel
}

export function composerFinishLabel(finishing: boolean): string {
  return finishing ? 'Finishing…' : 'Finish'
}

