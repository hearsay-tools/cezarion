import { useEffect, useId, useRef, useState } from 'react'

import type { ApiRun, VoiceAnswer } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Link } from '@/lib/project-router'
import { voiceStore, useVoiceProposal } from '@/lib/voice/proposal-store'
import { cn } from '@/lib/utils'

import { useAskAnswer } from './ask-answer'
import { Markdown } from './markdown'
import type { ThreadAsk } from './thread-state'
import type { UiAskQuestion } from '@open-mercato/cezar-api-client'

/** Format one answered question the way the agent reads it back. */
function formatAnswer(question: UiAskQuestion, labels: string[], otherAnswer?: string): string {
  return `${question.header}: ${otherAnswer?.trim() || labels.join(', ')}`
}

/**
 * The AskUser card (#473): the agent asked one or more structured questions (`cezar_ask`, the
 * ask line or a native ask); render each with clickable option chips. A question without
 * options is open (hearsay-tools/cezarion#1234): it shows only the answer field. A single
 * single-select question resolves on one tap; any other shape (multiple questions, a
 * multi-select question, or an open one) collects every answer and resolves on one **Send**
 * that posts a single combined message — the reducer resolves the whole card on that one user
 * message, so partial answers can never leak. Each question with options also offers an
 * optional Other answer that can be mixed with chip answers from the other questions. Either
 * way the answer rides `useAskAnswer`, which picks the seam the run's state
 * allows: the live reply while the engine owns a session, and a resume once it
 * has closed — a question outlives its session, so answering one that the agent
 * asked before an idle timeout or a restart reopens the session with the answer
 * as its opening prompt. The composer below stays available for a free-form
 * "Other". Once resolved, the card collapses to a compact summary.
 */
export function AskCard({ ask, run, onShowOrigin }: {
  ask: ThreadAsk
  run: ApiRun
  /** The pinned copy's link back to where the agent asked (hearsay-tools/cezarion#1495). */
  onShowOrigin?: () => void
}) {
  // An answered card is a static summary — split so the delivery hook (two mutations and a
  // provider-status subscription) only mounts for a question that can still be answered.
  // Threads accumulate asks; every resolved one would otherwise carry live machinery for a
  // question nobody can answer again.
  if (ask.resolved) {
    return (
      <div
        data-slot="ask-card"
        data-resolved="true"
        className="rounded-lg border border-border bg-card px-3.5 py-2.5 text-xs text-muted-foreground"
      >
        <span className="text-soft-foreground">
          {ask.closed === 'finish' ? 'Closed when the task finished' : ask.closed === 'superseded' ? 'Closed when the worker went on' : ask.answeredBy === 'parent' ? 'Answered by parent' : 'Answered'}
        </span>
        {ask.answer ? (
          <span className="ml-1.5 break-words whitespace-pre-line text-foreground">{ask.answer}</span>
        ) : null}
      </div>
    )
  }
  const showOrigin = ask.placement === 'pinned' && onShowOrigin ? onShowOrigin : undefined
  if (ask.routedToParent) return <RoutedAsk ask={ask} onShowOrigin={showOrigin} />
  return <PendingAsk ask={ask} run={run} onShowOrigin={showOrigin} />
}

/** The pinned copy's link to the question's original place in the transcript. */
function ShowOriginLink({ onShowOrigin }: { onShowOrigin: () => void }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      data-slot="ask-show-origin"
      className="mbs-2 min-h-11 min-w-11 px-2 text-xs font-medium text-muted-foreground underline underline-offset-4"
      onClick={onShowOrigin}
    >
      Show where it was asked
    </Button>
  )
}

/**
 * The draft, findings or evidence the agent sent with its question (hearsay-tools/cezarion#1458),
 * as Markdown above the questions. A long one scrolls inside the card, so the questions and
 * their chips stay in reach; the region takes focus so a keyboard can scroll it.
 */
function AskContext({ text }: { text: string }) {
  return (
    <div
      data-slot="ask-context"
      role="region"
      aria-label="Context"
      tabIndex={0}
      className="mbe-3 [max-block-size:min(45dvh,28rem)] overflow-y-auto overscroll-contain rounded-md border border-border bg-background/60 px-3 py-2 text-sm break-words text-foreground focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
    >
      <Markdown breaks>{text}</Markdown>
    </div>
  )
}

/** A worker's question sent to its parent task (#505): read-only here, answered there. If the
 *  parent can no longer answer, the question falls back and this becomes the ordinary card. */
function RoutedAsk({ ask, onShowOrigin }: { ask: ThreadAsk; onShowOrigin: (() => void) | undefined }) {
  return (
    <div
      data-slot="ask-card"
      data-resolved="false"
      data-pinned={ask.placement === 'pinned' ? 'true' : undefined}
      data-routed="parent"
      className="rounded-lg border border-border bg-card px-4 pt-3.5 pb-3.5"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-xs font-medium text-link-foreground">The agent is asking its parent</span>
      </div>
      {ask.context ? <AskContext text={ask.context} /> : null}
      <div className="flex flex-col gap-3">
        {ask.questions.map((question, index) => (
          <div key={question.id ?? index} role="group" aria-label={question.question}>
            <div className="mb-0.5 flex items-center gap-2">
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {question.header}
              </span>
            </div>
            <p className="mb-1.5 break-words text-sm font-semibold text-foreground">{question.question}</p>
            {question.options ? (
              <ul className="flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-muted-foreground">
                {question.options.map((option) => (
                  <li key={option.label} className="break-words">
                    <span className="text-foreground">{option.label}</span>
                    {option.description ? <span>: {option.description}</span> : null}
                  </li>
                ))}
              </ul>
            ) : (
              <p data-slot="ask-open-routed" className="text-[13px] text-muted-foreground">
                Open question: answered in words, with no options.
              </p>
            )}
          </div>
        ))}
      </div>
      <p data-slot="ask-routed-hint" className="mt-3 text-xs text-muted-foreground">
        Routed to parent: answer it in the{' '}
        {ask.parentRunId ? (
          <Link to={`/tasks/${ask.parentRunId}`} className="font-medium text-foreground underline underline-offset-4">
            parent task
          </Link>
        ) : (
          'parent task'
        )}
        .
      </p>
      {onShowOrigin ? <ShowOriginLink onShowOrigin={onShowOrigin} /> : null}
    </div>
  )
}

/** The unanswered card: option chips wired to whichever delivery seam the run's state allows. */
function PendingAsk({ ask, run, onShowOrigin }: { ask: ThreadAsk; run: ApiRun; onShowOrigin: (() => void) | undefined }) {
  const delivery = useAskAnswer(run)
  const blocked = delivery.blockedBy !== undefined
  const questions = ask.questions
  // One-tap only when there is a single single-select question with options; every
  // other shape needs a combined Send so no question's answer is dropped.
  const oneTap = questions.length === 1 && questions[0]?.options !== undefined && questions[0]?.multiSelect !== true
  const [selections, setSelections] = useState<Record<number, string[]>>({})
  const [otherAnswers, setOtherAnswers] = useState<Record<number, string>>({})

  const setQuestion = (index: number, labels: string[]) =>
    setSelections((prev) => ({ ...prev, [index]: labels }))

  const clearOtherAnswer = (index: number) =>
    setOtherAnswers((prev) => {
      if (prev[index] === undefined) return prev
      const next = { ...prev }
      delete next[index]
      return next
    })

  const selectOther = (index: number) => {
    setQuestion(index, [])
    setOtherAnswers((prev) => ({ ...prev, [index]: prev[index] ?? '' }))
  }

  // An open question is typed, like an Other answer.
  const hasOtherAnswer = questions.some((question, index) => !question.options || otherAnswers[index] !== undefined)
  const allAnswered = questions.every(
    (_, index) => (selections[index]?.length ?? 0) > 0 || Boolean(otherAnswers[index]?.trim()),
  )

  const sendAll = () =>
    void delivery.send(
      questions
        .map((q, index) => formatAnswer(q, selections[index] ?? [], otherAnswers[index]))
        .join('\n'),
    )

  // ---- voice proposal (spec 2026-10-21-voice-mode) -----------------------------------------
  // The store registers this card once per mount, so its methods read `latest`, which every
  // render (and every apply) refreshes, never the render that registered them.
  const rootRef = useRef<HTMLDivElement>(null)
  const latest = useRef({ selections, otherAnswers, sendAll, canSend: !delivery.isPending && !blocked })
  latest.current = { ...latest.current, selections, otherAnswers, sendAll, canSend: !delivery.isPending && !blocked }
  const proposal = useVoiceProposal()
  const voiceAnswers =
    proposal?.kind === 'answer' && proposal.runId === run.id && proposal.askRequestId === ask.id
      ? proposal.answers
      : undefined

  useEffect(() => {
    const setBoth = (nextSelections: Record<number, string[]>, nextOthers: Record<number, string>) => {
      latest.current = { ...latest.current, selections: nextSelections, otherAnswers: nextOthers }
      setSelections(nextSelections)
      setOtherAnswers(nextOthers)
    }
    return voiceStore.registerAskCard({
      runId: run.id,
      requestId: ask.id,
      headers: questions.map((question) => question.header),
      // The store keeps what the card held before voice, so a remount can still be put back.
      read: () => ({ selections: latest.current.selections, otherAnswers: latest.current.otherAnswers }),
      apply: (answers: VoiceAnswer[], options = { reveal: true }) => {
        const { selections: current, otherAnswers: currentOthers } = latest.current
        const nextSelections = { ...current }
        const nextOthers = { ...currentOthers }
        for (const answer of answers) {
          const question = questions[answer.question]
          if (!question) continue
          if (answer.kind === 'option' && question.options) {
            nextSelections[answer.question] = question.multiSelect === true ? answer.labels : answer.labels.slice(0, 1)
            delete nextOthers[answer.question]
          } else if (answer.kind === 'other') {
            nextSelections[answer.question] = []
            nextOthers[answer.question] = answer.text
          }
        }
        setBoth(nextSelections, nextOthers)
        if (options.reveal) rootRef.current?.scrollIntoView?.({ block: 'nearest' })
      },
      restore: (values) => setBoth(values.selections, values.otherAnswers),
      unanswered: () =>
        questions.flatMap((_, index) =>
          (latest.current.selections[index]?.length ?? 0) > 0 || Boolean(latest.current.otherAnswers[index]?.trim())
            ? []
            : [index],
        ),
      send: () => {
        // The card's own state says why it cannot send (pending, provider gate); the voice-filled
        // answers and the proposal stay, so a later confirm or cancel still works.
        if (!latest.current.canSend) return false
        latest.current.sendAll()
        return true
      },
    })
  }, [run.id, ask.id])

  // The session ended before the question was answered — say so, because sending the
  // answer now does more than reply: it reopens the agent's session to deliver it.
  const resuming = delivery.mode === 'resume'

  return (
    <div
      ref={rootRef}
      data-slot="ask-card"
      data-resolved="false"
      data-pinned={ask.placement === 'pinned' ? 'true' : undefined}
      data-delivery={delivery.mode}
      data-voice-proposal={voiceAnswers ? 'true' : undefined}
      className="rounded-lg border border-accent-strong/25 bg-accent-strong/[0.04] px-4 pt-3.5 pb-3.5"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-xs font-medium text-link-foreground">The agent is asking</span>
      </div>
      {ask.context ? <AskContext text={ask.context} /> : null}
      <div className="flex flex-col gap-4">
        {questions.map((question, index) => (
          <AskQuestionBlock
            key={question.id ?? index}
            question={question}
            disabled={delivery.isPending || blocked}
            selected={selections[index] ?? []}
            isOther={otherAnswers[index] !== undefined}
            otherAnswer={otherAnswers[index] ?? ''}
            voiceFilled={voiceAnswers?.some((answer) => answer.question === index) ?? false}
            onSelect={(labels) => {
              if (blocked) return
              clearOtherAnswer(index)
              // A voice proposal never takes the one-tap path: the chip only changes the answer,
              // and the confirmation sends what the card shows.
              if (oneTap && !voiceAnswers) void delivery.send(formatAnswer(question, labels))
              else setQuestion(index, labels)
            }}
            onOtherToggle={() => {
              if (blocked) return
              if (otherAnswers[index] === undefined) selectOther(index)
              else clearOtherAnswer(index)
            }}
            onOtherChange={(answer) =>
              setOtherAnswers((prev) => ({ ...prev, [index]: answer }))
            }
          />
        ))}
      </div>
      {oneTap && !hasOtherAnswer ? (
        resuming ? (
          <p data-slot="ask-resume-hint" className="mt-3 text-[11px] text-soft-foreground">
            The session has ended — your answer reopens it and goes to the agent.
          </p>
        ) : null
      ) : (
        <div className="mt-3 flex items-center gap-2.5">
          <Button
            size="sm"
            className="min-h-11"
            disabled={delivery.isPending || blocked || !allAnswered}
            onClick={sendAll}
          >
            {resuming ? 'Send answer & reopen' : 'Send answer'}
          </Button>
          {/* The slot names the resume state, so a selector for it can never match the ordinary
              "pick one or more" hint a live run shows. */}
          <span
            data-slot={resuming ? 'ask-resume-hint' : 'ask-hint'}
            className="text-[11px] text-soft-foreground"
          >
            {resuming
              ? 'the session has ended — sending reopens it'
              : hasOtherAnswer
                ? `${questions.length > 1 ? 'answer each question above' : 'enter your answer above'} — or type a reply below`
                : `${questions.length > 1 ? 'answer each question' : 'pick one or more'} — or type a reply below`}
          </span>
        </div>
      )}
      {voiceAnswers ? (
        <p data-slot="ask-voice-prompt" className="mt-3 text-xs font-medium text-foreground">
          Send these answers? Say “yes, confirmed” or press Return.
        </p>
      ) : null}
      {delivery.blockedBy === 'provider' ? (
        <div data-slot="ask-provider-gate" className="mt-3 flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
          <span>{delivery.reason}</span>
          <Link to="/settings/agents#providers" className="font-medium text-foreground underline underline-offset-4">
            Configure providers
          </Link>
        </div>
      ) : null}
      {delivery.blockedBy === 'no-session' ? (
        <p data-slot="ask-no-session" className="mt-3 text-xs text-muted-foreground">
          {delivery.reason}
        </p>
      ) : null}
      {/* A dropped answer used to be silent — the tap did nothing and said nothing. */}
      {delivery.error ? (
        <p data-slot="ask-error" role="alert" className="mt-3 text-xs text-danger">
          {delivery.error}
        </p>
      ) : null}
      {onShowOrigin ? <ShowOriginLink onShowOrigin={onShowOrigin} /> : null}
    </div>
  )
}

function AskQuestionBlock({
  question,
  disabled,
  selected,
  isOther,
  otherAnswer,
  voiceFilled,
  onSelect,
  onOtherToggle,
  onOtherChange,
}: {
  question: UiAskQuestion
  disabled: boolean
  selected: string[]
  isOther: boolean
  otherAnswer: string
  /** A voice proposal filled this question. */
  voiceFilled: boolean
  onSelect: (labels: string[]) => void
  onOtherToggle: () => void
  onOtherChange: (answer: string) => void
}) {
  const answerId = useId()
  const options = question.options
  const multiSelect = options !== undefined && question.multiSelect === true

  const pick = (label: string) => {
    if (!multiSelect) {
      onSelect([label])
      return
    }
    onSelect(
      selected.includes(label) ? selected.filter((l) => l !== label) : [...selected, label],
    )
  }

  return (
    <div data-slot="ask-question" role="group" aria-label={question.question} data-voice-filled={voiceFilled ? 'true' : undefined}>
      <div className="mb-0.5 flex items-center gap-2">
        <span className="rounded-md bg-accent-strong px-1.5 py-0.5 text-[12px] font-semibold uppercase tracking-wide text-accent-strong-foreground">
          {question.header}
        </span>
        {multiSelect ? (
          <span className="ml-auto text-[11px] text-soft-foreground">select all that apply</span>
        ) : null}
      </div>
      <p className="mb-2.5 break-words text-sm font-semibold text-foreground">{question.question}</p>
      {options ? (
        <>
          <div className="flex flex-col gap-2">
            {options.map((option) => {
              const isSelected = selected.includes(option.label)
              return (
                <button
                  key={option.label}
                  type="button"
                  disabled={disabled}
                  aria-pressed={isSelected}
                  onClick={() => pick(option.label)}
                  className={cn(
                    'flex min-h-11 w-full flex-col gap-0.5 rounded-md border px-3.5 py-2.5 text-left transition-colors',
                    'hover:border-accent-strong/50 hover:bg-accent-strong/[0.06] disabled:pointer-events-none disabled:opacity-50',
                    isSelected ? 'border-accent-strong/60 bg-accent-strong/[0.06]' : 'border-border bg-card',
                  )}
                >
                  <span className="flex min-w-0 items-start gap-2 text-[14px] font-semibold text-foreground">
                    {multiSelect ? (
                      <span
                        aria-hidden
                        className={cn(
                          'flex size-4 shrink-0 items-center justify-center rounded border text-[12px]',
                          isSelected
                            ? 'border-accent-strong bg-accent-strong text-accent-strong-foreground'
                            : 'border-soft-foreground',
                        )}
                      >
                        {isSelected ? '✓' : ''}
                      </span>
                    ) : null}
                    <span className="min-w-0 break-words">{option.label}</span>
                  </span>
                  {option.description ? (
                    <span className="min-w-0 break-words text-xs text-muted-foreground">
                      {option.description}
                    </span>
                  ) : null}
                </button>
              )
            })}
          </div>
          <div className="mt-2">
            <Button
              type="button"
              variant="outline"
              aria-pressed={isOther}
              aria-expanded={isOther}
              aria-controls={isOther ? answerId : undefined}
              disabled={disabled}
              onClick={onOtherToggle}
              className={cn(
                'w-full justify-start text-left',
                isOther && 'border-accent-strong/60 bg-accent-strong/[0.06]',
              )}
            >
              Other
            </Button>
            {isOther ? (
              <div className="mt-2.5">
                <label htmlFor={answerId} className="mb-1.5 block text-xs font-medium text-foreground">
                  Your answer
                </label>
                <Textarea
                  id={answerId}
                  rows={2}
                  value={otherAnswer}
                  disabled={disabled}
                  onChange={(event) => onOtherChange(event.target.value)}
                  className="bg-card"
                />
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <div>
          <label htmlFor={answerId} className="mb-1.5 block text-xs font-medium text-foreground">
            Your answer
          </label>
          <Textarea
            id={answerId}
            rows={2}
            value={otherAnswer}
            disabled={disabled}
            onChange={(event) => onOtherChange(event.target.value)}
            className="bg-card"
          />
        </div>
      )}
    </div>
  )
}
