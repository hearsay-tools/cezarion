import { useId, useState, type FormEvent } from 'react'

import { useTestProjectWebhook, useUpdateProject } from '@/api/queries'
import type { ProjectListEntry, WebhookTrigger } from '@open-mercato/cezar-api-client'
import { DEFAULT_WEBHOOK_TRIGGERS, WEBHOOK_TRIGGERS } from '@open-mercato/cezar-api-client/contract/attention'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'

/**
 * Edit the project webhook and selected states. Token is write-only: empty keeps it, explicit
 * clear removes it. Save pending edits before testing the stored target; omit unchanged
 * triggers.
 */
/** The cockpit's name for each state and when a run is in it, in `WEBHOOK_TRIGGERS` order. */
const TRIGGER_LABELS: Record<WebhookTrigger, { label: string; hint: string }> = {
  'needs-you': { label: 'Needs you', hint: 'Asks a question, asks for permission, or waits for review' },
  failed: { label: 'Failed', hint: 'Failed, with no scheduled resume' },
  done: { label: 'Done', hint: 'Finished' },
  cancelled: { label: 'Cancelled', hint: 'Was cancelled' },
  running: { label: 'Running', hint: 'Runs an agent turn' },
  'waiting-workers': { label: 'Waiting for agents', hint: 'Waits on its workers or their replies' },
  'waiting-ci': { label: 'Waiting on CI', hint: "Waits on a pull request's checks" },
  'waiting-timer': { label: 'Waiting', hint: 'Waits on a timer' },
  'waiting-other': { label: 'Any other wait', hint: 'Waits on anything else, including wait types added later' },
}

const sameTriggers = (a: readonly WebhookTrigger[], b: readonly WebhookTrigger[]) =>
  a.length === b.length && a.every((trigger) => b.includes(trigger))

export function TaskWebhookField({ project }: { project: ProjectListEntry }) {
  const update = useUpdateProject()
  const test = useTestProjectWebhook()
  const urlId = useId()
  const tokenId = useId()
  const hintId = useId()
  const [url, setUrl] = useState(project.webhook?.url ?? '')
  const [token, setToken] = useState('')
  const storedTriggers = project.webhook?.triggers ?? DEFAULT_WEBHOOK_TRIGGERS
  const [triggers, setTriggers] = useState<readonly WebhookTrigger[]>(storedTriggers)
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const saved = project.webhook
  const trimmed = url.trim()
  const triggersChanged = !sameTriggers(triggers, storedTriggers)
  const dirty = trimmed !== (saved?.url ?? '') || token !== '' || triggersChanged
  const busy = update.isPending || test.isPending

  const save = (onSaved?: () => void) => {
    if (!trimmed) return
    update.mutate(
      {
        id: project.id,
        webhook: {
          url: trimmed,
          ...(token ? { token } : {}),
          // In `WEBHOOK_TRIGGERS` order, whatever order the boxes were ticked in.
          ...(triggersChanged ? { triggers: WEBHOOK_TRIGGERS.filter((trigger) => triggers.includes(trigger)) } : {}),
        },
      },
      {
        onSuccess: () => {
          setToken('')
          if (onSaved) onSaved()
          else toast('Task webhook saved')
        },
        onError: (error: Error) => toast(error.message, { tone: 'danger' }),
      },
    )
  }

  const runTest = () =>
    test.mutate(project.id, {
      onSuccess: (answer) =>
        setResult(
          answer.dryRun
            ? { ok: true, text: 'Dry run: nothing was sent.' }
            : answer.ok
              ? { ok: true, text: `Delivered (HTTP ${answer.status ?? 200}).` }
              : { ok: false, text: `Not delivered: ${answer.error ?? 'unknown error'}.` },
        ),
      onError: (error: Error) => setResult({ ok: false, text: error.message }),
    })

  const onSubmit = (event: FormEvent) => {
    event.preventDefault()
    setResult(null)
    save()
  }

  return (
    <SettingsField
      title="Task webhook"
      hint="Tasks you hand off, or start with notify on, POST here when they enter a state you select below, with the token as a Bearer header."
    >
      <form data-slot="task-webhook" className="flex flex-col gap-3" onSubmit={onSubmit}>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <label htmlFor={urlId} className="flex flex-col gap-1 text-[13px]">
            <span className="text-[11px] text-muted-foreground">URL</span>
            <Input
              id={urlId}
              data-slot="task-webhook-url"
              type="url"
              inputMode="url"
              autoComplete="off"
              spellCheck={false}
              placeholder="https://bot.example/hooks/cez"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
            />
          </label>
          <label htmlFor={tokenId} className="flex flex-col gap-1 text-[13px]">
            <span className="text-[11px] text-muted-foreground">Token</span>
            <Input
              id={tokenId}
              data-slot="task-webhook-token"
              type="password"
              autoComplete="new-password"
              spellCheck={false}
              aria-describedby={hintId}
              placeholder={saved?.tokenSet ? 'Token set — type to replace' : 'Optional Bearer token'}
              value={token}
              onChange={(event) => setToken(event.target.value)}
            />
          </label>
        </div>
        <p id={hintId} className="-mt-1 text-[11px] text-soft-foreground">
          {saved?.tokenSet
            ? 'The token is stored in ~/.cezar and never shown again. Leave it empty to keep it.'
            : 'The token is stored in ~/.cezar, never in the repo.'}
        </p>
        <fieldset data-slot="task-webhook-triggers" className="flex flex-col gap-1">
          <legend className="pbe-1 text-[11px] text-muted-foreground">Send a delivery when a task enters</legend>
          <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-x-3">
            {WEBHOOK_TRIGGERS.map((trigger) => (
              <label key={trigger} className="flex min-h-11 items-start gap-2.5 pbs-2 text-[13px]">
                <input
                  type="checkbox"
                  data-trigger={trigger}
                  checked={triggers.includes(trigger)}
                  onChange={(event) =>
                    setTriggers((current) =>
                      event.target.checked ? [...current, trigger] : current.filter((value) => value !== trigger),
                    )
                  }
                  className="mbs-0.5 size-[18px] shrink-0"
                />
                <span className="flex min-w-0 flex-col">
                  <span className="font-medium">{TRIGGER_LABELS[trigger].label}</span>
                  <span className="text-[11px] text-soft-foreground">{TRIGGER_LABELS[trigger].hint}</span>
                </span>
              </label>
            ))}
          </div>
          <p className="text-[11px] text-soft-foreground">Handing a task off and Send test always deliver.</p>
        </fieldset>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" size="sm" className="max-sm:h-11" data-action="task-webhook-save" disabled={busy || !trimmed || !dirty}>
            Save
          </Button>
          <Button
            type="button"
            size="sm" className="max-sm:h-11"
            variant="outline"
            data-action="task-webhook-test"
            disabled={busy || !trimmed}
            onClick={() => {
              setResult(null)
              if (dirty) save(runTest)
              else runTest()
            }}
          >
            Send test
          </Button>
          {saved?.tokenSet ? (
            <Button
              type="button"
              size="sm" className="max-sm:h-11"
              variant="ghost"
              data-action="task-webhook-clear-token"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  { id: project.id, webhook: { url: saved.url, token: '' } },
                  { onSuccess: () => toast('Webhook token cleared'), onError: (error: Error) => toast(error.message, { tone: 'danger' }) },
                )
              }
            >
              Clear token
            </Button>
          ) : null}
          {saved ? (
            <Button
              type="button"
              size="sm" className="max-sm:h-11"
              variant="danger-ghost"
              data-action="task-webhook-remove"
              disabled={busy}
              onClick={() =>
                update.mutate(
                  { id: project.id, webhook: null },
                  {
                    onSuccess: () => {
                      setUrl('')
                      setToken('')
                      setTriggers(DEFAULT_WEBHOOK_TRIGGERS)
                      setResult(null)
                      toast('Task webhook removed')
                    },
                    onError: (error: Error) => toast(error.message, { tone: 'danger' }),
                  },
                )
              }
            >
              Remove
            </Button>
          ) : null}
        </div>
        {result ? (
          <p
            data-slot="task-webhook-result"
            role="status"
            className={result.ok ? 'text-[13px] text-muted-foreground' : 'text-[13px] text-danger'}
          >
            {result.text}
          </p>
        ) : null}
      </form>
    </SettingsField>
  )
}
