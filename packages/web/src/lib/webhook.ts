import type { ProjectListEntry } from '@open-mercato/cezar-api-client'

/** How the cockpit names a task webhook (#589): host and path, never the query string or any
 *  credentials in the URL, which may carry a secret the user would rather not have on screen.
 *  Falls back to the input when it does not parse. */
export function webhookLabel(url: string): string {
  try {
    const parsed = new URL(url)
    const path = parsed.pathname === '/' ? '' : parsed.pathname.replace(/\/$/, '')
    return `${parsed.host}${path}` || url
  } catch {
    return url
  }
}

/** One webhook a task hand-off reaches: its name, and where it points. */
export interface TaskWebhookTarget {
  id: string
  name: string
  url: string
}

/** The project webhooks with task notifications on (hearsay-tools/cezarion#1576): every one of
 *  them gets a task's hand-off. An entry from a server that knows one webhook only carries just
 *  `webhook`, which reads as one unnamed task webhook. */
export function taskWebhooks(project: Pick<ProjectListEntry, 'webhook' | 'webhooks'> | undefined): TaskWebhookTarget[] {
  if (!project) return []
  if (project.webhooks) {
    return project.webhooks.filter((webhook) => webhook.tasks).map(({ id, name, url }) => ({ id, name, url }))
  }
  return project.webhook ? [{ id: 'task-webhook', name: 'Task webhook', url: project.webhook.url }] : []
}

/** "Alerts", "Alerts and Ops", "Alerts, Ops and 2 more" — the names a hand-off reaches. */
export function webhookNames(targets: readonly TaskWebhookTarget[]): string {
  const names = targets.map((target) => target.name)
  if (names.length <= 2) return names.join(' and ')
  if (names.length === 3) return `${names[0]}, ${names[1]} and ${names[2]}`
  return `${names[0]}, ${names[1]} and ${names.length - 2} more`
}
