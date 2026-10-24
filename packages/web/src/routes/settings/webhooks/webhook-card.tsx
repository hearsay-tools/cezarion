import { useState, type FormEvent } from 'react'

import {
  useCreateProjectWebhook,
  useRemoveProjectWebhook,
  useTestOneProjectWebhook,
  useUpdateProjectWebhook,
} from '@/api/queries'
import type { ProjectWebhook, TestProjectWebhookResponse } from '@open-mercato/cezar-api-client'
import { ChevronDownIcon } from '@/components/design-icons'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { toast } from '@/components/ui/toaster'
import { webhookLabel } from '@/lib/webhook'
import { createBody, draftFrom, EMPTY_DRAFT, updateBody, type WebhookDraft } from './webhook-draft'
import { WebhookFields } from './webhook-fields'

type Feedback = { tone: 'ok' | 'danger' | 'alert'; text: string }

const button = 'max-sm:h-11'

/** A save error keeps the form as typed and says how to recover. */
const notSaved = (error: Error, action: 'Save' | 'Create'): Feedback => ({
  tone: 'alert',
  text: `Not saved: ${error.message}. Fix the field and select ${action} again.`,
})

const testFeedback = (answer: TestProjectWebhookResponse): Feedback =>
  answer.dryRun
    ? { tone: 'ok', text: 'Dry run: nothing was sent.' }
    : answer.ok
      ? { tone: 'ok', text: `Delivered (HTTP ${answer.status ?? 200}).` }
      : { tone: 'danger', text: `Not delivered: ${answer.error ?? 'unknown error'}.` }

/** The line under the buttons: a test result (`status`) or a save error (`alert`). */
function FeedbackLine({ feedback }: { feedback: Feedback | null }) {
  if (!feedback) return null
  return (
    <p
      data-slot={feedback.tone === 'alert' ? 'webhook-error' : 'webhook-result'}
      role={feedback.tone === 'alert' ? 'alert' : 'status'}
      className={feedback.tone === 'ok' ? 'text-[13px] text-muted-foreground' : 'text-[13px] text-danger'}
    >
      {feedback.text}
    </p>
  )
}

const cardClass = 'rounded-md border border-border bg-background'
const formClass = 'flex flex-col gap-3 border-bs border-border p-3'

/**
 * One saved webhook: a summary row that opens its own form. The draft lives here, above the
 * collapsible content, so closing the card keeps unsaved edits, and every card keeps its own.
 */
export function WebhookCard({
  projectId,
  webhook,
  defaultOpen = false,
}: {
  projectId: string
  webhook: ProjectWebhook
  defaultOpen?: boolean
}) {
  const update = useUpdateProjectWebhook()
  const remove = useRemoveProjectWebhook()
  const test = useTestOneProjectWebhook()
  const [open, setOpen] = useState(defaultOpen)
  const [draft, setDraft] = useState<WebhookDraft>(() => draftFrom(webhook))
  const [feedback, setFeedback] = useState<Feedback | null>(null)

  const body = updateBody(draft, webhook)
  const dirty = Object.keys(body).length > 0
  const complete = draft.name.trim() !== '' && draft.url.trim() !== ''
  const busy = update.isPending || remove.isPending || test.isPending
  const ids = { projectId, webhookId: webhook.id }

  const save = (onSaved?: () => void) =>
    update.mutate(
      { ...ids, ...body },
      {
        onSuccess: () => {
          setDraft((current) => ({ ...current, token: '' }))
          if (onSaved) onSaved()
          else toast(`${draft.name.trim()} saved`)
        },
        onError: (error: Error) => setFeedback(notSaved(error, 'Save')),
      },
    )

  const runTest = () =>
    test.mutate(ids, {
      onSuccess: (answer) => setFeedback(testFeedback(answer)),
      onError: (error: Error) => setFeedback({ tone: 'danger', text: error.message }),
    })

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setFeedback(null)
    if (complete && dirty) save()
  }

  return (
    <li data-slot="webhook-card" data-webhook-id={webhook.id} className={cardClass}>
      <Collapsible open={open} onOpenChange={setOpen}>
        <CollapsibleTrigger asChild>
          <button
            type="button"
            data-action="webhook-toggle"
            className="group flex min-h-11 w-full items-center gap-3 rounded-md p-3 text-start focus-visible:outline-2 focus-visible:outline-offset-[-2px] focus-visible:outline-foreground pointer-hover:bg-muted/50 active:bg-muted/50"
          >
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span data-slot="webhook-card-name" className="min-w-0 break-words text-[13px] font-medium">{webhook.name}</span>
                {webhook.tasks ? <Badge variant="secondary" data-badge="tasks">Task notifications</Badge> : null}
                {webhook.agent ? <Badge variant="secondary" data-badge="agent">Agents</Badge> : null}
              </span>
              <span data-slot="webhook-card-url" className="truncate text-[12px] text-muted-foreground">{webhookLabel(webhook.url)}</span>
            </span>
            <ChevronDownIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground group-data-[state=open]:rotate-180" />
          </button>
        </CollapsibleTrigger>
        <CollapsibleContent>
          <form data-slot="webhook-form" className={formClass} onSubmit={onSubmit}>
            <WebhookFields
              draft={draft}
              tokenSet={webhook.tokenSet}
              onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))}
            />
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" className={button} data-action="webhook-save" disabled={busy || !complete || !dirty}>
                Save
              </Button>
              <Button
                type="button"
                size="sm"
                className={button}
                variant="outline"
                data-action="webhook-test"
                disabled={busy || !complete}
                onClick={() => {
                  setFeedback(null)
                  if (dirty) save(runTest)
                  else runTest()
                }}
              >
                Send test
              </Button>
              {webhook.tokenSet ? (
                <Button
                  type="button"
                  size="sm"
                  className={button}
                  variant="ghost"
                  data-action="webhook-clear-token"
                  disabled={busy}
                  onClick={() =>
                    update.mutate(
                      { ...ids, token: '' },
                      {
                        onSuccess: () => toast('Webhook token cleared'),
                        onError: (error: Error) => setFeedback({ tone: 'danger', text: `Token not cleared: ${error.message}.` }),
                      },
                    )
                  }
                >
                  Clear token
                </Button>
              ) : null}
              <Button
                type="button"
                size="sm"
                className={button}
                variant="danger-ghost"
                data-action="webhook-remove"
                aria-label={`Remove ${webhook.name}`}
                disabled={busy}
                onClick={() =>
                  remove.mutate(ids, {
                    onSuccess: () => toast(`${webhook.name} removed`),
                    onError: (error: Error) => setFeedback({ tone: 'danger', text: `Not removed: ${error.message}.` }),
                  })
                }
              >
                Remove
              </Button>
            </div>
            <FeedbackLine feedback={feedback} />
          </form>
        </CollapsibleContent>
      </Collapsible>
    </li>
  )
}

/** The unsaved card that Add webhook opens. Create posts it; the list then shows it as a normal
 *  card, and this one goes away. */
export function NewWebhookCard({
  projectId,
  onCreated,
  onCancel,
}: {
  projectId: string
  onCreated: (webhook: ProjectWebhook) => void
  onCancel: () => void
}) {
  const create = useCreateProjectWebhook()
  const [draft, setDraft] = useState<WebhookDraft>(EMPTY_DRAFT)
  const [feedback, setFeedback] = useState<Feedback | null>(null)
  const complete = draft.name.trim() !== '' && draft.url.trim() !== ''

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setFeedback(null)
    if (!complete) return
    create.mutate(
      { projectId, ...createBody(draft) },
      {
        onSuccess: ({ webhook }) => {
          toast(`${webhook.name} created`)
          onCreated(webhook)
        },
        onError: (error: Error) => setFeedback(notSaved(error, 'Create')),
      },
    )
  }

  return (
    <li data-slot="webhook-card" data-draft="" className={cardClass}>
      <p className="p-3 text-[13px] font-medium">New webhook</p>
      <form data-slot="webhook-form" aria-label="New webhook" className={formClass} onSubmit={onSubmit}>
        <WebhookFields draft={draft} tokenSet={false} onChange={(patch) => setDraft((current) => ({ ...current, ...patch }))} />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" className={button} data-action="webhook-create" disabled={create.isPending || !complete}>
            Create
          </Button>
          <Button type="button" size="sm" className={button} variant="ghost" data-action="webhook-cancel" disabled={create.isPending} onClick={onCancel}>
            Cancel
          </Button>
        </div>
        <FeedbackLine feedback={feedback} />
      </form>
    </li>
  )
}
