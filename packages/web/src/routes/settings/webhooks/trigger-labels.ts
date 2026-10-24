import type { WebhookTrigger } from '@open-mercato/cezar-api-client'

/** The cockpit's name for each state and when a run is in it, in `WEBHOOK_TRIGGERS` order. */
export const TRIGGER_LABELS: Record<WebhookTrigger, { label: string; hint: string }> = {
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

export const sameTriggers = (a: readonly WebhookTrigger[], b: readonly WebhookTrigger[]) =>
  a.length === b.length && a.every((trigger) => b.includes(trigger))
