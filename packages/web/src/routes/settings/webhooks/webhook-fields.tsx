import { useId } from 'react'

import { WEBHOOK_TRIGGERS } from '@open-mercato/cezar-api-client/contract/attention'
import {
  PROJECT_WEBHOOK_DESCRIPTION_MAX_LENGTH,
  PROJECT_WEBHOOK_NAME_MAX_LENGTH,
  PROJECT_WEBHOOK_TOKEN_MAX_LENGTH,
  PROJECT_WEBHOOK_URL_MAX_LENGTH,
} from '@open-mercato/cezar-api-client/contract/project-limits'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { Textarea } from '@/components/ui/textarea'
import { TRIGGER_LABELS } from './trigger-labels'
import type { WebhookDraft } from './webhook-draft'

const fieldLabel = 'flex flex-col gap-1 text-[13px]'
const fieldCaption = 'text-[11px] text-muted-foreground'

/** The inputs of one webhook form. Controlled: the card owns the draft, so collapsing the card
 *  or editing another one never resets it. */
export function WebhookFields({
  draft,
  onChange,
  tokenSet,
}: {
  draft: WebhookDraft
  onChange: (patch: Partial<WebhookDraft>) => void
  tokenSet: boolean
}) {
  const nameId = useId()
  const descriptionId = useId()
  const descriptionHintId = useId()
  const urlId = useId()
  const tokenId = useId()
  const tokenHintId = useId()
  const tasksId = useId()
  const tasksHintId = useId()
  const agentId = useId()
  const agentHintId = useId()

  return (
    <>
      <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,14rem),1fr))] gap-3">
        <div className={fieldLabel}>
          <label htmlFor={nameId} className={fieldCaption}>Name</label>
          <Input
            id={nameId}
            data-slot="webhook-name"
            autoComplete="off"
            maxLength={PROJECT_WEBHOOK_NAME_MAX_LENGTH}
            placeholder="e.g. Team bot"
            value={draft.name}
            onChange={(event) => onChange({ name: event.target.value })}
          />
        </div>
        <div className={fieldLabel}>
          <label htmlFor={urlId} className={fieldCaption}>URL</label>
          <Input
            id={urlId}
            data-slot="webhook-url"
            type="url"
            inputMode="url"
            autoComplete="off"
            spellCheck={false}
            maxLength={PROJECT_WEBHOOK_URL_MAX_LENGTH}
            placeholder="https://bot.example/hooks/cez"
            value={draft.url}
            onChange={(event) => onChange({ url: event.target.value })}
          />
        </div>
      </div>
      <div className={fieldLabel}>
        <label htmlFor={descriptionId} className={fieldCaption}>Description</label>
        <Textarea
          id={descriptionId}
          data-slot="webhook-description"
          aria-describedby={descriptionHintId}
          rows={2}
          maxLength={PROJECT_WEBHOOK_DESCRIPTION_MAX_LENGTH}
          placeholder="e.g. Posts to the #releases channel. Use it for release notes."
          value={draft.description}
          onChange={(event) => onChange({ description: event.target.value })}
        />
        <span id={descriptionHintId} className="text-[11px] text-soft-foreground">
          Agents read the name and description to decide when to use this webhook.
        </span>
      </div>
      <div className={fieldLabel}>
        <label htmlFor={tokenId} className={fieldCaption}>Token</label>
        <Input
          id={tokenId}
          data-slot="webhook-token"
          type="password"
          autoComplete="new-password"
          spellCheck={false}
          maxLength={PROJECT_WEBHOOK_TOKEN_MAX_LENGTH}
          aria-describedby={tokenHintId}
          placeholder={tokenSet ? 'Token set — type to replace' : 'Optional Bearer token'}
          value={draft.token}
          onChange={(event) => onChange({ token: event.target.value })}
        />
        <span id={tokenHintId} className="text-[11px] text-soft-foreground">
          {tokenSet
            ? 'The token is stored in ~/.cezar and never shown again. Leave it empty to keep it.'
            : 'The token is stored in ~/.cezar, never in the repo. It is sent as a Bearer header.'}
        </span>
      </div>
      <div className="flex flex-col gap-1">
        <div className="flex min-h-11 items-center gap-3">
          <Switch
            id={tasksId}
            aria-describedby={tasksHintId}
            data-slot="webhook-tasks"
            checked={draft.tasks}
            onCheckedChange={(tasks) => onChange({ tasks })}
          />
          <span className="flex min-w-0 flex-col text-[13px]">
            <label htmlFor={tasksId} className="font-medium">Task notifications</label>
            <span id={tasksHintId} className="text-[11px] text-soft-foreground">Tasks you hand off, or start with notify on, send their status here.</span>
          </span>
        </div>
        {draft.tasks ? (
          <fieldset data-slot="webhook-triggers" className="flex flex-col gap-1 sm:ps-[3.25rem]">
            <legend className="pbe-1 text-[11px] text-muted-foreground">Send a delivery when a task enters</legend>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(min(100%,15rem),1fr))] gap-x-3">
              {WEBHOOK_TRIGGERS.map((trigger) => (
                <label key={trigger} className="flex min-h-11 items-start gap-2.5 pbs-2 text-[13px]">
                  <input
                    type="checkbox"
                    data-trigger={trigger}
                    checked={draft.triggers.includes(trigger)}
                    onChange={(event) =>
                      onChange({
                        triggers: event.target.checked
                          ? [...draft.triggers, trigger]
                          : draft.triggers.filter((value) => value !== trigger),
                      })
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
        ) : null}
      </div>
      <div className="flex min-h-11 items-center gap-3">
        <Switch
          id={agentId}
          aria-describedby={agentHintId}
          data-slot="webhook-agent"
          checked={draft.agent}
          onCheckedChange={(agent) => onChange({ agent })}
        />
        <span className="flex min-w-0 flex-col text-[13px]">
          <label htmlFor={agentId} className="font-medium">Let agents send reports</label>
          <span id={agentHintId} className="text-[11px] text-soft-foreground">Agents in this project may post a report here when the task calls for it.</span>
        </span>
      </div>
    </>
  )
}
