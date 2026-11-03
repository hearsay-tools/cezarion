import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { makeRunRecord, RUN_STATUS, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { AgentInput, ConversationState } from '@open-mercato/cezar-contract';
import {
  RECORD_WRITE_RULES, WRITE_PATHS, redactText, stageArchiveFields, stageCommit, stageConversation,
  stageDebouncedUpdate, stageDurableUpdate, stageLoaded, stagePullRequests, stageStepUpdate, writePathRules,
} from './record-write-rules.ts';
import type { RunRecord } from './store.ts';

const at = '2026-10-30T12:00:00.000Z';
const url = 'https://github.com/example/project/pull/42';
const issue = 'https://github.com/example/project/issues/7';
const redact = (text: string) => text.replaceAll('secret', '[REDACTED]');
function hooks(log: string[] = []): Parameters<typeof stageDebouncedUpdate>[2] {
  return {
    redact,
    restore: () => { log.push('restore'); },
    archive: (run: RunRecord, archived: boolean) => { log.push('archive'); stageArchiveFields(run, archived, at); },
    touch: () => { log.push('touch'); },
  };
}
function commit(run: RunRecord, previous?: RunRecord, blocker?: string) {
  return stageCommit(new Map([[run.id, run]]), {
    peek: () => previous, completionArchiveBlocker: () => blocker,
    stageArchive: (staged, next, archived) => { stageArchiveFields(next, archived, at); staged.set(next.id, next); },
  }).get(run.id)!;
}

afterEach(() => vi.unstubAllEnvs());

describe('record write paths without a database', () => {
  // Today's order on each path, read from the code before S6 made one list of the rules (Decision
  // 4). It differs from the old per-path declarations where they were stale: the durable save
  // resolves task references since hearsay-tools/cezarion#2377, and writes its staged copy.
  it.each([
    ['commit', ['stale-resume', 'completion-actions']],
    ['durableUpdate', ['issue-seed', 'pull-requests', 'restore', 'redact-patch', 'assign', 'task-references', 'archive-fields']],
    ['debouncedUpdate', ['issue-seed', 'pull-requests', 'restore', 'redact-patch', 'assign', 'retire-completion-action', 'stale-resume', 'task-references', 'archive-or-touch']],
    ['loaded', ['stale-resume']],
    ['conversation', ['redact-messages', 'parse-delegation', 'find-recipient', 'redact-input', 'parse-input', 'append-input']],
    ['pullRequests', ['merge-pull-requests']],
    ['archiveFields', ['archive-time', 'withdraw-hold', 'clear-pin']],
    ['stepUpdate', ['redact-step-error']],
  ] as const)('runs the ordered %s rules', (path, rules) => {
    expect(writePathRules(path)).toEqual(rules);
  });

  it('runs every rule on some path, and names a rule once', () => {
    expect(RECORD_WRITE_RULES.filter(rule => !rule.on.some(path => WRITE_PATHS.includes(path))).map(rule => rule.id)).toEqual([]);
    expect(new Set(RECORD_WRITE_RULES.map(rule => rule.id)).size).toBe(RECORD_WRITE_RULES.length);
  });

  // The class of hearsay-tools/cezarion#2377 to hearsay-tools/cezarion#2382: a rule one save
  // skipped. The durable save is durableUpdate, then its commit.
  it('names the difference of every rule that only one update save runs, or that the saves apply apart', () => {
    const durable = (rule: (typeof RECORD_WRITE_RULES)[number]) => rule.on.includes('durableUpdate') || rule.on.includes('commit');
    const one = RECORD_WRITE_RULES.filter((rule) => {
      return durable(rule) !== rule.on.includes('debouncedUpdate');
    });
    expect(one.map(rule => rule.id)).toEqual(['retire-completion-action', 'completion-actions', 'archive-fields', 'archive-or-touch']);
    expect(RECORD_WRITE_RULES.filter(rule => rule.difference).map(rule => rule.id))
      .toEqual(['assign', 'retire-completion-action', 'stale-resume', 'completion-actions', 'archive-fields', 'archive-or-touch']);
  });

  // One rule on every path (hearsay-tools/cezarion#2322): a resume time stays only on a `waiting`
  // run. A `waiting` run with a time is a usage-limit hold, so no waiting run keeps a time without one.
  const throughLoad = (run: RunRecord) => { stageLoaded(run); return run; };
  const throughDebounced = (run: RunRecord) => { stageDebouncedUpdate(run, {}, hooks()); return run; };
  it.each([
    ['load', throughLoad], ['debounced update', throughDebounced], ['commit', (run: RunRecord) => commit(run)],
  ] as const)('applies the one stale-resume rule on %s', (_path, stage) => {
    const cases = [
      [RUN_STATUS.waiting, at, at],
      [RUN_STATUS.waiting, undefined, undefined],
      [RUN_STATUS.running, at, undefined],
      [RUN_STATUS.done, at, undefined],
    ] as const;
    for (const [status, autoResumeAt, kept] of cases) {
      const staged = stage(makeRunRecord({ status, autoResumeAt, autoResumeAttempts: 2 }));
      expect(staged.autoResumeAt, `${status} with ${autoResumeAt ?? 'no time'}`).toBe(kept);
      expect(staged.autoResumeAttempts).toBe(2);
    }
  });

  it('stages commit on a copy and leaves the held record untouched', () => {
    const original = makeRunRecord({ status: RUN_STATUS.done, autoResumeAt: at });
    expect(commit(original).autoResumeAt).toBeUndefined();
    expect(original.autoResumeAt).toBe(at);
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

  it.each([true, false])('resolves task refs on both paths, debounced=%s (hearsay-tools/cezarion#2323)', debounced => {
    const run = makeRunRecord({ referencedPrCandidates: [url], referencedIssueCandidates: [issue], autoResumeAt: at });
    const before = structuredClone(run);
    const log: string[] = [];
    const stage = debounced ? stageDebouncedUpdate : stageDurableUpdate;
    const next = stage(run, { task: `edited ${url} ${issue}`, status: RUN_STATUS.running }, hooks(log)) ?? run;
    expect(log).toEqual(debounced ? ['touch'] : []);
    expect(next.referencedPullRequestUrl).toBe(url);
    expect(next.referencedIssueUrl).toBe(issue);
    expect(next.issueNumber).toBe(7);
    expect(next.referencedIssueNumberSeeded).toBe(true);
    // The durable path stages a copy: the commit retires the stale resume and replaces the held record.
    expect(next.autoResumeAt).toBe(debounced ? undefined : at);
    if (!debounced) expect(run).toEqual(before);
  });

  it.each([undefined, issue])('revokes or updates a number seeded by task resolution: %s', resolved => {
    // Two candidates: the edited task picks one by its URL, or names neither and resolves none.
    const run = makeRunRecord({ referencedIssueCandidates: [issue, issue.replace(/7$/, '8')], issueNumber: 3, referencedIssueNumberSeeded: true });
    stageDebouncedUpdate(run, { task: resolved ? `edited ${resolved}` : 'edited' }, hooks());
    expect(run.issueNumber).toBe(resolved ? 7 : undefined);
    expect(run.referencedIssueNumberSeeded).toBe(resolved ? true : undefined);
  });

  it.each([true, false])('sets archive fields and retires appointments only on archive=%s', archived => {
    const run = makeRunRecord({ status: RUN_STATUS.waiting, autoResumeAt: at, autoResumeAttempts: 2, pinned: true, pinnedAt: at });
    stageArchiveFields(run, archived, at);
    expect(run.archived).toBe(archived);
    expect(run.archivedAt).toBe(archived ? at : undefined);
    // Archiving withdraws the usage-limit hold: the run settles failed, its appointment gone.
    expect(run.status).toBe(archived ? RUN_STATUS.failed : RUN_STATUS.waiting);
    expect(run.autoResumeAt).toBe(archived ? undefined : at);
    expect(run.autoResumeAttempts).toBe(archived ? undefined : 2);
    expect(run.pinned).toBe(archived ? undefined : true);
    expect(run.manualUnarchivedAt).toBe(archived ? undefined : at);
  });

  // hearsay-tools/cezarion#2325: the redact hook owns the opt-out, so patches always reach it.
  it.each(['0', '1'])('leaves the opt-out to the redact hook on text and patch paths with opt-out=%s', setting => {
    vi.stubEnv('CEZ_REDACT_SECRETS', setting);
    const host = vi.fn(() => ['host-secret-value']);
    const text = redactText('session-secret-value host-secret-value', ['session-secret-value'], host);
    expect(text).not.toContain('session-secret-value');
    expect(text.includes('host-secret-value')).toBe(setting === '0');
    const run = makeRunRecord();
    stageDebouncedUpdate(run, { error: 'secret' }, hooks());
    expect(run.error).toBe('[REDACTED]');
    expect(stageStepUpdate({ error: 'secret', name: 'secret' }, redact)).toEqual({ error: '[REDACTED]', name: 'secret' });
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
