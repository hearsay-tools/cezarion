import { randomBytes } from 'node:crypto';
import type {
  AgentWebhook,
  CreateProjectWebhookInput,
  ProjectWebhook,
  ProjectWebhookInput,
  UpdateProjectWebhookInput,
} from '@open-mercato/cezar-contract';
import type { StoredProjectWebhook, WorkspaceProject } from './config.ts';

/**
 * A project's webhooks (hearsay-tools/cezarion#1576), read the same way whether the registry
 * entry holds the `webhooks` list or the single `webhook` key a project stored before it.
 *
 * Upgrade: a `webhook` key with no `webhooks` list reads as one webhook named "Task webhook",
 * task notifications on, closed to agents — exactly what it did before. The first write through
 * `setProjectWebhooks` stores the list and deletes the old key, so the two never disagree.
 */

/** The id and name the pre-#1576 single webhook reads as. */
export const LEGACY_WEBHOOK_ID = 'task-webhook';
export const LEGACY_WEBHOOK_NAME = 'Task webhook';

export function projectWebhooks(entry: WorkspaceProject | undefined): StoredProjectWebhook[] {
  if (!entry) return [];
  if (entry.webhooks) return entry.webhooks;
  const legacy = entry.webhook;
  if (!legacy) return [];
  return [{
    id: LEGACY_WEBHOOK_ID,
    name: LEGACY_WEBHOOK_NAME,
    url: legacy.url,
    ...(legacy.token ? { token: legacy.token } : {}),
    tasks: true,
    ...(legacy.triggers === undefined ? {} : { triggers: legacy.triggers }),
    agent: false,
  }];
}

/** The webhooks that receive task notifications from runs with `notify` on. */
export function taskWebhooks(entry: WorkspaceProject | undefined): StoredProjectWebhook[] {
  return projectWebhooks(entry).filter((webhook) => webhook.tasks);
}

/** Replace the list on a registry entry being written. An empty list removes both keys. */
export function setProjectWebhooks(entry: WorkspaceProject, webhooks: StoredProjectWebhook[]): void {
  delete entry.webhook;
  if (webhooks.length === 0) delete entry.webhooks;
  else entry.webhooks = webhooks;
}

/** A new id, unused in `existing`. */
export function newWebhookId(existing: readonly StoredProjectWebhook[]): string {
  for (;;) {
    const id = randomBytes(4).toString('hex');
    if (!existing.some((webhook) => webhook.id === id)) return id;
  }
}

/** Names are unique per project, ignoring case, so an agent can address a webhook by name. */
export function nameTaken(webhooks: readonly StoredProjectWebhook[], name: string, exceptId?: string): boolean {
  const folded = name.trim().toLocaleLowerCase();
  return webhooks.some((webhook) => webhook.id !== exceptId && webhook.name.toLocaleLowerCase() === folded);
}

/** The webhook an agent names, by id or by name (case-insensitive), when it is exposed to agents.
 *  A webhook closed to agents resolves to nothing, exactly like an unknown one. */
export function agentWebhook(entry: WorkspaceProject | undefined, ref: string): StoredProjectWebhook | undefined {
  const exposed = projectWebhooks(entry).filter((webhook) => webhook.agent);
  const folded = ref.trim().toLocaleLowerCase();
  return exposed.find((webhook) => webhook.id === ref) ?? exposed.find((webhook) => webhook.name.toLocaleLowerCase() === folded);
}

/** What an agent may know about the webhooks exposed to it: never the URL or the token. */
export function agentWebhooks(entry: WorkspaceProject | undefined): AgentWebhook[] {
  return projectWebhooks(entry)
    .filter((webhook) => webhook.agent)
    .map(({ id, name, description }) => ({ id, name, ...(description ? { description } : {}) }));
}

/** One webhook as it leaves the server: the token is swapped for `tokenSet`. */
export function redactWebhook(webhook: StoredProjectWebhook): ProjectWebhook {
  return {
    id: webhook.id,
    name: webhook.name,
    ...(webhook.description ? { description: webhook.description } : {}),
    url: webhook.url,
    tokenSet: Boolean(webhook.token),
    tasks: webhook.tasks,
    ...(webhook.triggers === undefined ? {} : { triggers: webhook.triggers }),
    agent: webhook.agent,
  };
}

/** A webhook built from a create body. An omitted `tasks` or `agent` is off. */
export function createdWebhook(existing: readonly StoredProjectWebhook[], input: CreateProjectWebhookInput): StoredProjectWebhook {
  return {
    id: newWebhookId(existing),
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    url: input.url,
    ...(input.token ? { token: input.token } : {}),
    tasks: input.tasks ?? false,
    ...(input.triggers === undefined ? {} : { triggers: input.triggers }),
    agent: input.agent ?? false,
  };
}

/** Apply an edit body: each key only when named. The token is write-only, so an omitted token
 *  keeps the stored one and `''` clears it; `''` clears the description the same way. */
export function editedWebhook(current: StoredProjectWebhook, input: UpdateProjectWebhookInput): StoredProjectWebhook {
  const next: StoredProjectWebhook = { ...current };
  if (input.name !== undefined) next.name = input.name;
  if (input.description !== undefined) {
    if (input.description) next.description = input.description;
    else delete next.description;
  }
  if (input.url !== undefined) next.url = input.url;
  if (input.token !== undefined) {
    if (input.token) next.token = input.token;
    else delete next.token;
  }
  if (input.tasks !== undefined) next.tasks = input.tasks;
  if (input.triggers !== undefined) next.triggers = input.triggers;
  if (input.agent !== undefined) next.agent = input.agent;
  return next;
}

/**
 * The pre-#1576 `PATCH /projects/:id { webhook }` body, applied to the first webhook with task
 * notifications on: `null` removes it, a value edits it, or adds "Task webhook" when there is
 * none. An omitted `token` or `triggers` keeps the stored value, as it always did.
 */
export function applyTaskWebhookInput(entry: WorkspaceProject, input: ProjectWebhookInput | null): void {
  const webhooks = [...projectWebhooks(entry)];
  const index = webhooks.findIndex((webhook) => webhook.tasks);
  if (input === null) {
    if (index >= 0) webhooks.splice(index, 1);
  } else if (index >= 0) {
    webhooks[index] = editedWebhook(webhooks[index]!, input);
  } else {
    let name = LEGACY_WEBHOOK_NAME;
    for (let n = 2; nameTaken(webhooks, name); n += 1) name = `${LEGACY_WEBHOOK_NAME} ${n}`;
    webhooks.push(createdWebhook(webhooks, { ...input, name, tasks: true }));
  }
  setProjectWebhooks(entry, webhooks);
}
