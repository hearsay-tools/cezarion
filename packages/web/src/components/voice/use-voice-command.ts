import * as React from 'react'

import { reportVoiceOutcome, voiceDecide } from '@/api/client'
import { useRuns } from '@/api/queries'
import { useListView } from '@/components/list-view'
import { useActiveProjectId, useNavigate, useProjectMatch, useProjectPathname } from '@/lib/project-router'
import { groupTitle, runTitle, type SidebarView } from '@/lib/task-groups'
import { parseNumberedPick } from '@/lib/voice/numbered-pick'
import { usePendingAsk, useVoiceProposal, voiceStore, type VoiceProposal } from '@/lib/voice/proposal-store'
import { resolveOpenTarget, type OpenTarget } from '@/lib/voice/resolve-open'
import { voiceViewOf } from '@/lib/voice/view'
import { VOICE_TEXT_MAX, type VoiceView } from '@open-mercato/cezar-api-client/contract/voice'
import type { RunSummary, VoiceDecideRequest, VoiceDecision, VoiceOutcome } from '@open-mercato/cezar-api-client'
import {
  answerLines,
  answerRowText,
  confirmHeading,
  noTasksNotice,
  openRowText,
  pastEndNotice,
  tellRowText,
} from './voice-copy'

/**
 * Voice mode in the ⌘K palette (spec 2026-10-21-voice-mode, § User experience): a sentence in the
 * input gets a Will do row, Return commits it, and every action other than opening a task becomes
 * a proposal that a SECOND input confirms. The server decides what a sentence means; this hook
 * owns the timing (debounce, abort, the bounded wait on Return), the execution and the outcome
 * reports.
 *
 * The Return that commits a sentence acts only on the decision for exactly that sentence, so it
 * can create a proposal but never confirm one (§ Input 5). Return confirms only in an empty input
 * while a proposal is shown.
 *
 * Return follows cmdk's selection (hearsay-tools/cezarion#1461): a sentence shows its Will do row
 * at once, first and so selected, and Return commits only while that row is still selected. A row
 * the user moved to keeps Return, and a decision that arrives later never takes it back.
 */

/** The Will do row's cmdk value: the palette compares its selection against it. */
export const VOICE_ROW_VALUE = 'voice-will-do'

/** `pending`: the sentence's decision has not arrived yet. */
export type VoiceRow = { kind: 'will-do' | 'notice'; text: string; choices?: string[]; pending?: true }
/** A shown proposal, for the palette's confirmation panel: who it goes to and what it says. */
export type VoiceConfirmation = { heading: string; lines: string[] }
export type VoiceMode = 'idle' | 'preview' | 'choosing' | 'proposal'

/** How long the text must stay unchanged before the palette asks the engine. */
export const VOICE_PREVIEW_DEBOUNCE_MS = 300
/** How long Return waits for the decision of its sentence. */
export const VOICE_DECISION_BOUND_MS = 3000

const NOTICES = {
  timedOut: 'Voice decision timed out.',
  unavailable: 'Voice decision unavailable.',
  noCard: 'This question is not open here.',
  draftNotEmpty: 'The message box already has text.',
  busy: 'The task is busy. Try again in a moment.',
  noOpenTask: 'Open a task first.',
  noOpenQuestion: 'This task has no open question.',
  unclear: 'Not sure what to do. Try again.',
  questionClosed: 'The question was answered or closed elsewhere.',
  taskClosed: 'The task is no longer open.',
  scrollToQuestion: 'Scroll to the question, then confirm.',
  ambiguous: 'Which question? Name it, for example “to question two”.',
  staleContext: 'The screen changed. Try again.',
  unsupported: 'Voice cannot do that yet.',
} as const

type NoneReason = Extract<VoiceDecision, { action: 'none' }>['reason']

/** What the palette says for a decision that does nothing; `not-a-command` says nothing. */
const NONE_NOTICES: Record<Exclude<NoneReason, 'not-a-command'>, string> = {
  'no-open-task': NOTICES.noOpenTask,
  'no-open-question': NOTICES.noOpenQuestion,
  unclear: NOTICES.unclear,
  ambiguous: NOTICES.ambiguous,
  'stale-context': NOTICES.staleContext,
  unsupported: NOTICES.unsupported,
}

/** Two or more words after trimming: a single word stays an ordinary palette search. */
export function looksLikeSentence(text: string): boolean {
  return text.trim().split(/\s+/).length >= 2
}

const voiceable = (text: string) => looksLikeSentence(text) && text.length <= VOICE_TEXT_MAX

/** "no" and "cancel" alone (ruling R17): while a proposal is shown they drop it in the browser,
 *  like a numbered pick, with no engine call. Otherwise they stay ordinary searches. */
const isCancelWord = (text: string) => /^(?:no|cancel)$/.test(text.toLowerCase().replace(/[.!?]+$/, '').trim())

/** What a decision depends on: the same sentence, project, page, open task, shown question and
 *  shown proposal ⇒ the same answer. A change to any of them makes an older decision stale. */
interface DecisionKey {
  text: string
  /** The palette sits outside the project's keyed outlet, so it outlives a project switch. */
  projectId: string | null
  view: VoiceView
  openRunId: string | null
  /** The question the open thread shows; undefined while the thread has not synced it. */
  askRequestId: string | null | undefined
  proposalId: string | null
}
const sameKey = (a: DecisionKey, b: DecisionKey) =>
  a.text === b.text &&
  a.projectId === b.projectId &&
  a.view === b.view &&
  a.openRunId === b.openRunId &&
  a.askRequestId === b.askRequestId &&
  a.proposalId === b.proposalId

type Settled = { kind: 'decision'; decision: VoiceDecision } | { kind: 'failed' } | { kind: 'aborted' }

interface DecisionRequest {
  key: DecisionKey
  controller: AbortController
  result: Promise<Settled>
  failed: boolean
}

type Openable = Extract<OpenTarget, { kind: 'run' | 'group' }>
interface Choice {
  target: Openable
  text: string
}
interface Choosing {
  decisionId: string
  choices: Choice[]
  /** The context the choices were resolved for; numbers mean nothing in another one. */
  projectId: string | null
  view: VoiceView
  openRunId: string | null
  sidebarView: SidebarView
}

type OpenDecision = Extract<VoiceDecision, { action: 'open' }>

/** What an `open` decision points at, and the numbered candidates when the engine was not sure. */
function planOpen(
  decision: OpenDecision,
  context: { runs: readonly RunSummary[]; sidebarView: SidebarView; openRunId: string | null },
): { primary: OpenTarget; choices: Choice[] } {
  const titleOf = (target: Openable): string => {
    if (target.kind === 'run') {
      const run = context.runs.find((candidate) => candidate.id === target.runId)
      return run ? runTitle(run) : target.runId
    }
    const member = context.runs.find((candidate) => candidate.groupId === target.groupId)
    return member ? groupTitle(member) : target.groupId
  }
  const resolve = (status: OpenDecision['status'], position: OpenDecision['position']) =>
    resolveOpenTarget({ ...context, status, position })
  const primary = resolve(decision.status, decision.position)
  const choices: Choice[] = []
  const seen = new Set<string>()
  for (const candidate of [{ status: decision.status, position: decision.position }, ...(decision.alternatives ?? [])]) {
    const target = resolve(candidate.status, candidate.position)
    if (target.kind !== 'run' && target.kind !== 'group') continue
    const id = target.kind === 'run' ? `run:${target.runId}` : `group:${target.groupId}`
    if (seen.has(id)) continue
    seen.add(id)
    choices.push({ target, text: openRowText(titleOf(target), candidate.status, candidate.position) })
  }
  return { primary, choices: decision.alternatives?.length ? choices : choices.slice(0, 1) }
}

/** The title the sidebar shows for `runId`, when the run list has it. */
function taskTitle(runs: readonly RunSummary[], runId: string): string | undefined {
  const run = runs.find((candidate) => candidate.id === runId)
  return run ? runTitle(run) : undefined
}

function confirmationOf(proposal: VoiceProposal, runs: readonly RunSummary[]): VoiceConfirmation {
  const heading = confirmHeading(proposal.kind, taskTitle(runs, proposal.runId))
  return proposal.kind === 'answer'
    ? { heading, lines: answerLines(proposal.answers, voiceStore.headersFor(proposal.runId, proposal.askRequestId)) }
    : { heading, lines: [proposal.text] }
}

/** Return falls back to the row cmdk would select without voice: the first ordinary row. Return
 *  reaches this only from the Will do row, which sits above every ordinary row. */
function clickFirstItem() {
  document.querySelector<HTMLElement>('[cmdk-item]:not([data-slot^="voice-"]):not([data-disabled="true"])')?.click()
}

const OFF = {
  row: undefined,
  confirm: undefined,
  mode: 'idle' as const,
  onEnter: () => false,
  onClose: () => {},
  onSelect: () => {},
  onConfirm: () => {},
}

export function useVoiceCommand(args: {
  enabled: boolean
  text: string
  /** cmdk's selected value; Return commits a sentence only while it is `VOICE_ROW_VALUE`. */
  selected: string
  close(): void
  clearText(): void
}): {
  row: VoiceRow | undefined
  /** Set while a proposal waits for its confirmation in an empty input: the palette shows it
   *  instead of its search results. */
  confirm: VoiceConfirmation | undefined
  mode: VoiceMode
  /** True when voice handled the key (and prevented cmdk's own Return). */
  onEnter(event: React.KeyboardEvent): boolean
  onClose(): void
  /** A click on a voice row: the Will do row commits, a numbered row picks. */
  onSelect(choice?: number): void
  /** A click on the confirmation panel: the same as Return in the empty input. */
  onConfirm(): void
} {
  const { enabled } = args
  const runs = useRuns().data
  const [sidebarView] = useListView()
  const openRunId = useProjectMatch('/tasks/:id/*')?.params.id ?? null
  const projectId = useActiveProjectId()
  const view = voiceViewOf(useProjectPathname())
  const askRequestId = usePendingAsk(openRunId ?? undefined)
  const navigate = useNavigate()
  const proposal = useVoiceProposal()

  const trimmed = args.text.trim()
  const key = React.useMemo<DecisionKey>(
    () => ({ text: trimmed, projectId, view, openRunId, askRequestId, proposalId: proposal?.decisionId ?? null }),
    [trimmed, projectId, view, openRunId, askRequestId, proposal?.decisionId],
  )

  const [settled, setSettled] = React.useState<{ key: DecisionKey; result: Settled }>()
  /** `forKey` scopes a decision's notice to the context it was decided in: once the card or page
   *  syncs, a fresh preview replaces it, so Return never commits a decision nobody saw. */
  const [notice, setNotice] = React.useState<{ text: string; forText: string; forKey?: DecisionKey }>()
  const [choosing, setChoosing] = React.useState<Choosing>()

  // Choices resolved for another project, page, open task or sidebar tab are gone.
  const choosingHere =
    choosing !== undefined &&
    choosing.projectId === projectId &&
    choosing.view === view && choosing.openRunId === openRunId && choosing.sidebarView === sidebarView
      ? choosing
      : undefined
  const pick = choosingHere ? parseNumberedPick(trimmed, choosingHere.choices.length) : null
  // A new sentence that is not a pick ends the choice; an empty input or a pick keeps it.
  const choosingLive = choosingHere !== undefined && !(voiceable(trimmed) && pick === null) ? choosingHere : undefined

  // Every callback reads the latest render through this, never the render that created it.
  const latest = React.useRef({ ...args, key, runs: runs ?? [], sidebarView, openRunId, navigate, settled, choosing: choosingLive })
  latest.current = { ...args, key, runs: runs ?? [], sidebarView, openRunId, navigate, settled, choosing: choosingLive }

  const request = React.useRef<DecisionRequest | undefined>(undefined)
  const committing = React.useRef<DecisionRequest | undefined>(undefined)
  const mounted = React.useRef(false)
  /** Decisions a committed sentence acted on: closing never reports them as abandoned. */
  const acted = React.useRef(new Set<string>())
  /** One outcome per decision, whichever path reaches it first. */
  const reported = React.useRef(new Set<string>())

  const report = React.useCallback((decisionId: string, outcome: VoiceOutcome) => {
    if (reported.current.has(decisionId)) return
    reported.current.add(decisionId)
    reportVoiceOutcome(decisionId, outcome)
  }, [])

  const say = React.useCallback((text: string) => setNotice({ text, forText: latest.current.key.text }), [])
  /** A notice about a committed decision: it ends with the context the decision was made in. */
  const sayForDecision = React.useCallback((text: string) => setNotice({ text, forText: latest.current.key.text, forKey: latest.current.key }), [])

  /** The request for `requestKey`: the one already made for it, or a new one started now. */
  const requestFor = React.useCallback((requestKey: DecisionKey): DecisionRequest => {
    const current = request.current
    if (current && sameKey(current.key, requestKey) && !current.failed) return current
    current?.controller.abort()
    const controller = new AbortController()
    const shown = voiceStore.getProposal()
    const input: VoiceDecideRequest = {
      text: requestKey.text,
      sidebarView: latest.current.sidebarView,
      view: requestKey.view,
      ...(requestKey.openRunId === null ? {} : { openRunId: requestKey.openRunId }),
      ...(requestKey.askRequestId === undefined ? {} : { askRequestId: requestKey.askRequestId }),
      ...(shown && shown.decisionId === requestKey.proposalId
        ? { proposal: { decisionId: shown.decisionId, action: shown.kind } }
        : {}),
    }
    const made: DecisionRequest = {
      key: requestKey,
      controller,
      failed: false,
      result: voiceDecide(input, controller.signal).then(
        (decision): Settled => (controller.signal.aborted ? { kind: 'aborted' } : { kind: 'decision', decision }),
        (): Settled => (controller.signal.aborted ? { kind: 'aborted' } : { kind: 'failed' }),
      ),
    }
    void made.result.then((result) => {
      if (result.kind === 'failed') made.failed = true
      if (result.kind !== 'aborted' && mounted.current && request.current === made) setSettled({ key: requestKey, result })
    })
    request.current = made
    return made
  }, [])

  const openTarget = React.useCallback(
    (decisionId: string, target: Openable) => {
      report(decisionId, 'executed')
      // Opening another task leaves the proposal's card or composer behind.
      const live = voiceStore.getProposal()
      if (live) {
        voiceStore.cancel()
        report(live.decisionId, 'abandoned')
      }
      setChoosing(undefined)
      latest.current.close()
      latest.current.navigate(target.kind === 'run' ? `/tasks/${target.runId}` : `/compare/${target.groupId}`)
    },
    [report],
  )

  const confirmProposal = React.useCallback(() => {
    const live = voiceStore.getProposal()
    if (!live) return
    const result = voiceStore.confirm()
    if (result.ok) {
      report(live.decisionId, 'confirmed')
      latest.current.close()
    } else if ('unanswered' in result) {
      const first = result.unanswered[0]
      if (first) say(`Question ${first.index + 1} (${first.header}) still needs an answer.`)
    } else if (result.reason === 'busy') {
      say(NOTICES.busy)
    } else if (live.kind === 'answer') {
      // Only the card is off screen (a virtualized thread): its question is still open, and the
      // store re-applies the answers when the card mounts again. ThreadView and the palette's own
      // close and cancel end the proposal, never this key.
      say(NOTICES.scrollToQuestion)
    } else {
      // A tell whose composer is gone without the store noticing: nothing left to send to.
      voiceStore.cancel()
      report(live.decisionId, 'abandoned')
      say(NOTICES.taskClosed)
    }
  }, [report, say])

  const act = React.useCallback(
    (decision: VoiceDecision, made: DecisionRequest) => {
      acted.current.add(decision.decisionId)
      const { clearText, runs: currentRuns, sidebarView: view, openRunId: openId } = latest.current
      switch (decision.action) {
        case 'open': {
          const { primary, choices } = planOpen(decision, { runs: currentRuns, sidebarView: view, openRunId: openId })
          if (choices.length >= 2) {
            setChoosing({ decisionId: decision.decisionId, choices, projectId: made.key.projectId, view: made.key.view, openRunId: openId, sidebarView: view })
            clearText()
            return
          }
          const only = choices[0]
          if (only) return openTarget(decision.decisionId, only.target)
          return sayForDecision(primary.kind === 'empty' ? noTasksNotice(decision.status) : pastEndNotice(decision.status, decision.position))
        }
        case 'answer':
        case 'tell': {
          // A decision about another task than the one on screen has nothing to fill.
          if (decision.runId !== openId) return
          const result = voiceStore.propose(
            decision.action === 'answer'
              ? { kind: 'answer', decisionId: decision.decisionId, runId: decision.runId, askRequestId: decision.askRequestId, answers: decision.answers }
              : { kind: 'tell', decisionId: decision.decisionId, runId: decision.runId, text: decision.text },
          )
          if (result.ok) {
            if (result.replaced) report(result.replaced, 'replaced')
            setChoosing(undefined)
            clearText()
            return
          }
          return sayForDecision(result.reason === 'no-card' ? NOTICES.noCard : result.reason === 'draft-not-empty' ? NOTICES.draftNotEmpty : NOTICES.busy)
        }
        case 'confirm':
        case 'cancel': {
          // Only a proposal that was on screen when this sentence was committed.
          const shown = voiceStore.getProposal()
          if (made.key.proposalId === null || shown?.decisionId !== made.key.proposalId) return sayForDecision(NOTICES.unclear)
          if (decision.action === 'confirm') return confirmProposal()
          voiceStore.cancel()
          report(shown.decisionId, 'cancelled')
          clearText()
          return
        }
        case 'none':
          if (decision.reason === 'not-a-command') return clickFirstItem()
          return sayForDecision(NONE_NOTICES[decision.reason])
      }
    },
    [confirmProposal, openTarget, report, sayForDecision],
  )

  const commit = React.useCallback(async () => {
    const committedKey = latest.current.key
    const made = requestFor(committedKey)
    if (committing.current === made) return
    committing.current = made
    let timer: ReturnType<typeof setTimeout> | undefined
    const bound = new Promise<'timeout'>((resolve) => {
      timer = setTimeout(() => resolve('timeout'), VOICE_DECISION_BOUND_MS)
    })
    const result = await Promise.race([made.result, bound])
    clearTimeout(timer)
    // A move off the Will do row while Return waited ended this commit, even after a move back:
    // the row the user moved to was the choice then (the selection effect below clears it).
    const stillCommitted = committing.current === made
    if (stillCommitted) committing.current = undefined
    if (!stillCommitted || !mounted.current) return
    // The text, the open task or the shown proposal moved on: this decision is for something else.
    if (!sameKey(latest.current.key, committedKey)) return
    if (result === 'timeout') {
      // The late decision, if it ever comes, is aborted and so never acts.
      made.controller.abort()
      if (request.current === made) request.current = undefined
      sayForDecision(NOTICES.timedOut)
      return clickFirstItem()
    }
    if (result.kind === 'aborted') return
    if (result.kind === 'failed') {
      sayForDecision(NOTICES.unavailable)
      return clickFirstItem()
    }
    act(result.decision, made)
  }, [act, requestFor, sayForDecision])

  /** Opens candidate `index`: from the choice a committed sentence made, or from the preview's
   *  own candidates when one of them is clicked before Return. The preview counts only while it
   *  is the decision for the current text, open task and proposal, as for Return. */
  const choose = React.useCallback(
    (index: number) => {
      const current = latest.current
      if (current.choosing) {
        const choice = current.choosing.choices[index]
        if (choice) openTarget(current.choosing.decisionId, choice.target)
        return
      }
      const preview = current.settled
      if (!preview || !sameKey(preview.key, current.key) || !voiceable(current.key.text)) return
      if (preview.result.kind !== 'decision' || preview.result.decision.action !== 'open') return
      const { decision } = preview.result
      const choice = planOpen(decision, current).choices[index]
      if (!choice) return
      acted.current.add(decision.decisionId)
      openTarget(decision.decisionId, choice.target)
    },
    [openTarget],
  )

  // Leaving the Will do row ends a commit that is waiting for its decision; coming back does not
  // revive it, so only a fresh Return on the row commits again.
  const { selected } = args
  React.useEffect(() => {
    if (selected !== VOICE_ROW_VALUE) committing.current = undefined
  }, [selected])

  // Preview: ask a beat after the text settles. A change aborts the request for the old text.
  React.useEffect(() => {
    const current = request.current
    if (current && !sameKey(current.key, key)) {
      current.controller.abort()
      request.current = undefined
    }
    if (!enabled || !voiceable(key.text) || pick !== null || request.current) return
    const timer = setTimeout(() => requestFor(key), VOICE_PREVIEW_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [enabled, key, pick, requestFor])

  // A notice speaks about the text it was shown for. A new sentence, or another project, page, open
  // task or sidebar tab, ends a choice.
  const choiceEnded = choosing !== undefined && choosingLive === undefined
  React.useEffect(() => {
    setNotice((current) => (current && current.forText !== trimmed ? undefined : current))
  }, [trimmed])
  React.useEffect(() => {
    if (choiceEnded) setChoosing(undefined)
  }, [choiceEnded])

  // A proposal the store drops on its own: its question was answered elsewhere, its task closed.
  React.useEffect(() => {
    let previous = voiceStore.getProposal()
    return voiceStore.subscribe(() => {
      const now = voiceStore.getProposal()
      const reason = voiceStore.lastDrop()
      if (previous && !now && reason && latest.current.enabled) {
        report(previous.decisionId, 'abandoned')
        say(reason === 'question-closed' ? NOTICES.questionClosed : NOTICES.taskClosed)
      }
      previous = now
    })
  }, [report, say])

  const onClose = React.useCallback(() => {
    const current = latest.current
    if (!current.enabled) return
    request.current?.controller.abort()
    const live = voiceStore.getProposal()
    if (live) {
      voiceStore.cancel()
      report(live.decisionId, 'cancelled')
    }
    const preview = current.settled
    if (preview && sameKey(preview.key, current.key) && preview.result.kind === 'decision') {
      const { decision } = preview.result
      if (decision.action !== 'none' && !acted.current.has(decision.decisionId)) report(decision.decisionId, 'abandoned')
    }
    if (current.choosing) report(current.choosing.decisionId, 'abandoned')
  }, [report])

  // The palette body unmounts when the dialog closes, whichever way it closed.
  React.useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      onClose()
    }
  }, [onClose])

  const onEnter = React.useCallback(
    (event: React.KeyboardEvent): boolean => {
      const current = latest.current
      if (!current.enabled) return false
      const text = current.key.text
      const handled = () => {
        event.preventDefault()
        return true
      }
      // A held Return repeats its keydown, and a repeat that reached the emptied input would confirm the
      // proposal its first press made. Only a fresh press commits or confirms (spec "Input", 5).
      if (event.repeat) return voiceable(text) || voiceStore.getProposal() ? handled() : false
      if (current.choosing) {
        const index = parseNumberedPick(text, current.choosing.choices.length)
        if (index !== null) {
          choose(index)
          return handled()
        }
      }
      const live = voiceStore.getProposal()
      if (live && isCancelWord(text)) {
        voiceStore.cancel()
        report(live.decisionId, 'cancelled')
        current.clearText()
        return handled()
      }
      if (text === '' && live && !current.choosing) {
        confirmProposal()
        return handled()
      }
      if (voiceable(text) && current.selected === VOICE_ROW_VALUE) {
        void commit()
        return handled()
      }
      return false
    },
    [choose, commit, confirmProposal, report],
  )

  const onSelect = React.useCallback(
    (choice?: number) => {
      if (choice !== undefined) return choose(choice)
      if (voiceable(latest.current.key.text)) void commit()
    },
    [choose, commit],
  )

  if (!enabled) return OFF

  let row: VoiceRow | undefined
  if (notice && notice.forText === trimmed && (notice.forKey === undefined || sameKey(notice.forKey, key))) {
    row = { kind: 'notice', text: notice.text }
  } else if (choosingLive) {
    row = { kind: 'will-do', text: 'Which one?', choices: choosingLive.choices.map((choice) => choice.text) }
  } else if (settled && sameKey(settled.key, key) && voiceable(trimmed)) {
    row = previewRow(settled.result, settled.key, { runs: runs ?? [], sidebarView, openRunId })
  } else if (voiceable(trimmed) && pick === null) {
    row = { kind: 'will-do', text: 'Reading…', pending: true }
  }
  const confirm = proposal && trimmed === '' && !choosingLive ? confirmationOf(proposal, runs ?? []) : undefined

  const mode: VoiceMode = choosingLive ? 'choosing' : proposal ? 'proposal' : voiceable(trimmed) ? 'preview' : 'idle'
  return { row, confirm, mode, onEnter, onClose, onSelect, onConfirm: confirmProposal }
}

/** The Will do row for a decision that has not been committed yet. */
function previewRow(
  result: Settled,
  requestKey: DecisionKey,
  context: { runs: readonly RunSummary[]; sidebarView: SidebarView; openRunId: string | null },
): VoiceRow | undefined {
  if (result.kind === 'aborted') return undefined
  if (result.kind === 'failed') return { kind: 'notice', text: NOTICES.unavailable }
  const { decision } = result
  switch (decision.action) {
    case 'open': {
      const { primary, choices } = planOpen(decision, context)
      if (choices.length >= 2) return { kind: 'will-do', text: 'Which one?', choices: choices.map((choice) => choice.text) }
      const only = choices[0]
      if (only) return { kind: 'will-do', text: only.text }
      return {
        kind: 'notice',
        text: primary.kind === 'empty' ? noTasksNotice(decision.status) : pastEndNotice(decision.status, decision.position),
      }
    }
    case 'answer':
      if (decision.runId !== context.openRunId) return undefined
      return {
        kind: 'will-do',
        text: answerRowText(
          decision.answers,
          voiceStore.headersFor(decision.runId, decision.askRequestId),
          taskTitle(context.runs, decision.runId),
        ),
      }
    case 'tell':
      if (decision.runId !== context.openRunId) return undefined
      return { kind: 'will-do', text: tellRowText(decision.text, taskTitle(context.runs, decision.runId)) }
    case 'confirm':
    case 'cancel':
      if (requestKey.proposalId === null) return { kind: 'notice', text: NOTICES.unclear }
      return { kind: 'will-do', text: decision.action === 'confirm' ? 'Send it' : 'Drop it' }
    case 'none':
      if (decision.reason === 'not-a-command') return undefined
      return { kind: 'notice', text: NONE_NOTICES[decision.reason] }
  }
}
