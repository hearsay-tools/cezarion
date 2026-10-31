import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord, RUN_STATUS, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentInput, ConversationState } from '@open-mercato/cezar-contract';
import {
  WRITE_PATH_RULES, redactText, stageArchiveFields, stageCommit, stageConversation,
  stageDebouncedUpdate, stageDurableUpdate, stageLoaded, stagePullRequests, stageStepUpdate,
} from './record-write-rules.ts';
import type { RunRecord } from './store.ts';

const at = '2026-10-30T12:00:00.000Z';
const url = 'https://github.com/example/project/pull/42';
const issue = 'https://github.com/example/project/issues/7';
const redact = (text: string) => text.replaceAll('secret', '[REDACTED]');
function hooks(log: string[] = []): Parameters<typeof stageDebouncedUpdate>[2] {
  return {
    redact, withdrawHold: vi.fn(), clearPin: vi.fn(), refUrlNumber: (value: string | undefined) => value ? Number(value.split('/').pop()) : undefined,
    restore: () => { log.push('restore'); },
    hasPrUrl: () => true, hasIssueUrl: () => true,
    trackReferencedPrs: () => { log.push('collect-pr'); }, trackReferencedIssues: () => { log.push('collect-issue'); },
    resolveReferencedPr: () => { log.push('resolve-pr'); return url; },
    resolveIssueReference: () => { log.push('resolve-issue'); return issue; },
    rescopeRun: () => { log.push('rescope'); },
    archive: (run: RunRecord, archived: boolean) => { log.push('archive'); stageArchiveFields(run, archived, at, vi.fn(), vi.fn()); },
    touch: () => { log.push('touch'); },
  };
}
function commit(run: RunRecord, previous?: RunRecord, blocker?: string) {
  return stageCommit(new Map([[run.id, run]]), {
    peek: () => previous, completionArchiveBlocker: () => blocker,
    stageArchive: (staged, next, archived) => { stageArchiveFields(next, archived, at, vi.fn(), vi.fn()); staged.set(next.id, next); },
  }).get(run.id)!;
}

afterEach(() => vi.unstubAllEnvs());

describe('record write paths without a database', () => {
  it.each([
    ['commit', ['stale-resume:hold', 'completion-actions']],
    ['durableUpdate', ['issue-seed', 'pull-requests', 'restore', 'redact-patch', 'archive-fields']],
    ['debouncedUpdate', ['issue-seed', 'pull-requests', 'restore', 'redact-patch', 'assign', 'stale-resume:status', 'task-references', 'archive-or-touch']],
    ['loaded', ['stale-resume:status']],
    ['conversation', ['redact-messages', 'parse-delegation', 'redact-input', 'parse-input', 'append-input']],
    ['pullRequests', ['merge-pull-requests']],
    ['archiveFields', ['archive-time', 'store-owned:withdraw-hold', 'store-owned:clear-pin']],
    ['stepUpdate', ['redact-step-error']],
  ] as const)('declares the ordered %s rules', (path, rules) => {
    expect(WRITE_PATH_RULES[path]).toEqual(rules);
  });

  it.each([RUN_STATUS.waiting, RUN_STATUS.running, RUN_STATUS.done])('keeps only waiting appointments on %s', status => {
    const original = makeRunRecord({ status, autoResumeAt: at, autoResumeAttempts: 2 });
    const staged = commit(original);
    expect(staged.autoResumeAt).toBe(status === RUN_STATUS.waiting ? at : undefined);
    expect(staged.autoResumeAttempts).toBe(2);
    expect(original.autoResumeAt).toBe(at);
    stageLoaded(original);
    expect(original.autoResumeAt).toBe(staged.autoResumeAt);
  });

  it('preserves deletions and unchanged records during commit staging', () => {
    const run = makeRunRecord();
    const staged = stageCommit(new Map([[run.id, run], ['deleted', null]]), {
      peek: () => run, completionArchiveBlocker: () => undefined, stageArchive: vi.fn(),
    });
    expect(staged.get(run.id)).toBe(run);
    expect(staged.get('deleted')).toBeNull();
  });

  it.each([
    [true, false, undefined, 'complete', true],
    [true, false, 'attention', 'blocked', false],
    [false, true, undefined, 'pending', false],
  ] as const)('prepares completion archive=%s merge=%s blocker=%s', (archiveWhenDone, autoMergePr, blocker, phase, archived) => {
    const run = makeRunRecord({ status: RUN_STATUS.done, archiveWhenDone, autoMergePr });
    const staged = commit(run, undefined, blocker);
    expect(staged.completionAction).toMatchObject({ phase });
    expect(staged.archived).toBe(archived);
    expect(run.completionAction).toBeUndefined();
  });

  it.each([RUN_STATUS.running, RUN_STATUS.done])('retires unused completion intent on %s', status => {
    const run = makeRunRecord({ status, completionAction: { id: randomUUID(), phase: 'pending' } });
    expect(commit(run).completionAction).toBeUndefined();
  });

  it.each([stageDurableUpdate, stageDebouncedUpdate])('redacts patches and accumulates PRs on %s', stage => {
    const run = makeRunRecord({ referencedIssueNumberSeeded: true });
    const next = stage(run, { title: 'secret', titleSummary: 'secret', error: 'secret', issueNumber: 7, pullRequestUrl: url }, hooks()) ?? run;
    expect(next).toMatchObject({ title: '[REDACTED]', titleSummary: '[REDACTED]', error: '[REDACTED]', issueNumber: 7 });
    expect(next.referencedIssueNumberSeeded).toBeUndefined();
    expect(next.pullRequests).toEqual([{ number: 42, url, source: 'created' }]);
  });

  it.each([stageDurableUpdate, stageDebouncedUpdate])('restores before patch mutation on %s', stage => {
    const run = makeRunRecord({ archived: true });
    const before = { ...run };
    const callbacks = hooks();
    callbacks.restore = () => { throw Error('restore failed'); };
    expect(() => stage(run, { status: RUN_STATUS.done, archived: false }, callbacks)).toThrow('restore failed');
    expect(run).toEqual(before);
  });

  it.each([true, false])('resolves task refs only on the debounced path=%s', debounced => {
    const run = makeRunRecord({ referencedPrCandidates: [url], referencedIssueCandidates: [issue], autoResumeAt: at });
    const log: string[] = [];
    const stage = debounced ? stageDebouncedUpdate : stageDurableUpdate;
    const next = stage(run, { task: 'edited', status: RUN_STATUS.running }, hooks(log)) ?? run;
    expect(log).toEqual(debounced ? ['collect-pr', 'collect-issue', 'resolve-pr', 'resolve-issue', 'rescope', 'touch'] : []);
    expect(next.referencedPullRequestUrl).toBe(debounced ? url : undefined);
    expect(next.issueNumber).toBe(debounced ? 7 : undefined);
    expect(next.autoResumeAt).toBe(debounced ? undefined : at);
  });

  it.each([undefined, issue])('revokes or updates a number seeded by task resolution: %s', resolved => {
    const run = makeRunRecord({ referencedIssueCandidates: [issue], issueNumber: 3, referencedIssueNumberSeeded: true });
    const callbacks = hooks(); callbacks.resolveIssueReference = () => resolved;
    stageDebouncedUpdate(run, { task: 'edited' }, callbacks);
    expect(run.issueNumber).toBe(resolved ? 7 : undefined);
    expect(run.referencedIssueNumberSeeded).toBe(resolved ? true : undefined);
  });

  it.each([true, false])('sets archive fields and retires appointments only on archive=%s', archived => {
    const run = makeRunRecord({ status: RUN_STATUS.waiting, autoResumeAt: at, autoResumeAttempts: 2, pinned: true, pinnedAt: at });
    const withdraw = vi.fn((next: RunRecord) => { expect(next.archivedAt).toBe(at); expect(next.pinned).toBe(true); });
    stageArchiveFields(run, archived, at, withdraw, next => { delete next.pinned; delete next.pinnedAt; });
    expect(withdraw).toHaveBeenCalledTimes(archived ? 1 : 0);
    expect(run.archived).toBe(archived);
    expect(run.archivedAt).toBe(archived ? at : undefined);
    expect(run.status).toBe(RUN_STATUS.waiting);
    expect(run.autoResumeAt).toBe(at);
    expect(run.autoResumeAttempts).toBe(2);
    expect(run.pinned).toBe(archived ? undefined : true);
    expect(run.manualUnarchivedAt).toBe(archived ? undefined : at);
  });

  it.each(['0', '1'])('preserves the patch and text redaction difference with opt-out=%s', setting => {
    vi.stubEnv('CEZ_REDACT_SECRETS', setting);
    const host = vi.fn(() => ['host-secret-value']);
    const text = redactText('session-secret-value host-secret-value', ['session-secret-value'], host);
    expect(text).not.toContain('session-secret-value');
    expect(text.includes('host-secret-value')).toBe(setting === '0');
    const run = makeRunRecord();
    stageDebouncedUpdate(run, { error: 'secret' }, hooks());
    expect(run.error).toBe(setting === '0' ? 'secret' : '[REDACTED]');
    expect(stageStepUpdate({ error: 'secret', name: 'secret' }, redact)).toEqual({ error: setting === '0' ? 'secret' : '[REDACTED]', name: 'secret' });
  });

  it.each([{ initial: [] }, { initial: [{ number: 42, url, source: 'created' as const }] }])('merges PRs without duplicate entries: %j', ({ initial }) => {
    const run = makeRunRecord({ pullRequests: initial });
    stagePullRequests(run, [{ number: 42, url, source: 'created' }]);
    expect(run.pullRequests).toEqual([{ number: 42, url, source: 'created' }]);
    expect(stagePullRequests(run, [{ number: 42, url, source: 'created' }])).toBe(false);
  });

  it.each([true, false])('stages redacted conversation and input with same recipient=%s', same => {
    const root = makeRunRecord({ id: randomUUID(), delegation: { role: 'root', permissions: [], receipts: [] } });
    const recipient = same ? root : makeRunRecord({ id: randomUUID() });
    const state: ConversationState = { messages: [{ id: randomUUID(), senderRunId: root.id, recipientRunId: recipient.id, kind: 'progress', text: 'secret', createdAt: at, requestHash: 'a'.repeat(64), state: 'accepted' }], outcomes: [] };
    const input: AgentInput = { id: randomUUID(), source: WAIT_SOURCE.agent, parentRunId: root.id, text: 'secret', createdAt: at };
    const staged = new Map<string, RunRecord>();
    stageConversation(staged, root, state, { recipientRunId: recipient.id, input }, () => recipient, redact);
    expect(staged.get(root.id)?.delegation).toMatchObject({ conversation: { messages: [{ ...state.messages[0], text: '[REDACTED]' }], outcomes: [] } });
    expect(staged.get(recipient.id)?.agentInputs?.[0]?.text).toBe('[REDACTED]');
    expect(recipient.agentInputs).toBeUndefined();
  });

});
