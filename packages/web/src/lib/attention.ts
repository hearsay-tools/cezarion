import {
  ATTENTION_RANK,
  deriveAttention,
  type RunSummary,
} from '@open-mercato/cezar-api-client'

/**
 * The one canonical attention function (spec, "Design system" → status grammar).
 *
 * It lives in the contract (`packages/contract/src/attention.ts`) since #553/#609, so the
 * `cez task` CLI derives "this run wants you" from the same function the cockpit renders with —
 * `wait --until attention`, and the `attention`/`attentionLabel` columns of `status`/`list`, can
 * never disagree with the quick-list dot, the table's dot, the thread header or the browser
 * notification. This module re-exports it unchanged for the cockpit's importers and keeps the
 * one helper that is web-only.
 */
export {
  ATTENTION_RANK,
  delegationWaitLabel,
  deriveAttention,
  type Attention,
  type AttentionBucket,
  type AttentionInput,
  type AttentionShape,
  type AttentionTone,
} from '@open-mercato/cezar-api-client'

/**
 * True when a run is asking for a human: a permission prompt, an error, or a waiting/review gate.
 * This is the predicate Phase R6's notifications gate on — the spec fires them "on
 * `waiting`/`review`/failed via the attention function", which is exactly the top three rungs.
 *
 * It is deliberately *not* the sidebar's "Needs you" bucket, which is narrower (waiting/review
 * only): a failed run is worth a notification, but in the list it belongs under Finished with its
 * outcome rather than in the pile of things you can act on. See `lib/task-groups.ts`.
 */
export function wantsAttention(run: RunSummary): boolean {
  return ATTENTION_RANK[deriveAttention(run).bucket] <= ATTENTION_RANK.waiting
}
