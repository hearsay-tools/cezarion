import { useId, useState } from 'react'

import type { ApiRun } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Link } from '@/lib/project-router'
import { cn } from '@/lib/utils'

import { useAskAnswer } from './ask-answer'
import type { ThreadAsk } from './thread-state'
import type { UiAskQuestion } from '@open-mercato/cezar-api-client'

/** Format one answered question the way the agent reads it back. */
function formatAnswer(question: UiAskQuestion, labels: string[], otherAnswer?: string): string {
  return `${question.header}: ${otherAnswer?.trim() || labels.join(', ')}`
}

/**
 * The AskUser card (#473): the agent asked one or more structured multiple-choice
 * questions via `CEZ:ASK`; render each with clickable option chips. A single
 * single-select question resolves on one tap; any other shape (multiple
 * questions, or a multi-select question) collects every answer and resolves on
 * one **Send** that posts a single combined message — the reducer resolves the
 * whole card on that one user message, so partial answers can never leak. Each
 * question also offers an optional Other answer that can be mixed with chip answers
 * from the other questions. Either
 * way the answer rides `useAskAnswer`, which picks the seam the run's state
 * allows: the live reply while the engine owns a session, and a resume once it
 * has closed — a question outlives its session, so answering one that the agent
 * asked before an idle timeout or a restart reopens the session with the answer
 * as its opening prompt. The composer below stays available for a free-form
 * "Other". Once resolved, the card collapses to a compact summary.
 */
export function AskCard({ ask, run }: { ask: ThreadAsk; run: ApiRun }) {
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
        <span className="text-soft-foreground">{ask.answeredBy === 'parent' ? 'Answered by parent' : 'Answered'}</span>
        {ask.answer ? (
          <span className="ml-1.5 break-words whitespace-pre-line text-foreground">{ask.answer}</span>
        ) : null}
      </div>
    )
  }
  if (ask.routedToParent) return <RoutedAsk ask={ask} />
  return <PendingAsk ask={ask} run={run} />
}

/** A worker's question sent to its parent task (#505): read-only here, answered there. If the
 *  parent can no longer answer, the question falls back and this becomes the ordinary card. */
function RoutedAsk({ ask }: { ask: ThreadAsk }) {
  return (
    <div
      data-slot="ask-card"
      data-resolved="false"
      data-routed="parent"
      className="rounded-lg border border-border bg-card px-4 pt-3.5 pb-3.5"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-xs font-medium text-link-foreground">The agent is asking its parent</span>
      </div>
      <div className="flex flex-col gap-3">
        {ask.questions.map((question, index) => (
          <div key={question.id ?? index} role="group" aria-label={question.question}>
            <div className="mb-0.5 flex items-center gap-2">
              <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                {question.header}
              </span>
            </div>
            <p className="mb-1.5 break-words text-sm font-semibold text-foreground">{question.question}</p>
            <ul className="flex list-disc flex-col gap-0.5 pl-5 text-[13px] text-muted-foreground">
              {question.options.map((option) => (
                <li key={option.label} className="break-words">
                  <span className="text-foreground">{option.label}</span>
                  {option.description ? <span>: {option.description}</span> : null}
                </li>
              ))}
            </ul>
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
    </div>
  )
}

/** The unanswered card: option chips wired to whichever delivery seam the run's state allows. */
function PendingAsk({ ask, run }: { ask: ThreadAsk; run: ApiRun }) {
  const delivery = useAskAnswer(run)
  const blocked = delivery.blockedBy !== undefined
  const questions = ask.questions
  // One-tap only when there is a single single-select question; every other
  // shape needs a combined Send so no question's answer is dropped.
  const oneTap = questions.length === 1 && questions[0]?.multiSelect !== true
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

  const hasOtherAnswer = questions.some((_, index) => otherAnswers[index] !== undefined)
  const allAnswered = questions.every(
    (_, index) => (selections[index]?.length ?? 0) > 0 || Boolean(otherAnswers[index]?.trim()),
  )

  const sendAll = () =>
    void delivery.send(
      questions
        .map((q, index) => formatAnswer(q, selections[index] ?? [], otherAnswers[index]))
        .join('\n'),
    )

  // The session ended before the question was answered — say so, because sending the
  // answer now does more than reply: it reopens the agent's session to deliver it.
  const resuming = delivery.mode === 'resume'

  return (
    <div
      data-slot="ask-card"
      data-resolved="false"
      data-delivery={delivery.mode}
      className="rounded-lg border border-accent-strong/25 bg-accent-strong/[0.04] px-4 pt-3.5 pb-3.5"
    >
      <div className="mb-2.5 flex items-center gap-2">
        <span className="text-xs font-medium text-link-foreground">The agent is asking</span>
      </div>
      <div className="flex flex-col gap-4">
        {questions.map((question, index) => (
          <AskQuestionBlock
            key={question.id ?? index}
            question={question}
            disabled={delivery.isPending || blocked}
            selected={selections[index] ?? []}
            isOther={otherAnswers[index] !== undefined}
            otherAnswer={otherAnswers[index] ?? ''}
            onSelect={(labels) => {
              if (blocked) return
              clearOtherAnswer(index)
              if (oneTap) void delivery.send(formatAnswer(question, labels))
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
          <p data-slot="ask-resume-hint" className="mt-3 text-[11.5px] text-soft-foreground">
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
            className="text-[11.5px] text-soft-foreground"
          >
            {resuming
              ? 'the session has ended — sending reopens it'
              : hasOtherAnswer
                ? `${questions.length > 1 ? 'answer each question above' : 'enter your answer above'} — or type a reply below`
                : `${questions.length > 1 ? 'answer each question' : 'pick one or more'} — or type a reply below`}
          </span>
        </div>
      )}
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
    </div>
  )
}

function AskQuestionBlock({
  question,
  disabled,
  selected,
  isOther,
  otherAnswer,
  onSelect,
  onOtherToggle,
  onOtherChange,
}: {
  question: UiAskQuestion
  disabled: boolean
  selected: string[]
  isOther: boolean
  otherAnswer: string
  onSelect: (labels: string[]) => void
  onOtherToggle: () => void
  onOtherChange: (answer: string) => void
}) {
  const answerId = useId()
  const multiSelect = question.multiSelect === true

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
    <div role="group" aria-label={question.question}>
      <div className="mb-0.5 flex items-center gap-2">
        <span className="rounded-md bg-accent-strong px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-accent-strong-foreground">
          {question.header}
        </span>
        {multiSelect ? (
          <span className="ml-auto text-[10.5px] text-soft-foreground">select all that apply</span>
        ) : null}
      </div>
      <p className="mb-2.5 break-words text-sm font-semibold text-foreground">{question.question}</p>
      <div className="flex flex-col gap-2">
        {question.options.map((option) => {
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
              <span className="flex min-w-0 items-start gap-2 text-[13.5px] font-semibold text-foreground">
                {multiSelect ? (
                  <span
                    aria-hidden
                    className={cn(
                      'flex size-4 shrink-0 items-center justify-center rounded border text-[10px]',
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
    </div>
  )
}
