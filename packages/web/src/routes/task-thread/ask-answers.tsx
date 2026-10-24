import type { UiAskQuestion } from '@open-mercato/cezar-api-client'
import type { ThreadAsk } from './thread-state'

/** Read the existing header-prefixed reply format. Unstructured replies stay intact. */
function splitAnswers(questions: UiAskQuestion[], answer: string): string[] | undefined {
  if (questions.length === 1) return [answer.replace(new RegExp(`^${escapePattern(questions[0]!.header)}: ?`), '')]
  let rest = answer
  const answers: string[] = []
  for (const [index, question] of questions.entries()) {
    const prefix = `${question.header}: `
    if (!rest.startsWith(prefix)) return undefined
    rest = rest.slice(prefix.length)
    const next = questions[index + 1]
    const end = next ? rest.indexOf(`\n${next.header}: `) : rest.length
    if (end < 0) return undefined
    answers.push(rest.slice(0, end))
    rest = rest.slice(end + 1)
  }
  return answers
}

function escapePattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Labels may contain commas; accept only an unambiguous sequence of whole labels. */
function selectedLabels(question: UiAskQuestion, answer: string | undefined): string[] {
  if (answer === undefined) return []
  const options = question.options ?? []
  if (!question.multiSelect) return options.filter(option => option.label === answer).map(option => option.label)
  const matches: string[][] = []
  function match(rest: string, labels: string[]) {
    for (const { label } of options) {
      if (labels.includes(label)) continue
      if (rest === label) matches.push([...labels, label])
      else if (rest.startsWith(`${label}, `)) match(rest.slice(label.length + 2), [...labels, label])
    }
  }
  match(answer, [])
  return matches.length === 1 ? matches[0]! : []
}

/** Read-only decision details, reused at the reply's chronological position. */
export function AskAnswers({ ask }: { ask: ThreadAsk }) {
  const answers = ask.answer === undefined ? undefined : splitAnswers(ask.questions, ask.answer)
  return (
    <div data-slot="ask-answers" className="flex flex-col gap-4 text-sm">
      {ask.questions.map((question, index) => {
        const answer = answers?.[index]
        const selected = selectedLabels(question, answer)
        const other = answer !== undefined && selected.length === 0
        return (
          <section key={question.id ?? index} className="flex flex-col gap-2" aria-label={question.question}>
            <p className="text-xs font-medium text-muted-foreground">{question.header} · Question {index + 1} of {ask.questions.length}</p>
            <p className="break-words font-semibold">{question.question}</p>
            {question.options ? (
              <ul className="flex list-none flex-col gap-1.5">
                {question.options.map(option => (
                  <li key={option.label} data-selected={selected.includes(option.label)} className="flex items-start gap-2 rounded-md border border-border px-3 py-2 data-[selected=true]:border-message-user-border data-[selected=true]:bg-message-user-accent/5">
                    <span aria-hidden className="shrink-0 text-message-user-accent">{selected.includes(option.label) ? '✓' : '○'}</span>
                    <span className="min-w-0 flex-1 break-words"><span className="font-medium">{option.label}</span>{option.description ? <span className="block text-xs text-muted-foreground">{option.description}</span> : null}</span>
                    {selected.includes(option.label) ? <span className="shrink-0 text-xs text-message-user-accent">Selected</span> : null}
                  </li>
                ))}
                <li data-selected={other} className="rounded-md border border-border px-3 py-2 data-[selected=true]:border-message-user-border">
                  <p className="flex items-start gap-2 font-medium"><span aria-hidden className="text-message-user-accent">{other ? '✓' : '○'}</span><span className="flex-1">Other</span>{other ? <span className="text-xs text-message-user-accent">Selected</span> : null}</p>
                  {other ? <QuotedAnswer text={answer} /> : null}
                </li>
              </ul>
            ) : answer !== undefined ? <QuotedAnswer text={answer} /> : null}
          </section>
        )
      })}
      {!answers && ask.answer !== undefined ? <QuotedAnswer text={ask.answer} /> : null}
    </div>
  )
}

function QuotedAnswer({ text }: { text: string }) {
  return <blockquote className="[margin-block-start:0.5rem] border-s-2 border-message-user-accent ps-3 break-words whitespace-pre-wrap">{text}</blockquote>
}
