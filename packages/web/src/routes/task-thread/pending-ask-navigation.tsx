import { Button } from '@/components/ui/button'

/**
 * Navigation between the pending question's two places (hearsay-tools/cezarion#1495): the
 * answerable card pinned after the newest entry, and the marker where the agent asked it.
 */

/** The first answer control of an ask card: a chip, Other, or an open question's textarea.
 *  A card with none (a question routed to the parent task) takes focus itself. */
export function firstAnswerControl(card: HTMLElement): HTMLElement {
  const control = card.querySelector<HTMLElement>(
    '[data-slot="ask-question"] :is(button, textarea):not(:disabled)',
  )
  if (control) return control
  card.tabIndex = -1
  return card
}

/** The pinned card's first answer control under `root`, or null while it is not mounted. */
export function pinnedAnswerControl(root: HTMLElement): HTMLElement | null {
  const card = root.querySelector<HTMLElement>('[data-slot="ask-card"][data-pinned="true"]')
  return card ? firstAnswerControl(card) : null
}

/** The jump pill's label: with a question pending, it names how many questions wait. */
export function jumpLabel(pendingQuestions: number): string {
  if (pendingQuestions <= 0) return 'Jump to latest'
  return `Jump to latest (${pendingQuestions} ${pendingQuestions === 1 ? 'question' : 'questions'} pending)`
}

/** The pending question's original place: context stays here, the answer form is pinned below. */
export function AskOriginMarker({ onGoToQuestion }: { onGoToQuestion: () => void }) {
  return (
    <div
      data-slot="ask-origin"
      className="flex flex-wrap items-center gap-x-2 rounded-lg border border-dashed border-accent-strong/40 px-3.5 py-1 text-xs text-muted-foreground"
    >
      <span className="font-medium text-link-foreground">Question asked here</span>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        data-slot="ask-go-to-question"
        className="min-h-11 min-w-11 px-2 text-foreground underline underline-offset-4"
        onClick={onGoToQuestion}
      >
        Go to the question
      </Button>
    </div>
  )
}
