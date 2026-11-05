import { expect, it } from 'vitest';
import { GithubCiClient } from './github.ts';

const pr = { prUrl: 'https://github.com/org/repo/pull/12', repository: 'org/repo', prNumber: 12, headSha: 'a'.repeat(40) };
const snapshot = { url: pr.prUrl, number: 12, headRefOid: pr.headSha, state: 'OPEN', mergeable: 'MERGEABLE',
  mergeStateStatus: 'CLEAN', mergedAt: null, mergeCommit: null, isInMergeQueue: false, autoMergeRequest: null,
  timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-04T06:33:39Z', reason: 'failed_checks' }] } };
function client(patch: Record<string, unknown> = {}, envelope?: unknown) {
  const body = envelope ?? { data: { repository: { pullRequest: { ...snapshot, ...patch } } } };
  return new GithubCiClient({ command: { file: process.execPath, args: ['-e', `process.stdout.write(${JSON.stringify(JSON.stringify(body))})`] } });
}

it('reads pending merge state and the latest rejection in one bounded structured query', async () => {
  expect(await client().mergeProgress(pr, new AbortController().signal)).toMatchObject({
    state: 'OPEN', headSha: pr.headSha, mergeRequest: { isInMergeQueue: false, autoMergeEnabled: false,
      event: { kind: 'queue_removal', reason: 'failed_checks', createdAt: '2026-11-04T06:33:39Z' } },
  });
});

it.each([
  { isInMergeQueue: true },
  { autoMergeRequest: { enabledAt: '2026-11-04T07:00:00Z' } },
  { autoMergeRequest: { enabledAt: null } },
])('retains current pending state despite an older removal: %j', async patch => {
  const result = await client(patch).mergeProgress(pr, new AbortController().signal);
  expect(result.mergeRequest).toMatchObject({ isInMergeQueue: patch.isInMergeQueue === true, autoMergeEnabled: !!patch.autoMergeRequest });
});

it('reports disabled auto-merge without treating its external reason as instructions', async () => {
  const event = { __typename: 'AutoMergeDisabledEvent', createdAt: '2026-11-04T06:33:39Z', reason: '\u001b[31mDisabled\u001b[0m\u0000', reasonCode: 'x'.repeat(500) };
  const result = await client({ timelineItems: { nodes: [event] } }).mergeProgress(pr, new AbortController().signal);
  expect(result.mergeRequest.event).toEqual({ kind: 'auto_merge_disabled', createdAt: event.createdAt, reason: 'Disabled', reasonCode: 'x'.repeat(256) });
});

it.each([
  { timelineItems: { nodes: [] } },
  { timelineItems: { nodes: [{ __typename: 'AddedToMergeQueueEvent', createdAt: '2026-11-04T07:00:00Z' }] } },
  { timelineItems: { nodes: [{ __typename: 'AutoMergeEnabledEvent', createdAt: '2026-11-04T07:00:00Z' }] } },
])('does not invent rejection evidence: %j', async patch => {
  expect((await client(patch).mergeProgress(pr, new AbortController().signal)).mergeRequest.event).toBeUndefined();
});

it.each([
  { isInMergeQueue: null }, { autoMergeRequest: undefined }, { state: 'FUTURE' },
  { timelineItems: { nodes: [null] } }, { url: 'https://github.com/foreign/repo/pull/12' },
  { timelineItems: { nodes: [{ __typename: 'RemovedFromMergeQueueEvent', createdAt: 'yesterday', reason: 'failed_checks' }] } },
])('rejects malformed or inconsistent progress instead of inferring blocked: %j', async patch => {
  await expect(client(patch).mergeProgress(pr, new AbortController().signal)).rejects.toMatchObject({ code: 'malformed_data' });
});

it('rejects partial GraphQL data carrying errors', async () => {
  await expect(client({}, { data: { repository: { pullRequest: snapshot } }, errors: [{ message: 'unavailable' }] })
    .mergeProgress(pr, new AbortController().signal)).rejects.toMatchObject({ code: 'malformed_data' });
});

it('uses the validated PR identity and requests only the latest lifecycle event', async () => {
  const body = { data: { repository: { pullRequest: snapshot } } };
  const source = `const a=process.argv.slice(1); if(a[0]!=='api'||a[1]!=='graphql'||!a.includes('owner=org')||!a.includes('repo=repo')||!a.includes('number=12')||!a.some(x=>x.includes('timelineItems(last: 1')))process.exit(2); process.stdout.write(${JSON.stringify(JSON.stringify(body))});`;
  const github = new GithubCiClient({ command: { file: process.execPath, args: ['-e', source] } });
  expect((await github.mergeProgress(pr, new AbortController().signal)).state).toBe('OPEN');
});

it('supports dry-run progress without a network request', async () => {
  const github = new GithubCiClient({ env: { ...process.env, CEZ_DRY_RUN: '1' } });
  expect(await github.mergeProgress(pr, new AbortController().signal)).toMatchObject({ state: 'MERGED' });
});

it('accepts a queue removal without an optional reason', async () => {
  const event = { __typename: 'RemovedFromMergeQueueEvent', createdAt: '2026-11-04T06:33:39Z', reason: null };
  const result = await client({ timelineItems: { nodes: [event] } }).mergeProgress(pr, new AbortController().signal);
  expect(result.mergeRequest.event).toEqual({ kind: 'queue_removal', createdAt: event.createdAt });
});
