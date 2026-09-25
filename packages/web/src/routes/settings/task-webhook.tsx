import { useId, useState, type FormEvent } from 'react'

import { useTestProjectWebhook, useUpdateProject } from '@/api/queries'
import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { toast } from '@/components/ui/toaster'
import { SettingsField } from './settings-field'

/**
 * Project settings → General → Task webhook (#589): where this project's opted-in tasks POST
 * their status changes, and the Bearer token they send.
 *
 * The token is write-only. The server never answers it, only `tokenSet`, so the field stays
 * empty and says "Token set" instead; leaving it empty on Save keeps the stored token, and
 * "Clear token" is the one way to remove it. "Send test" posts one `task.test` delivery to the
 * STORED webhook, so an unsaved edit is saved first rather than tested against what is on disk.
 */
export function TaskWebhookField({ project }: { project: ProjectListEntry }) {
  const update = useUpdateProject()
  const test = useTestProjectWebhook()
  const urlId = useId()
  const tokenId = useId()
  const hintId = useId()
  const [url, setUrl] = useState(project.webhook?.url ?? '')
  const [token, setToken] = useState('')
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)

  const saved = project.webhook
  const trimmed = url.trim()
  const dirty = trimmed !== (saved?.url ?? '') || token !== ''
  const busy = update.isPending || test.isPending

  const save = (onSaved?: () => void) => {
    if (!trimmed) return
    update.mutate(
      { id: project.id, webhook: { url: trimmed, ...(token ? { token } : {}) } },
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
      hint="Tasks you hand off, or start with notify on, POST their status changes here with the token as a Bearer header."
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
