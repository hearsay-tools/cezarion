import { z } from 'zod';
import type { CiPrIdentity } from '@open-mercato/cezar-contract/ci-wait';

const cleanReason = z.string().transform(value => value
  .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  .replace(/[\x00-\x1f\x7f-\x9f]/g, '').slice(0, 256));
const createdAt = z.iso.datetime({ offset: true });
const eventSchema = z.discriminatedUnion('__typename', [
  z.object({ __typename: z.literal('RemovedFromMergeQueueEvent'), createdAt, reason: cleanReason.nullable() }),
  z.object({ __typename: z.literal('AutoMergeDisabledEvent'), createdAt, reason: cleanReason.nullable(), reasonCode: cleanReason.nullable() }),
  z.object({ __typename: z.enum(['AddedToMergeQueueEvent', 'AutoMergeEnabledEvent']), createdAt }),
]);
const progressSchema = z.object({
  state: z.enum(['OPEN', 'CLOSED', 'MERGED']),
  isInMergeQueue: z.boolean(),
  autoMergeRequest: z.object({ enabledAt: createdAt.nullable() }).nullable(),
  timelineItems: z.object({ nodes: z.array(eventSchema).max(1) }),
});
export const mergeProgressResponseSchema = z.object({
  errors: z.never().optional(),
  data: z.object({ repository: z.object({ pullRequest: progressSchema.passthrough() }) }),
});

export function mergeProgressArgs(pr: CiPrIdentity): string[] {
  const url = new URL(pr.prUrl);
  const [, owner, repo] = url.pathname.split('/');
  return ['api', 'graphql', '--hostname', 'github.com', '-f', `owner=${owner}`, '-f', `repo=${repo}`, '-F', `number=${pr.prNumber}`, '-f', `query=
    query($owner: String!, $repo: String!, $number: Int!) {
      repository(owner: $owner, name: $repo) { pullRequest(number: $number) {
        url number headRefOid state mergeable mergeStateStatus mergedAt mergeCommit { oid }
        isInMergeQueue autoMergeRequest { enabledAt }
        timelineItems(last: 1, itemTypes: [ADDED_TO_MERGE_QUEUE_EVENT, REMOVED_FROM_MERGE_QUEUE_EVENT, AUTO_MERGE_ENABLED_EVENT, AUTO_MERGE_DISABLED_EVENT]) {
          nodes { __typename
            ... on AddedToMergeQueueEvent { createdAt }
            ... on RemovedFromMergeQueueEvent { createdAt reason }
            ... on AutoMergeEnabledEvent { createdAt }
            ... on AutoMergeDisabledEvent { createdAt reason reasonCode }
          }
        }
      } }
    }`];
}

export function mergeRequestObservation(value: z.infer<typeof progressSchema>) {
  const latest = value.timelineItems.nodes[0];
  const event = latest?.__typename === 'RemovedFromMergeQueueEvent'
    ? { kind: 'queue_removal' as const, createdAt: latest.createdAt, ...(latest.reason === null ? {} : { reason: latest.reason }) }
    : latest?.__typename === 'AutoMergeDisabledEvent'
      ? { kind: 'auto_merge_disabled' as const, createdAt: latest.createdAt,
        ...(latest.reason === null ? {} : { reason: latest.reason }), ...(latest.reasonCode === null ? {} : { reasonCode: latest.reasonCode }) }
      : undefined;
  return { isInMergeQueue: value.isInMergeQueue, autoMergeEnabled: value.autoMergeRequest !== null, ...(event ? { event } : {}) };
}

export type GithubMergeRequest = ReturnType<typeof mergeRequestObservation>;
