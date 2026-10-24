import type { CreateProjectWebhookInput, ProjectWebhook, UpdateProjectWebhookInput, WebhookTrigger } from '@open-mercato/cezar-api-client'
import { DEFAULT_WEBHOOK_TRIGGERS, WEBHOOK_TRIGGERS } from '@open-mercato/cezar-api-client/contract/attention'

import { sameTriggers } from './trigger-labels'

/** What one webhook form holds. The token is write-only: empty keeps the stored one. */
export interface WebhookDraft {
  name: string
  description: string
  url: string
  token: string
  tasks: boolean
  triggers: readonly WebhookTrigger[]
  agent: boolean
}

export const EMPTY_DRAFT: WebhookDraft = {
  name: '',
  description: '',
  url: '',
  token: '',
  tasks: true,
  triggers: DEFAULT_WEBHOOK_TRIGGERS,
  agent: false,
}

export function draftFrom(webhook: ProjectWebhook): WebhookDraft {
  return {
    name: webhook.name,
    description: webhook.description ?? '',
    url: webhook.url,
    token: '',
    tasks: webhook.tasks,
    triggers: webhook.triggers ?? DEFAULT_WEBHOOK_TRIGGERS,
    agent: webhook.agent,
  }
}

/** In `WEBHOOK_TRIGGERS` order, whatever order the boxes were ticked in. */
const ordered = (triggers: readonly WebhookTrigger[]) => WEBHOOK_TRIGGERS.filter((trigger) => triggers.includes(trigger))

/** The create body. An omitted `triggers` stores the default selection. */
export function createBody(draft: WebhookDraft): CreateProjectWebhookInput {
  const description = draft.description.trim()
  return {
    name: draft.name.trim(),
    url: draft.url.trim(),
    ...(description ? { description } : {}),
    ...(draft.token ? { token: draft.token } : {}),
    tasks: draft.tasks,
    ...(sameTriggers(draft.triggers, DEFAULT_WEBHOOK_TRIGGERS) ? {} : { triggers: ordered(draft.triggers) }),
    agent: draft.agent,
  }
}

/** The edit body: only the keys the form changed. Empty when nothing changed. */
export function updateBody(draft: WebhookDraft, stored: ProjectWebhook): UpdateProjectWebhookInput {
  const body: UpdateProjectWebhookInput = {}
  const name = draft.name.trim()
  const description = draft.description.trim()
  const url = draft.url.trim()
  if (name !== stored.name) body.name = name
  // `''` clears a stored description.
  if (description !== (stored.description ?? '')) body.description = description
  if (url !== stored.url) body.url = url
  if (draft.token) body.token = draft.token
  if (draft.tasks !== stored.tasks) body.tasks = draft.tasks
  if (!sameTriggers(draft.triggers, stored.triggers ?? DEFAULT_WEBHOOK_TRIGGERS)) body.triggers = ordered(draft.triggers)
  if (draft.agent !== stored.agent) body.agent = draft.agent
  return body
}
