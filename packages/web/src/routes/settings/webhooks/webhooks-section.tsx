import { PlusIcon } from 'lucide-react'
import { useState } from 'react'

import type { ProjectListEntry } from '@open-mercato/cezar-api-client'
import { PROJECT_WEBHOOKS_MAX } from '@open-mercato/cezar-api-client/contract/project-limits'
import { Button } from '@/components/ui/button'
import { SettingsField } from '../settings-field'
import { NewWebhookCard, WebhookCard } from './webhook-card'

/**
 * Project settings → General → Webhooks (hearsay-tools/cezarion#1576). A project keeps several
 * webhooks. Each one may get task notifications, take reports from agents, or both. One card per
 * webhook, each with its own form, so saving one never touches another's unsaved edits.
 */
export function ProjectWebhooksField({ project }: { project: ProjectListEntry }) {
  const webhooks = project.webhooks ?? []
  const [adding, setAdding] = useState(false)
  // The card Create just made opens, so the user sees where their webhook went.
  const [createdId, setCreatedId] = useState<string | null>(null)
  const full = webhooks.length >= PROJECT_WEBHOOKS_MAX

  return (
    <SettingsField
      title="Webhooks"
      hint="A webhook gets a POST from cezar. Tasks can send their status to it, and agents can send it reports."
    >
      <div data-slot="project-webhooks" className="flex flex-col gap-3">
        {webhooks.length === 0 && !adding ? (
          <p data-slot="webhooks-empty" className="text-[13px] text-soft-foreground">
            No webhooks yet. Add one to send task updates to a bot, or to let agents post reports.
          </p>
        ) : null}
        {webhooks.length > 0 || adding ? (
          <ul className="flex flex-col gap-2">
            {webhooks.map((webhook) => (
              <WebhookCard key={webhook.id} projectId={project.id} webhook={webhook} defaultOpen={webhook.id === createdId} />
            ))}
            {adding ? (
              <NewWebhookCard
                projectId={project.id}
                onCancel={() => setAdding(false)}
                onCreated={(webhook) => {
                  setCreatedId(webhook.id)
                  setAdding(false)
                }}
              />
            ) : null}
          </ul>
        ) : null}
        {adding ? null : (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="max-sm:h-11"
              data-action="webhook-add"
              disabled={full}
              onClick={() => setAdding(true)}
            >
              <PlusIcon aria-hidden="true" />
              Add webhook
            </Button>
            {full ? (
              <span className="text-[11px] text-soft-foreground">A project holds at most {PROJECT_WEBHOOKS_MAX} webhooks.</span>
            ) : null}
          </div>
        )}
      </div>
    </SettingsField>
  )
}
