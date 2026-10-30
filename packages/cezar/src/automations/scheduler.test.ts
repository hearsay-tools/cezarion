import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationLogRecordSchema as contractLogRecordSchema } from '@open-mercato/cezar-contract/automations';
import { AutomationCoordinator } from './coordinator.ts';
import { AutomationStore } from './store.ts';
import { AutomationCandidateChangedError, GithubPoller, type GithubCandidate, type GithubPollOptions, type GithubPollResult } from './github-poller.ts';
import type { GithubAutomationDefinition, ScheduleAutomationDefinition } from './types.ts';
import * as scheduleRunner from './schedule-runner.ts';
import { type ProjectAutomationHandle, LeaseHeldError, ProjectAutomationScheduler, WORKSPACE_TIMER_CAP_MS, WorkspaceAutomationScheduler } from './scheduler.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));
async function setup() {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-scheduler-')); dirs.push(dir);
  const store = AutomationStore.open(dir);
  const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'one') as GithubAutomationDefinition;
  return { store, definition };
}
const candidate = { eventId: 'event', event: 'issue.opened' as const, timestamp: '2026-07-26T02:00:00.000Z', tieBreaker: 'I', repo: 'acme/demo', nodeId: 'I', number: 7, title: 'Issue', url: 'https://github.com/acme/demo/issues/7', author: 'alice', assignees: [], labels: [] };

describe('ProjectAutomationScheduler', () => {
  it.each([false, true])('rechecks current labels before reserving a task (matches=%s)', async matches => {
    const { store, definition } = await setup();
    const rule = { ...definition, filters: { ...definition.filters, requireCurrentLabels: true } };
    const launch = vi.fn(async () => ({ runId: 'current-labels' }));
    const matchesCurrentLabels = vi.fn(async () => matches);
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: { owner: 'acme', repo: 'demo', poller: {
        poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }), matchesCurrentLabels,
      } as never }, launch });
    await scheduler.check(rule);
    expect(matchesCurrentLabels).toHaveBeenCalledWith(candidate, rule);
    expect(launch).toHaveBeenCalledTimes(matches ? 1 : 0);
    expect([...store.latestReceipts().values()]).toHaveLength(matches ? 1 : 0);
    expect(store.logs({ automationId: rule.id })).toContainEqual(expect.objectContaining(matches
      ? { result: 'launched', runId: 'current-labels', githubNumber: 7 }
      : { result: 'skipped', reason: 'Automation item is closed or no longer matches current labels; no receipt or task was created.', githubNumber: 7 }));
  });

  it('releases a changed candidate receipt and records its refusal', async () => {
    const { store, definition } = await setup();
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never },
      launch: async () => { throw new AutomationCandidateChangedError(); },
    });
    await scheduler.check(definition);
    expect([...store.latestReceipts().values()]).toEqual([
      expect.objectContaining({ status: 'released', error: 'Automation item is closed or no longer matches current labels; no task was created.', eventId: candidate.eventId }),
    ]);
    expect(store.logs({ automationId: definition.id })).toContainEqual(expect.objectContaining({
      result: 'skipped', reason: 'Automation item is closed or no longer matches current labels; no task was created.', githubNumber: 7, receiptId: expect.any(String),
    }));
    expect(store.state(definition.id)?.consecutiveFailures).toBe(0);
  });

  it('records an existing task as skipped while retaining its receipt', async () => {
    const { store, definition } = await setup();
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never },
      launch: async () => ({ runId: 'existing-run', existing: true }),
    });
    await scheduler.check(definition);
    expect([...store.latestReceipts().values()]).toEqual([expect.objectContaining({ status: 'launched', runId: 'existing-run' })]);
    expect(store.logs({ automationId: definition.id })).toContainEqual(expect.objectContaining({
      result: 'skipped', reason: 'Issue already has non-archived task existing-run.', runId: 'existing-run',
      githubNumber: 7, githubTitle: candidate.title, githubUrl: candidate.url, event: candidate.event,
    }));
  });

  it.each(['preview', 'execute'] as const)('refuses a backed-off automation before polling in %s mode', async mode => {
    const { store, definition } = await setup();
    const now = Date.parse('2026-07-26T05:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const backoffUntil = new Date(now + 60_000).toISOString();
    store.setState(definition.id, () => ({ backoffUntil }));
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const launch = vi.fn(async () => ({ runId: 'unexpected' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch });
    try {
      await expect(scheduler.check(definition, mode)).rejects.toThrow(`automation is backed off until ${backoffUntil}`);
      expect(poll).not.toHaveBeenCalled();
      expect(launch).not.toHaveBeenCalled();
      expect(store.receipts()).toEqual([]);
      expect(store.logs({ automationId: definition.id })).toEqual([
        expect.objectContaining({ result: 'error', reason: `automation is backed off until ${backoffUntil}` }),
      ]);
    } finally { clock.mockRestore(); }
  });

  it.each([0, -1])('polls when backoff expired %s milliseconds ago', async elapsed => {
    const { store, definition } = await setup();
    const now = Date.parse('2026-07-26T05:00:00.000Z');
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    store.setState(definition.id, () => ({ backoffUntil: new Date(now + elapsed).toISOString() }));
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch: async () => ({ runId: 'unused' }) });
    try {
      await scheduler.check(definition);
      expect(poll).toHaveBeenCalledTimes(1);
      expect(store.state(definition.id)?.backoffUntil).toBeUndefined();
    } finally { clock.mockRestore(); }
  });

  it.each([false, true])('applies includeExisting=%s to an event exactly at the baseline', async includeExisting => {
    const { store, definition } = await setup();
    const rule = { ...definition, filters: { ...definition.filters, includeExisting } };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(candidate.timestamp));
    store.setState(rule.id, () => ({ baselineAt: candidate.timestamp }));
    const accepted: boolean[] = [];
    const poll = vi.fn(async (_owner: string, _repo: string, _rule: GithubAutomationDefinition, options: { accept: (row: typeof candidate) => boolean }) => {
      accepted.push(options.accept(candidate));
      // Return the event independently too: check must also enforce the baseline on results.
      return { candidates: [candidate], truncated: false, pages: 1 };
    });
    const launch = vi.fn(async () => ({ runId: 'at-baseline' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch });
    try {
      expect((await scheduler.check(rule)).candidates).toEqual(includeExisting ? [candidate] : []);
      expect(accepted).toEqual([includeExisting]);
      expect(launch).toHaveBeenCalledTimes(includeExisting ? 1 : 0);
      expect(store.receipts()).toHaveLength(includeExisting ? 2 : 0);
    } finally { clock.mockRestore(); }
  });

  it.each([false, true])('previews the selected window independently of the execution cursor (includeExisting=%s)', async (includeExisting) => {
    const { store, definition } = await setup();
    const rule = { ...definition, filters: { ...definition.filters, includeExisting } };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-26T05:00:00.000Z'));
    store.setState(rule.id, () => ({ baselineAt: '2026-07-26T01:00:00.000Z', cursor: { timestamp: '2026-07-26T04:00:00.000Z' } }));
    const before = store.state(rule.id);
    const poll = vi.fn(async () => ({ candidates: [candidate], truncated: false, pages: 1 }));
    const launch = vi.fn(async () => ({ runId: 'unexpected' }));
    try {
      const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch });
      expect((await scheduler.check(rule, 'preview')).candidates.map((row) => row.number)).toEqual([7]);
      expect(poll).toHaveBeenCalledWith('acme', 'demo', rule, {
        since: includeExisting ? '2026-07-19T05:00:00.000Z' : '2026-07-26T00:58:00.000Z',
        accept: expect.any(Function),
      });
      expect(store.state(rule.id)).toEqual(before);
      expect(store.receipts()).toEqual([]);
      expect(launch).not.toHaveBeenCalled();
    } finally { clock.mockRestore(); }
  });

  it('previews existing matches before activation only when history is included', async () => {
    const { store, definition } = await setup();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-26T05:00:00.000Z'));
    store.setState(definition.id, () => ({ baselineAt: '2026-07-26T03:00:00.000Z' }));
    const poller = { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never;
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller } });
    try {
      expect((await scheduler.check(definition, 'preview')).candidates).toEqual([]);
      expect((await scheduler.check({ ...definition, filters: { ...definition.filters, includeExisting: true } }, 'preview')).candidates.map((row) => row.number)).toEqual([7]);
    } finally { clock.mockRestore(); }
  });

  it('never launches history outside the current lookback even when a stored cursor is older', async () => {
    const { store, definition } = await setup();
    const rule = { ...definition, filters: { ...definition.filters, includeExisting: true, lookbackDays: 1 } };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-28T02:00:00.000Z'));
    store.setState(rule.id, () => ({ baselineAt: '2026-07-20T00:00:00.000Z', cursor: { timestamp: '2026-07-20T00:00:00.000Z' } }));
    const launch = vi.fn(async () => ({ runId: 'unexpected' }));
    const poll = vi.fn(async () => ({ candidates: [candidate], truncated: false, pages: 1 }));
    try {
      const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch });
      expect((await scheduler.check(rule)).candidates).toEqual([]);
      expect(launch).not.toHaveBeenCalled();
      expect(store.receipts()).toEqual([]);
    } finally { clock.mockRestore(); }
  });

  it('does not launch an obsolete window or overwrite a history-policy change during polling', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'unexpected' }));
    const newerState = { baselineAt: '2026-07-27T00:00:00.000Z', cursor: { timestamp: '2026-07-27T00:00:00.000Z' } };
    const poll = async () => {
      // Another cockpit edits the policy while the provider request is in flight.
      const other = AutomationStore.open(store.dataDir);
      other.update(definition.id, definition.revision, { ...definition, filters: { ...definition.filters, includeExisting: true } }, () => newerState);
      return { candidates: [candidate], truncated: false, pages: 1 };
    };
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch });
    await scheduler.check(definition);
    expect(launch).not.toHaveBeenCalled();
    expect(AutomationStore.open(store.dataDir).state(definition.id)).toMatchObject({ revision: 2, ...newerState });
    expect(store.receipts()).toEqual([]);
  });

  it('does not launch while a state-first policy edit has armed a newer revision', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'unexpected' }));
    const poll = async () => {
      // update writes runtime before its definition: simulate that observable interval.
      const other = AutomationStore.open(store.dataDir);
      other.setState(definition.id, () => ({ revision: 2, baselineAt: '2026-07-27T00:00:00.000Z' }));
      return { candidates: [candidate], truncated: false, pages: 1 };
    };
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch });
    await scheduler.check(definition);
    expect(launch).not.toHaveBeenCalled();
    expect(AutomationStore.open(store.dataDir).state(definition.id)?.revision).toBe(2);
  });

  it('preserves a policy edit that lands between validation and the state write', async () => {
    const { store, definition } = await setup();
    const setState = store.setState.bind(store);
    const newerState = { baselineAt: '2026-07-27T00:00:00.000Z', cursor: { timestamp: '2026-07-27T00:00:00.000Z' } };
    vi.spyOn(store, 'setState').mockImplementationOnce((id, update) => {
      const other = AutomationStore.open(store.dataDir);
      other.update(definition.id, definition.revision, { ...definition, filters: { ...definition.filters, includeExisting: true } }, () => newerState);
      return setState(id, update);
    });
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }, launch: async () => ({ runId: 'unused' }) });
    await scheduler.check(definition);
    expect(AutomationStore.open(store.dataDir).state(definition.id)).toMatchObject({ revision: 2, ...newerState });
  });

  it('recovers an interrupted state-first edit before starting the next poll', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, () => ({ revision: 2, baselineAt: '2026-07-20T00:00:00.000Z' }));
    const launch = vi.fn(async () => ({ runId: 'unexpected' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never }, launch });
    await scheduler.check(definition);
    expect(launch).not.toHaveBeenCalled();
    expect(store.state(definition.id)?.revision).toBe(definition.revision);
    expect(Date.parse(store.state(definition.id)!.baselineAt!)).toBeGreaterThan(Date.parse(candidate.timestamp));
  });

  it.each([[1, 30], [25, 30], [25, 130]])('drains dense historical pages across checks and restart with maxRecords=%s (items=%s)', async (maxRecords, count) => {
    const { store, definition } = await setup();
    const rule = store.update(definition.id, definition.revision, { ...definition, filters: { ...definition.filters, includeExisting: true, maxRecords } }) as GithubAutomationDefinition;
    const now = Date.now();
    const timestamp = new Date(now - 60_000).toISOString();
    const items = Array.from({ length: count }, (_, index) => ({ node_id: `I_${index}`, number: index + 1, title: 'Issue', html_url: `https://github.com/acme/demo/issues/${index + 1}`, created_at: timestamp, user: { login: 'alice' }, labels: [], assignees: [], repository_url: 'https://api.github.com/repos/acme/demo' }));
    const poller = new GithubPoller({ run: async (_executable, args) => {
      const perPage = Number(args.find((arg) => arg.startsWith('per_page='))?.split('=')[1]);
      const page = Number(args.find((arg) => arg.startsWith('page='))?.split('=')[1] ?? 1);
      return JSON.stringify({ items: items.slice((page - 1) * perPage, page * perPage) });
    } });
    const launched: number[] = [];
    for (let index = 0; index < Math.ceil(items.length / maxRecords) + 2; index++) {
      const reopened = AutomationStore.open(store.dataDir);
      const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store: reopened, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller }, launch: async (_rule, row) => { launched.push(row.number); return { runId: `run-${row.number}` }; } });
      await scheduler.check(rule);
    }
    expect(launched).toHaveLength(count);
    expect(new Set(launched).size).toBe(count);
  });

  it('eventually discovers an old label transition when a newer comment moves its issue during history drain', async () => {
    const { store, definition } = await setup();
    const rule = store.update(definition.id, definition.revision, { ...definition, events: ['issue.labeled'], filters: { ...definition.filters, includeExisting: true, maxRecords: 1, changedLabels: ['bug'] } }) as GithubAutomationDefinition;
    const now = Date.now();
    const iso = (days: number) => new Date(now - days * 86_400_000).toISOString();
    const items = [1, 2].map((number) => ({ node_id: `I_${number}`, number, title: 'Issue', html_url: `https://github.com/acme/demo/issues/${number}`, created_at: iso(5), updated_at: iso(number === 1 ? 2 : 1), user: { login: 'alice' }, labels: [{ name: 'bug' }], assignees: [], repository_url: 'https://api.github.com/repos/acme/demo' }));
    const poller = new GithubPoller({ run: async (_executable, args) => {
      if (args.some((arg) => arg.includes('/timeline'))) {
        const number = args.some((arg) => arg.includes('/issues/1/')) ? 1 : 2;
        return JSON.stringify([{ id: number, event: 'labeled', label: { name: 'bug' }, created_at: iso(number === 1 ? 2 : 3) }]);
      }
      const query = args.find((arg) => arg.startsWith('q='))!;
      const since = query.match(/updated:>=([^ ]+)/)?.[1];
      const until = query.match(/updated:<=([^ ]+)/)?.[1];
      return JSON.stringify({ items: items.filter((item) => (!since || item.updated_at >= since) && (!until || item.updated_at <= until)).sort((a, b) => a.updated_at.localeCompare(b.updated_at)) });
    } });
    const launched: number[] = [];
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller }, launch: async (_rule, row) => { launched.push(row.number); return { runId: `run-${row.number}` }; } });
    await scheduler.check(rule);
    items[1]!.updated_at = new Date(now + 60_000).toISOString();
    for (let index = 0; index < 5; index++) await scheduler.check(rule);
    expect(launched).toEqual([1, 2]);
  });

  it('previews without cursor, receipt, or launch mutation', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'run' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never }, launch });
    await scheduler.check(definition, 'preview');
    expect(store.state(definition.id)).toBeUndefined();
    expect(store.receipts()).toEqual([]);
    expect(launch).not.toHaveBeenCalled();
    expect(store.logs({ automationId: definition.id })[0]).toMatchObject({
      result: 'preview',
      reason: 'Bounded preview found 1 filter match; no tasks were launched. Counts can include closed items and previously processed events.',
    });
  });

  it('reserves before launch and deduplicates the overlap window', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'run' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never }, launch });
    await scheduler.check(definition);
    await scheduler.check(definition);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.latestReceipts().get('one:event')).toMatchObject({ status: 'launched', runId: 'run' });
  });

  it.each([false, true])('launches once for paired issue events across checks and restart (split=%s)', async (split) => {
    const { store, definition } = await setup();
    const rule = store.update(definition.id, definition.revision, {
      ...definition, events: ['issue.opened', 'issue.labeled'],
      filters: { ...definition.filters, includeExisting: true, changedLabels: ['bug'] },
    }) as GithubAutomationDefinition;
    const timestamp = new Date(Date.now() - 60_000).toISOString();
    const opened = { ...candidate, timestamp };
    const labeled = { ...opened, event: 'issue.labeled' as const, eventId: 'label-event', changedLabel: 'bug' };
    const launch = vi.fn(async () => ({ runId: 'only-run' }));
    const check = async (rows: Array<typeof opened | typeof labeled>) => {
      const reopened = AutomationStore.open(store.dataDir);
      await new ProjectAutomationScheduler({ projectId: 'p', store: reopened, timeZone: 'UTC',
        github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: rows, truncated: false, pages: 1 }) } as never }, launch,
      }).check(rule);
    };
    await check(split ? [opened] : [opened, labeled]);
    await check([labeled]);
    expect(launch).toHaveBeenCalledTimes(1);
  });

  it('does not advance the cursor on failure and applies bounded backoff', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({ ...current, cursor: { timestamp: '2026-07-26T01:00:00.000Z' } }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => { throw new Error('rate limited'); } } as never }, launch: async () => ({ runId: 'unused' }) });
    await expect(scheduler.check(definition)).rejects.toThrow('rate limited');
    expect(store.state(definition.id)?.cursor?.timestamp).toBe('2026-07-26T01:00:00.000Z');
    expect(store.state(definition.id)).toMatchObject({ consecutiveFailures: 1, backoffUntil: expect.any(String) });
  });

  it('launches nothing and counts no failure while the project\'s run store cannot open (#779)', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => { throw new Error('runs.db is damaged'); });
    const ready = vi.fn(async () => { throw new scheduleRunner.AutomationProjectUnavailableError('runs.db is damaged'); });
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }) } as never }, launch, ready });
    await expect(scheduler.check(definition)).rejects.toBeInstanceOf(scheduleRunner.AutomationProjectUnavailableError);
    expect(launch).not.toHaveBeenCalled();
    expect(store.receipts()).toEqual([]);
    // No failure, no backoff, no cursor: the next check finds the same candidate and launches it.
    expect(store.state(definition.id)).toBeUndefined();
    expect(store.logs({ automationId: definition.id })).toEqual([]);
  });

  it('records a held lease as skipped without writing polling state', async () => {
    const { store, definition } = await setup();
    const held = store.acquireLease();
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch: async () => ({ runId: 'unused' }) });
    try {
      const error = await scheduler.check(definition).catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(LeaseHeldError);
      expect((error as Error).message).toContain('lease is held by another process');
      expect(poll).not.toHaveBeenCalled();
      expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'skipped', reason: 'automation polling lease is held by another process' });
      expect(contractLogRecordSchema.safeParse(store.logs({ automationId: definition.id })[0]).success).toBe(true);
      expect(store.state(definition.id)).toBeUndefined();
    } finally { held?.release(); }
  });

  it('does not overwrite the lease owner\'s persisted state from a stale store', async () => {
    const { store: owner, definition } = await setup();
    const other = owner.create({ name: 'Other', enabled: true, events: ['issue.opened'], intervalSeconds: 300, filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Other' } }, 'two');
    const contender = AutomationStore.open(owner.dataDir);
    const held = owner.acquireLease();
    await owner.appendLog({ automationId: definition.id, revision: definition.revision, result: 'no-match' });
    owner.setState(definition.id, (current) => ({ ...current, baselineAt: '2026-09-14T06:00:00.000Z', cursor: { timestamp: '2026-09-14T06:01:00.000Z' }, consecutiveFailures: 3, backoffUntil: '2026-09-14T07:00:00.000Z' }));
    owner.setState(other.id, (current) => ({ ...current, baselineAt: '2026-09-14T06:02:00.000Z' }));
    const path = join(owner.dataDir, 'automation-state.json');
    const before = await readFile(path, 'utf8');
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store: contender, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }, launch: async () => ({ runId: 'unused' }) });
    try {
      await expect(scheduler.check(definition)).rejects.toBeInstanceOf(LeaseHeldError);
      expect(await readFile(path, 'utf8')).toBe(before);
      expect(contender.logs({ automationId: definition.id })[0]?.result).toBe('skipped');
      const newest = contender.logs({ automationId: definition.id, limit: 1 })[0]!;
      expect(newest.seq).toBe(2);
      expect(contender.logs({ automationId: definition.id, cursor: newest.seq, limit: 1 })[0]?.result).toBe('no-match');
    } finally { held?.release(); }
  });

  it('records a preview blocked by a held lease without changing state', async () => {
    const { store, definition } = await setup();
    const held = store.acquireLease();
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }, launch: async () => ({ runId: 'unused' }) });
    try {
      await expect(scheduler.check(definition, 'preview')).rejects.toThrow('lease is held by another process');
      expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'skipped' });
      expect(store.state(definition.id)).toBeUndefined();
    } finally { held?.release(); }
  });

  it('releases the polling lease when completion logging times out', async () => {
    const { store, definition } = await setup();
    await writeFile(join(store.dataDir, 'automation-log.lock'), JSON.stringify({ pid: process.pid }));
    const realNow = Date.now;
    let advanced = realNow();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => (advanced += 2_000));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never }, launch: async () => ({ runId: 'unused' }) });
    try {
      await expect(scheduler.check(definition)).rejects.toThrow('automation log lock is busy');
      const next = store.acquireLease();
      expect(next).toBeDefined();
      next?.release();
    } finally {
      clock.mockRestore();
    }
  });

  it('starts provider discovery from the durable cursor overlap', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({
      ...current,
      cursor: { timestamp: '2026-07-26T01:00:00.000Z' },
    }));
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      store,
      timeZone: 'UTC',
      github: { owner: 'acme', repo: 'demo', poller: { poll } as never },
      launch: async () => ({ runId: 'unused' }),
    });
    await scheduler.check(definition);
    expect(poll).toHaveBeenCalledWith('acme', 'demo', definition, {
      since: '2026-07-26T00:58:00.000Z',
      accept: expect.any(Function),
    });
  });

  it('advances through scanned non-matches without moving a cursor backwards', async () => {
    const { store, definition } = await setup();
    store.setState(definition.id, (current) => ({
      ...current,
      cursor: { timestamp: '2026-07-26T01:00:00.000Z', tieBreaker: 'current' },
    }));
    const scheduler = new ProjectAutomationScheduler({
      projectId: 'p',
      store,
      timeZone: 'UTC',
      github: {
        owner: 'acme',
        repo: 'demo',
        poller: {
          poll: async () => ({
            candidates: [],
            truncated: false,
            pages: 1,
            cursor: { timestamp: '2026-07-26T02:00:00.000Z', tieBreaker: 'scanned' },
          }),
        } as never,
      },
      launch: async () => ({ runId: 'unused' }),
    });
    await scheduler.check(definition);
    expect(store.state(definition.id)?.cursor).toEqual({
      timestamp: '2026-07-26T02:00:00.000Z',
      tieBreaker: 'scanned',
    });
  });
});

describe('WorkspaceAutomationScheduler', () => {
  it('arms its first timer when a definition is enabled after startup', async () => {
    const { store, definition } = await setup();
    store.update(definition.id, definition.revision, { ...definition, enabled: false });
    const coordinator = {
      refresh: vi.fn(async () => undefined),
      enabledProjectIds: () => store.list().some((item) => item.enabled) ? ['p'] : [],
      store: () => store,
      // No idle wake here: this case pins the reschedule path a local enable takes.
      hasProjects: () => false,
    };
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: coordinator as never,
      handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never } }),
    });
    await scheduler.start();
    expect(scheduler.hasTimer()).toBe(false);
    const paused = store.get(definition.id)!;
    store.update(paused.id, paused.revision, { ...paused, enabled: true });
    await scheduler.reschedule();
    expect(scheduler.hasTimer()).toBe(true);
    scheduler.stop();
  });

  it('keeps one timer when overlapping reschedules resolve out of order', async () => {
    vi.useFakeTimers();
    try {
      const { store } = await setup();
      const releases: Array<() => void> = [];
      const coordinator = {
        refresh: () => new Promise<void>((resolve) => releases.push(resolve)),
        enabledProjectIds: () => ['p'],
        store: () => store,
      };
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: coordinator as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: async () => ({ candidates: [], truncated: false, pages: 1 }) } as never } }),
      });
      const started = scheduler.start();
      releases.shift()!();
      await started;
      const first = scheduler.reschedule();
      const second = scheduler.reschedule();
      releases.pop()!();
      await second;
      releases.shift()!();
      await first;
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
    } finally {
      vi.useRealTimers();
    }
  });

  it('defers a rejected project so another due project can run', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T06:00:00Z');
      vi.setSystemTime(now);
      const a = await setup();
      const b = await setup();
      a.store.setState(a.definition.id, (current) => ({ ...current, nextCheckAt: new Date(now - 60_000).toISOString() }));
      b.store.setState(b.definition.id, (current) => ({ ...current, nextCheckAt: new Date(now + 30_000).toISOString() }));
      a.store.setState = () => { throw new Error('read-only automation state'); };
      const failing = vi.fn(async () => { throw new Error('rate limited'); });
      const healthy = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
      const stores = { a: a.store, b: b.store };
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['a', 'b'], store: (id: 'a' | 'b') => stores[id] } as never,
        handle: (id, store) => ({ projectId: id, store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: id === 'a' ? failing : healthy } as never }, launch: async () => ({ runId: 'unused' }) }),
        now: () => Date.now(),
      });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(failing).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(healthy).toHaveBeenCalledTimes(1);
      expect(failing).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(270_000);
      expect(failing).toHaveBeenCalledTimes(2);
      scheduler.stop();
    } finally { vi.useRealTimers(); }
  });

  it('a project without github arms only schedule items', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T03:59:00Z');
      vi.setSystemTime(now);
      const { store, definition: poll } = await setup();
      store.setState(poll.id, (current) => ({ ...current, nextCheckAt: new Date(now - 60_000).toISOString() }));
      const nightly = store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly') as ScheduleAutomationDefinition;
      const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
        // No `github`: this project has no GitHub remote. The past-due poll must not fire.
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule }),
        now: () => Date.now(),
      });
      await scheduler.start();
      expect(store.state(nightly.id)?.nextRunAt).toBe('2026-09-14T04:00:00.000Z');
      await vi.advanceTimersByTimeAsync(30_000);
      expect(launchSchedule).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(31_000);
      expect(launchSchedule).toHaveBeenCalledTimes(1);
      expect(launchSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'nightly' }), { at: '2026-09-14T04:00:00.000Z', trigger: 'schedule' }, expect.any(String));
      expect(store.logs({ automationId: poll.id })).toEqual([]);
      scheduler.stop();
    } finally { vi.useRealTimers(); }
  });

  it('mixed kinds arm the earlier due item', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T03:59:00Z');
      vi.setSystemTime(now);
      const { store, definition: poll } = await setup();
      store.setState(poll.id, (current) => ({ ...current, nextCheckAt: new Date(now + 10 * 60_000).toISOString() }));
      store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
      const pollFn = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
      const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: pollFn } as never }, launch: async () => ({ runId: 'unused' }), launchSchedule }),
        now: () => Date.now(),
      });
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(61_000);
      expect(launchSchedule).toHaveBeenCalledTimes(1);
      expect(pollFn).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10 * 60_000);
      expect(pollFn).toHaveBeenCalledTimes(1);
      scheduler.stop();
    } finally { vi.useRealTimers(); }
  });

  it('a fire that rejects with ScheduleLeaseHeldError re-arms at the retry floor', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T04:00:00Z');
      vi.setSystemTime(now);
      const { store } = await setup();
      const poll = store.list()[0]!;
      store.update(poll.id, poll.revision, { ...poll, enabled: false });
      store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
      store.setState('nightly', (current) => ({ ...current, nextRunAt: new Date(now).toISOString() }));
      const fire = vi.spyOn(scheduleRunner.ScheduleRunner.prototype, 'fire').mockRejectedValue(new scheduleRunner.ScheduleLeaseHeldError());
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule: async () => ({ runId: 'unused' }) }),
        now: () => Date.now(),
      });
      try {
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(fire).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(fire).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(fire).toHaveBeenCalledTimes(2);
      } finally {
        scheduler.stop();
        fire.mockRestore();
      }
    } finally { vi.useRealTimers(); }
  });

  it('a weekly schedule fires on time after the machine slept past its occurrence', async () => {
    // A suspend stops the monotonic clock Node timers count on: wall time jumps, timers do not
    // advance. One timer armed for the whole week would wake days late; the capped wake notices.
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T04:00:00Z'); // a Monday
      vi.setSystemTime(now);
      const { store } = await setup();
      const poll = store.list()[0]!;
      store.update(poll.id, poll.revision, { ...poll, enabled: false });
      store.create({ name: 'Weekly', enabled: true, kind: 'schedule', schedule: { type: 'weekly', day: 4, hour: 9, minute: 0 }, task: { prompt: 'Report' } }, 'weekly');
      const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule }),
        now: () => Date.now(),
      });
      try {
        await scheduler.start();
        expect(store.state('weekly')?.nextRunAt).toBe('2026-09-17T09:00:00.000Z');
        // Asleep until a minute before Thursday 09:00; the timers saw none of it.
        vi.setSystemTime(Date.parse('2026-09-17T08:59:30Z'));
        await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
        expect(launchSchedule).toHaveBeenCalledTimes(1);
        expect(launchSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'weekly' }), { at: '2026-09-17T09:00:00.000Z', trigger: 'schedule' }, expect.any(String));
      } finally { scheduler.stop(); }
    } finally { vi.useRealTimers(); }
  });

  it('a capped wake before a poll is due re-arms without firing it', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T06:00:00Z');
      vi.setSystemTime(now);
      const { store, definition } = await setup();
      // Backed off for two hours: far beyond one capped wake.
      store.setState(definition.id, (current) => ({ ...current, nextCheckAt: new Date(now + 2 * 60 * 60_000).toISOString() }));
      const pollFn = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: pollFn } as never }, launch: async () => ({ runId: 'unused' }) }),
        now: () => Date.now(),
      });
      try {
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(2 * 60 * 60_000 - 1_000);
        expect(pollFn).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(1);
        await vi.advanceTimersByTimeAsync(1_000);
        expect(pollFn).toHaveBeenCalledTimes(1);
        // And a wall-clock jump past the due instant is noticed within one cap.
        store.setState(definition.id, (current) => ({ ...current, nextCheckAt: new Date(Date.now() + 2 * 60 * 60_000).toISOString() }));
        await scheduler.reschedule();
        vi.setSystemTime(Date.now() + 3 * 60 * 60_000);
        await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
        expect(pollFn).toHaveBeenCalledTimes(2);
      } finally { scheduler.stop(); }
    } finally { vi.useRealTimers(); }
  });

  describe('a definition changed by another process (finding 4172021393)', () => {
    async function workspace() {
      const root = await mkdtemp(join(tmpdir(), 'cezar-scheduler-ws-')); dirs.push(root);
      const coordinator = new AutomationCoordinator({ listProjects: async () => [{ id: 'p', root, status: 'ok' }] });
      return { root, dataDir: join(root, '.ai/cezar'), coordinator };
    }

    it('arms and fires a schedule another process enabled while this one had nothing armed', async () => {
      vi.useFakeTimers();
      try {
        const now = Date.parse('2026-09-14T03:58:00Z');
        vi.setSystemTime(now);
        const { dataDir, coordinator } = await workspace();
        // The other process (B) owns the definition; it starts paused.
        const other = AutomationStore.open(dataDir);
        const paused = other.create({ name: 'Nightly', enabled: false, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
        const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
        const scheduler = new WorkspaceAutomationScheduler({
          coordinator,
          handle: (projectId, store) => ({ projectId, store, timeZone: 'UTC', launchSchedule }),
          now: () => Date.now(),
        });
        try {
          await scheduler.start();
          const mine = coordinator.store('p')!;
          expect(mine.get('nightly')?.enabled).toBe(false);
          // B enables it and exits: no event reaches this process, only the file changes.
          other.update(paused.id, paused.revision, { ...paused, enabled: true });
          await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
          expect(mine.get('nightly')?.enabled).toBe(true);
          expect(mine.state('nightly')?.nextRunAt).toBe('2026-09-14T04:00:00.000Z');
          expect(scheduler.hasTimer()).toBe(true);
          expect(launchSchedule).not.toHaveBeenCalled();
          await vi.advanceTimersByTimeAsync(Date.parse('2026-09-14T04:00:00Z') - Date.now());
          expect(launchSchedule).toHaveBeenCalledTimes(1);
          expect(launchSchedule).toHaveBeenCalledWith(expect.objectContaining({ id: 'nightly' }), { at: '2026-09-14T04:00:00.000Z', trigger: 'schedule' }, expect.any(String));
        } finally { scheduler.stop(); }
      } finally { vi.useRealTimers(); }
    });

    it('discovers a project whose definitions file another process created after boot', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.parse('2026-09-14T03:58:00Z'));
        const { root, dataDir } = await workspace();
        const second = await mkdtemp(join(tmpdir(), 'cezar-scheduler-ws-')); dirs.push(second);
        // Project `a` already has a (paused) automation, so this workspace keeps its idle wake.
        AutomationStore.open(dataDir).create({ name: 'Paused', enabled: false, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'x' } }, 'paused');
        const coordinator = new AutomationCoordinator({ listProjects: async () => [{ id: 'a', root, status: 'ok' }, { id: 'b', root: second, status: 'ok' }] });
        const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
        const scheduler = new WorkspaceAutomationScheduler({
          coordinator,
          handle: (projectId, store) => ({ projectId, store, timeZone: 'UTC', launchSchedule }),
          now: () => Date.now(),
        });
        try {
          await scheduler.start();
          expect(coordinator.ids()).toEqual(['a']);
          AutomationStore.open(join(second, '.ai/cezar')).create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'x' } }, 'nightly');
          await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
          expect(coordinator.ids()).toEqual(['a', 'b']);
          await vi.advanceTimersByTimeAsync(Date.parse('2026-09-14T04:00:00Z') - Date.now());
          expect(launchSchedule).toHaveBeenCalledTimes(1);
        } finally { scheduler.stop(); }
      } finally { vi.useRealTimers(); }
    });

    it('a workspace with no registered project arms no timer', async () => {
      vi.useFakeTimers();
      try {
        const coordinator = new AutomationCoordinator({ listProjects: async () => [] });
        const scheduler = new WorkspaceAutomationScheduler({
          coordinator,
          handle: (projectId, store) => ({ projectId, store, timeZone: 'UTC' }),
        });
        try {
          await scheduler.start();
          expect(scheduler.hasTimer()).toBe(false);
          expect(vi.getTimerCount()).toBe(0);
        } finally { scheduler.stop(); }
      } finally { vi.useRealTimers(); }
    });

    it('a registered project without definitions keeps an idle wake that discovers a schedule another process creates and exits (finding 4172236277)', async () => {
      vi.useFakeTimers();
      try {
        vi.setSystemTime(Date.parse('2026-09-14T03:58:00Z'));
        const { root, dataDir, coordinator } = await workspace();
        await mkdir(dataDir, { recursive: true });
        const launchSchedule = vi.fn(async () => ({ runId: 'scheduled' }));
        const scheduler = new WorkspaceAutomationScheduler({
          coordinator,
          handle: (projectId, store) => ({ projectId, store, timeZone: 'UTC', launchSchedule }),
          now: () => Date.now(),
        });
        try {
          await scheduler.start();
          expect(coordinator.ids()).toEqual([]);
          expect(scheduler.hasTimer()).toBe(true);
          // Another cockpit creates and enables the first automation, then is gone.
          AutomationStore.open(join(root, '.ai/cezar')).create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'x' } }, 'nightly');
          await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
          expect(coordinator.ids()).toEqual(['p']);
          await vi.advanceTimersByTimeAsync(Date.parse('2026-09-14T04:00:00Z') - Date.now());
          expect(launchSchedule).toHaveBeenCalledTimes(1);
        } finally { scheduler.stop(); }
      } finally { vi.useRealTimers(); }
    });
  });

  it('hands the project\'s receipt reconciliation to the schedule runner (finding 4172021394)', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T04:00:01Z');
      vi.setSystemTime(now);
      const { store } = await setup();
      const poll = store.list()[0]!;
      store.update(poll.id, poll.revision, { ...poll, enabled: false });
      store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
      const at = '2026-09-14T04:00:00.000Z';
      store.setState('nightly', (current) => ({ ...current, nextRunAt: at }));
      await appendFile(join(store.dataDir, 'automation-receipts.ndjson'), `${JSON.stringify({ receiptId: 'lost', receiptKey: `nightly:schedule:${at}`, eventId: `schedule:${at}`, automationId: 'nightly', revision: 1, status: 'reserved', occurrenceAt: at, observedAt: at, updatedAt: at })}\n`);
      const reconcileReceipts = vi.fn(async () => undefined);
      const launchSchedule = vi.fn(async () => ({ runId: 'unused' }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store, hasProjects: () => true } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule, reconcileReceipts }),
        now: () => Date.now(),
      });
      try {
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(reconcileReceipts).toHaveBeenCalledTimes(1);
        expect(launchSchedule).not.toHaveBeenCalled();
      } finally { scheduler.stop(); }
    } finally { vi.useRealTimers(); }
  });

  it('hands the project\'s readiness check to the schedule runner, and retries an unavailable project at the floor (#779)', async () => {
    vi.useFakeTimers();
    try {
      const now = Date.parse('2026-09-14T04:00:01Z');
      vi.setSystemTime(now);
      const { store } = await setup();
      const poll = store.list()[0]!;
      store.update(poll.id, poll.revision, { ...poll, enabled: false });
      store.create({ name: 'Nightly', enabled: true, kind: 'schedule', schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Bump deps' } }, 'nightly');
      store.setState('nightly', (current) => ({ ...current, nextRunAt: '2026-09-14T04:00:00.000Z' }));
      const ready = vi.fn(async () => { throw new scheduleRunner.AutomationProjectUnavailableError('runs.db is damaged'); });
      const launchSchedule = vi.fn(async () => ({ runId: 'unused' }));
      const scheduler = new WorkspaceAutomationScheduler({
        coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store, hasProjects: () => true } as never,
        handle: () => ({ projectId: 'p', store, timeZone: 'UTC', launchSchedule, ready }),
        now: () => Date.now(),
      });
      try {
        await scheduler.start();
        await vi.advanceTimersByTimeAsync(1);
        expect(ready).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(59_000);
        expect(ready).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(2_000);
        expect(ready).toHaveBeenCalledTimes(2);
        expect(launchSchedule).not.toHaveBeenCalled();
        expect(store.get('nightly')?.enabled).toBe(true);
        expect(store.state('nightly')?.consecutiveFailures).toBeUndefined();
      } finally { scheduler.stop(); }
    } finally { vi.useRealTimers(); }
  });

  it('stop prevents an in-flight coordinator refresh from arming a timer', async () => {
    vi.useFakeTimers();
    const { store } = await setup();
    let finishRefresh!: () => void;
    const refresh = new Promise<void>(resolve => { finishRefresh = resolve; });
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: { refresh: () => refresh, enabledProjectIds: () => ['p'], store: () => store } as never,
      handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll } as never } }),
    });
    try {
      const started = scheduler.start();
      scheduler.stop();
      finishRefresh();
      await started;
      expect(scheduler.hasTimer()).toBe(false);
      await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
      expect(poll).not.toHaveBeenCalled();
      await scheduler.reschedule();
      expect(scheduler.hasTimer()).toBe(false);
    } finally { scheduler.stop(); vi.useRealTimers(); }
  });

  it('a newer reschedule replaces the pending refresh without arming two polls', async () => {
    vi.useFakeTimers();
    const { store } = await setup();
    let finishFirst!: () => void;
    const first = new Promise<void>(resolve => { finishFirst = resolve; });
    const refresh = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
    const poll = vi.fn(async () => ({ candidates: [], truncated: false, pages: 1 }));
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: { refresh, enabledProjectIds: () => ['p'], store: () => store } as never,
      handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll } as never } }),
    });
    try {
      const started = scheduler.start();
      await scheduler.reschedule();
      finishFirst();
      await started;
      await vi.advanceTimersByTimeAsync(1);
      expect(poll).toHaveBeenCalledTimes(1);
      scheduler.stop();
      await vi.advanceTimersByTimeAsync(WORKSPACE_TIMER_CAP_MS);
      expect(poll).toHaveBeenCalledTimes(1);
      expect(scheduler.hasTimer()).toBe(false);
    } finally { scheduler.stop(); vi.useRealTimers(); }
  });

  it('check refuses a project without a GitHub remote', async () => {
    const { store, definition } = await setup();
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC' });
    await expect(scheduler.check(definition)).rejects.toThrow('No GitHub remote is configured');
  });
});


function schedulerFixture(store: AutomationStore, poll: (options: GithubPollOptions) => Promise<GithubPollResult>, overrides: Partial<ProjectAutomationHandle> = {}) {
  return new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
    github: { owner: 'acme', repo: 'demo', poller: { poll: (_owner: string, _repo: string, _definition: GithubAutomationDefinition, options: GithubPollOptions) => poll(options) } as never },
    launch: async () => ({ runId: 'new-run' }), ...overrides,
  });
}
const emptyPoll = async (): Promise<GithubPollResult> => ({ candidates: [], truncated: false, pages: 1 });

describe('scheduler mutation boundaries', () => {
  it.each(['preview', 'execute'] as const)('passes history scans only for execution (%s)', async mode => {
    const { store, definition } = await setup();
    const historyScan = { since: '2026-07-20T00:00:00.000Z', until: '2026-07-26T00:00:00.000Z', source: 0, page: 2, item: 3, event: 0 };
    store.setState(definition.id, () => ({ historyScan }));
    const poll = vi.fn(emptyPoll);
    await schedulerFixture(store, poll).check(definition, mode);
    expect(poll).toHaveBeenCalledWith(mode === 'execute'
      ? { since: undefined, accept: expect.any(Function), historyScan }
      : { since: undefined, accept: expect.any(Function) });
    expect(store.state(definition.id)?.historyScan).toEqual(mode === 'execute' ? undefined : historyScan);
  });

  it('detects without a launcher using preview eligibility and preserves the execution cursor', async () => {
    const { store, definition } = await setup();
    const now = Date.parse(candidate.timestamp);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    const cursor = { timestamp: candidate.timestamp, tieBreaker: 'previous' };
    store.setState(definition.id, () => ({ cursor, consecutiveFailures: 2 }));
    const receipt = store.reserveReceipt({ automationId: definition.id, revision: 1, eventId: candidate.eventId, candidate })!;
    const poll = vi.fn(async (options: GithubPollOptions) => {
      expect(options.accept?.(candidate)).toBe(true);
      return { candidates: [candidate], truncated: false, pages: 1 };
    });
    try {
      expect((await schedulerFixture(store, poll, { launch: undefined }).check(definition)).candidates).toEqual([candidate]);
      expect(store.state(definition.id)).toEqual({ cursor, consecutiveFailures: 2, revision: 1,
        nextCheckAt: new Date(now + 300_000).toISOString() });
      expect([...store.latestReceipts().values()]).toEqual([receipt]);
      expect(store.logs({ automationId: definition.id })).toEqual([expect.objectContaining({ result: 'preview' })]);
    } finally { clock.mockRestore(); }
  });

  it.each([
    { mode: 'execute' as const, baseline: '2026-07-25T12:00:00.000Z', cursor: undefined, since: '2026-07-25T11:58:00.000Z' },
    { mode: 'execute' as const, baseline: '2026-07-24T00:00:00.000Z', cursor: undefined, since: '2026-07-25T00:00:00.000Z' },
    { mode: 'execute' as const, baseline: undefined, cursor: '', since: '2026-07-25T00:00:00.000Z' },
    { mode: 'execute' as const, baseline: undefined, cursor: '2026-07-25T06:00:00.000Z', since: '2026-07-25T05:58:00.000Z' },
    { mode: 'preview' as const, baseline: '2026-07-25T12:00:00.000Z', cursor: '2026-07-26T00:00:00.000Z', since: '2026-07-25T00:00:00.000Z' },
  ])('uses the bounded history window for $mode with baseline $baseline and cursor $cursor', async ({ mode, baseline, cursor, since }) => {
    const { store, definition } = await setup();
    const rule = { ...definition, filters: { ...definition.filters, includeExisting: true, lookbackDays: 1 } };
    const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-07-26T00:00:00.000Z'));
    store.setState(rule.id, () => ({ baselineAt: baseline, cursor: cursor === undefined ? undefined : { timestamp: cursor } }));
    const poll = vi.fn(emptyPoll);
    try {
      await schedulerFixture(store, poll).check(rule, mode);
      expect(poll).toHaveBeenCalledWith({ since, accept: expect.any(Function) });
    } finally { clock.mockRestore(); }
  });

  it.each(['preview', 'execute'] as const)('handles repeated candidates according to %s mode', async mode => {
    const { store, definition } = await setup();
    const accepted: boolean[] = [];
    await schedulerFixture(store, async options => {
      accepted.push(options.accept!(candidate), options.accept!({ ...candidate, eventId: 'second', event: 'issue.labeled', repo: 'ACME/DEMO' }));
      return { candidates: [], truncated: false, pages: 1 };
    }).check(definition, mode);
    expect(accepted).toEqual(mode === 'preview' ? [true, true] : [true, false]);
    expect(store.logs({ automationId: definition.id }).filter(row => row.result === 'duplicate')).toEqual(mode === 'preview' ? [] : [
      expect.objectContaining({ githubNumber: 7, reason: 'Another matching event for this issue was selected in this check.' }),
    ]);
  });

  it.each([0, 2])('records the bounded preview count for %s matches', async count => {
    const { store, definition } = await setup();
    const rows = Array.from({ length: count }, (_, i) => ({ ...candidate, number: i + 1 }));
    await schedulerFixture(store, async () => ({ candidates: rows, truncated: false, pages: 1 })).check(definition, 'preview');
    expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'preview',
      reason: `Bounded preview found ${count} filter matches; no tasks were launched. Counts can include closed items and previously processed events.` });
  });

  it('records elapsed check duration and compacts before releasing the lease even if compaction fails', async () => {
    const { store, definition } = await setup();
    let now = Date.parse(candidate.timestamp);
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const compact = vi.spyOn(store, 'maybeCompact').mockImplementation(async () => {
      expect(store.acquireLease()).toBeUndefined();
      throw new Error('cannot compact');
    });
    try {
      await schedulerFixture(store, async () => { now += 75; return emptyPoll(); }).check(definition);
      expect(compact).toHaveBeenCalledTimes(1);
      expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ durationMs: 75, result: 'no-match', reason: 'Scheduled check completed.' });
      const next = store.acquireLease();
      expect(next).toBeDefined();
      next?.release();
    } finally { clock.mockRestore(); }
  });

  it('does not compact without a lease', async () => {
    const { store, definition } = await setup();
    const lease = store.acquireLease();
    const compact = vi.spyOn(store, 'maybeCompact');
    try {
      await expect(schedulerFixture(store, emptyPoll).check(definition)).rejects.toBeInstanceOf(LeaseHeldError);
      expect(compact).not.toHaveBeenCalled();
    } finally { lease?.release(); }
  });

  it('does not ask for project readiness when there are no candidates', async () => {
    const { store, definition } = await setup();
    const ready = vi.fn(async () => { throw new Error('project unavailable'); });
    await schedulerFixture(store, emptyPoll, { ready }).check(definition);
    expect(ready).not.toHaveBeenCalled();
  });

  it('refuses an obsolete definition before querying the provider', async () => {
    const { store, definition } = await setup();
    store.update(definition.id, definition.revision, { ...definition, name: 'Edited' });
    const poll = vi.fn(emptyPoll);
    expect(await schedulerFixture(store, poll).check(definition)).toEqual({ candidates: [], truncated: false, pages: 0 });
    expect(poll).not.toHaveBeenCalled();
    expect(store.logs({ automationId: definition.id })).toEqual([expect.objectContaining({ result: 'skipped' })]);
  });

  it('does not ask readiness for results of an obsolete provider request', async () => {
    const { store, definition } = await setup();
    const ready = vi.fn(async () => undefined);
    expect(await schedulerFixture(store, async () => {
      store.update(definition.id, definition.revision, { ...definition, name: 'Edited' });
      return { candidates: [candidate], truncated: false, pages: 1 };
    }, { ready }).check(definition)).toEqual({ candidates: [], truncated: false, pages: 0 });
    expect(ready).not.toHaveBeenCalled();
  });

  it('does not launch if readiness deletes the automation', async () => {
    const { store, definition } = await setup();
    const launch = vi.fn(async () => ({ runId: 'unexpected' }));
    await schedulerFixture(store, async () => ({ candidates: [candidate], truncated: false, pages: 1 }), {
      ready: async () => { store.delete(definition.id); }, launch,
    }).check(definition);
    expect(launch).not.toHaveBeenCalled();
    expect(store.receipts()).toEqual([]);
  });

  it('does not launch if the current-label recheck deletes the automation', async () => {
    const { store, definition } = await setup();
    const rule = { ...definition, filters: { ...definition.filters, requireCurrentLabels: true } };
    const launch = vi.fn(async () => ({ runId: 'unexpected' }));
    const github = { owner: 'acme', repo: 'demo', poller: {
      poll: async () => ({ candidates: [candidate], truncated: false, pages: 1 }),
      matchesCurrentLabels: async () => { store.delete(rule.id); return true; },
    } as never };
    await schedulerFixture(store, emptyPoll, { github, launch }).check(rule);
    expect(launch).not.toHaveBeenCalled();
    expect(store.receipts()).toEqual([]);
  });

  it.each([1, 4, 11])('persists exact exponential backoff after %s previous failures', async failures => {
    const { store, definition } = await setup();
    const now = Date.parse(candidate.timestamp);
    const clock = vi.spyOn(Date, 'now').mockReturnValue(now);
    store.setState(definition.id, () => ({ consecutiveFailures: failures }));
    const onChange = vi.fn();
    try {
      await expect(schedulerFixture(store, async () => { throw 'provider refused'; }, { onChange }).check(definition)).rejects.toBe('provider refused');
      const until = new Date(now + Math.min(21_600_000, 60_000 * 2 ** failures)).toISOString();
      expect(store.state(definition.id)).toEqual({ consecutiveFailures: failures + 1, backoffUntil: until, nextCheckAt: until });
      expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'error', reason: 'provider refused' });
      expect(onChange).toHaveBeenCalledWith(definition.id, definition.revision);
    } finally { clock.mockRestore(); }
  });

  it.each(['string', 'error'] as const)('records a preview %s failure without changing execution state', async kind => {
    const { store, definition } = await setup();
    const error = kind === 'error' ? new Error('preview refused') : 'preview refused';
    await expect(schedulerFixture(store, async () => { throw error; }).check(definition, 'preview')).rejects.toBe(error);
    expect(store.state(definition.id)).toBeUndefined();
    expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'error', reason: 'preview refused' });
  });
});


describe('scheduler receipt guards', () => {
  it.each([undefined, 'previous-run'])('audits an issue receipt with runId=%s before refusing a second launch', async runId => {
    const { store, definition } = await setup();
    const old = store.reserveReceipt({ automationId: definition.id, revision: 1, eventId: 'old-event', candidate: { ...candidate, eventId: 'old-event' } })!;
    store.appendReceipt({ ...old, status: 'launched', ...(runId ? { runId } : {}), updatedAt: candidate.timestamp });
    const launch = vi.fn(async () => ({ runId: 'unexpected' }));
    await schedulerFixture(store, async () => ({ candidates: [candidate], truncated: false, pages: 1 }), { launch }).check(definition);
    expect(launch).not.toHaveBeenCalled();
    const duplicate = store.logs({ automationId: definition.id }).find(row => row.result === 'duplicate');
    expect(duplicate).toMatchObject({ githubNumber: 7, githubTitle: candidate.title, githubUrl: candidate.url, event: candidate.event,
      reason: `A durable receipt already exists for this automation and issue.${runId ? ` Task: ${runId}.` : ''}` });
    expect(duplicate?.runId).toBe(runId);
  });

  it('audits an already reserved PR event without launching it again', async () => {
    const { store, definition } = await setup();
    const row: GithubCandidate = { ...candidate, event: 'pull_request.opened' };
    store.reserveReceipt({ automationId: definition.id, revision: 1, eventId: row.eventId, candidate: row });
    const launch = vi.fn(async () => ({ runId: 'unexpected' }));
    await schedulerFixture(store, async () => ({ candidates: [row], truncated: false, pages: 1 }), { launch }).check(definition);
    expect(launch).not.toHaveBeenCalled();
    expect(store.logs({ automationId: definition.id })).toContainEqual(expect.objectContaining({
      result: 'duplicate', reason: 'A durable receipt already exists for this automation and event.',
      event: 'pull_request.opened', githubNumber: 7, githubTitle: row.title, githubUrl: row.url,
    }));
  });

  it.each(['legacy', 'other repo', 'pull request'] as const)('allows an issue when an earlier receipt is for %s', async kind => {
    const { store, definition } = await setup();
    const earlier = { ...candidate, eventId: 'other-event', ...(kind === 'other repo' ? { repo: 'acme/other' } : {}),
      ...(kind === 'pull request' ? { event: 'pull_request.opened' as const } : {}) };
    store.reserveReceipt({ automationId: definition.id, revision: 1, eventId: earlier.eventId,
      ...(kind === 'legacy' ? {} : { candidate: earlier }) });
    const launch = vi.fn(async () => ({ runId: 'new-run' }));
    await schedulerFixture(store, async () => ({ candidates: [candidate], truncated: false, pages: 1 }), { launch }).check(definition);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.logs({ automationId: definition.id })).toContainEqual(expect.objectContaining({ result: 'launched', runId: 'new-run' }));
  });

  it('keeps separate PR events and issue identities in the same provider result', async () => {
    const { store, definition } = await setup();
    const rows: GithubCandidate[] = [candidate, { ...candidate, event: 'pull_request.opened' },
      { ...candidate, event: 'pull_request.opened', eventId: 'different-pr-event' }];
    const accepted: boolean[] = [];
    await schedulerFixture(store, async options => {
      for (const row of rows) accepted.push(options.accept!(row));
      return { candidates: [], truncated: false, pages: 1 };
    }).check(definition);
    expect(accepted).toEqual([true, true, true]);
  });

  it('attributes duplicate audit to the live receipt instead of released or foreign receipts', async () => {
    const { store, definition } = await setup();
    for (const [automationId, status, runId] of [[definition.id, 'launched', 'owner'], [definition.id, 'released', 'released-run'], ['other', 'launched', 'foreign-run']] as const) {
      const receipt = store.reserveReceipt({ automationId, revision: 1, eventId: runId, candidate: { ...candidate, eventId: runId } })!;
      store.appendReceipt({ ...receipt, status, runId, updatedAt: candidate.timestamp });
    }
    await schedulerFixture(store, async options => {
      expect(options.accept!(candidate)).toBe(false);
      return emptyPoll();
    }).check(definition);
    expect(store.logs({ automationId: definition.id }).find(row => row.result === 'duplicate')).toMatchObject({
      runId: 'owner', reason: 'A durable receipt already exists for this automation and item. Task: owner.',
    });
  });

  it('does not store success after an automation is deleted during duplicate logging', async () => {
    const { store, definition } = await setup();
    store.reserveReceipt({ automationId: definition.id, revision: 1, eventId: candidate.eventId, candidate });
    const log = store.appendLog.bind(store);
    vi.spyOn(store, 'appendLog').mockImplementation(async row => {
      const written = await log(row);
      if (row.result === 'duplicate') store.delete(definition.id);
      return written;
    });
    const onChange = vi.fn();
    const result = await schedulerFixture(store, async options => {
      options.accept!(candidate);
      return emptyPoll();
    }, { onChange }).check(definition);
    expect(result).toEqual({ candidates: [], truncated: false, pages: 0 });
    expect(store.state(definition.id)?.lastSuccessAt).toBeUndefined();
    expect(onChange).not.toHaveBeenCalled();
    expect(store.logs({ automationId: definition.id }).some(row => row.result === 'no-match')).toBe(false);
  });
});


describe('scheduler durable outcomes', () => {
  it('leaves an interrupted state-first edit untouched during preview', async () => {
    const { store, definition } = await setup();
    const state = { revision: 2, baselineAt: candidate.timestamp };
    store.setState(definition.id, () => state);
    const poll = vi.fn(emptyPoll);
    expect(await schedulerFixture(store, poll).check(definition, 'preview')).toEqual({ candidates: [], truncated: false, pages: 0 });
    expect(poll).not.toHaveBeenCalled();
    expect(store.state(definition.id)).toEqual(state);
  });

  it('retains the frozen high watermark and partial scan after a truncated poll', async () => {
    const { store, definition } = await setup();
    const cursor = { timestamp: candidate.timestamp, tieBreaker: 'last-item' };
    const historyScan = { since: candidate.timestamp, until: candidate.timestamp, source: 1, page: 1, item: 2, event: 0 };
    await schedulerFixture(store, async () => ({ candidates: [], truncated: true, pages: 2, cursor, historyScan })).check(definition);
    expect(store.state(definition.id)).toMatchObject({ cursor, frozenHighWatermark: cursor, historyScan });
  });

  it.each([
    { current: { timestamp: '2026-07-26T02:00:00.000Z', tieBreaker: 'z' }, observed: { timestamp: '2026-07-26T01:00:00.000Z', tieBreaker: 'zz' }, winner: 'current' },
    { current: { timestamp: candidate.timestamp, tieBreaker: 'z' }, observed: { timestamp: candidate.timestamp, tieBreaker: 'a' }, winner: 'current' },
    { current: { timestamp: candidate.timestamp }, observed: { timestamp: candidate.timestamp, tieBreaker: 'a' }, winner: 'observed' },
    { current: { timestamp: candidate.timestamp, tieBreaker: 'a' }, observed: { timestamp: candidate.timestamp, tieBreaker: 'z' }, winner: 'observed' },
  ])('keeps $winner cursor with current $current and observed $observed', async ({ current, observed, winner }) => {
    const { store, definition } = await setup();
    store.setState(definition.id, () => ({ cursor: current }));
    await schedulerFixture(store, async () => ({ candidates: [], truncated: false, pages: 1, cursor: observed })).check(definition);
    expect(store.state(definition.id)?.cursor).toEqual(winner === 'current' ? current : observed);
  });

  it('preserves a policy edit between error validation and failure persistence', async () => {
    const { store, definition } = await setup();
    const setState = store.setState.bind(store);
    vi.spyOn(store, 'setState').mockImplementationOnce((id, update) => {
      store.update(definition.id, definition.revision, { ...definition, name: 'Edited' });
      setState(id, () => ({ revision: 2, baselineAt: candidate.timestamp }));
      return setState(id, update);
    });
    await expect(schedulerFixture(store, async () => { throw new Error('provider refused'); }).check(definition)).rejects.toThrow('Automation changed');
    expect(store.state(definition.id)).toEqual({ revision: 2, baselineAt: candidate.timestamp });
  });
});

describe('workspace timer boundaries', () => {
  it('stop cancels the pending timer and a stopped reschedule does not refresh', async () => {
    vi.useFakeTimers();
    const { store, definition } = await setup();
    store.setState(definition.id, () => ({ nextCheckAt: new Date(Date.now() + 30_000).toISOString() }));
    const refresh = vi.fn(async () => undefined);
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: { refresh, enabledProjectIds: () => ['p'], store: () => store } as never,
      handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll: emptyPoll } as never } }),
    });
    try {
      await scheduler.start();
      expect(vi.getTimerCount()).toBe(1);
      scheduler.stop();
      expect(vi.getTimerCount()).toBe(0);
      await scheduler.reschedule();
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally { scheduler.stop(); vi.useRealTimers(); }
  });

  it('skips a throwing schedule dueAt and still fires a healthy poll', async () => {
    vi.useFakeTimers();
    const { store } = await setup();
    store.create({ name: 'Schedule', kind: 'schedule', enabled: true, schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Review' } }, 'schedule');
    const dueAt = vi.spyOn(scheduleRunner.ScheduleRunner.prototype, 'dueAt').mockImplementation(() => { throw new Error('unwritable state'); });
    const poll = vi.fn(emptyPoll);
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
      handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll } as never } }),
    });
    try {
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(dueAt).toHaveBeenCalled();
      expect(poll).toHaveBeenCalledTimes(1);
    } finally { scheduler.stop(); dueAt.mockRestore(); vi.useRealTimers(); }
  });

  it('passes the project clock and change notification to its schedule runner', async () => {
    vi.useFakeTimers();
    const now = Date.parse('2026-09-14T04:00:00Z');
    vi.setSystemTime(now);
    const { store, definition } = await setup();
    store.update(definition.id, definition.revision, { ...definition, enabled: false });
    store.create({ name: 'Daily', kind: 'schedule', enabled: true, schedule: { type: 'daily', hour: 4, minute: 0 }, task: { prompt: 'Review' } }, 'daily');
    store.setState('daily', () => ({ nextRunAt: new Date(now).toISOString() }));
    const clock = vi.fn(() => now);
    const onChange = vi.fn();
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store } as never,
      handle: () => ({ projectId: 'p', store, timeZone: 'UTC', now: clock, onChange, launchSchedule: async () => ({ runId: 'scheduled' }) }),
    });
    try {
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(clock).toHaveBeenCalled();
      expect(store.state('daily')?.nextRunAt).toBe('2026-09-15T04:00:00.000Z');
      expect(onChange).toHaveBeenCalledWith('daily', 1);
    } finally { scheduler.stop(); vi.useRealTimers(); }
  });

  it('clears a removed automation retry floor before it is enabled again', async () => {
    vi.useFakeTimers();
    const { store, definition } = await setup();
    const poll = vi.fn().mockRejectedValueOnce(new Error('provider refused')).mockImplementation(emptyPoll);
    const scheduler = new WorkspaceAutomationScheduler({
      coordinator: { refresh: async () => undefined, enabledProjectIds: () => ['p'], store: () => store, hasProjects: () => true } as never,
      handle: () => ({ projectId: 'p', store, timeZone: 'UTC', github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch: async () => ({ runId: 'unused' }) }),
    });
    try {
      await scheduler.start();
      await vi.advanceTimersByTimeAsync(1);
      expect(poll).toHaveBeenCalledTimes(1);
      const paused = store.update(definition.id, definition.revision, { ...definition, enabled: false });
      await scheduler.reschedule();
      store.update(paused.id, paused.revision, { ...paused, enabled: true });
      store.setState(definition.id, () => ({ nextCheckAt: new Date(Date.now()).toISOString() }));
      await scheduler.reschedule();
      await vi.advanceTimersByTimeAsync(1);
      expect(poll).toHaveBeenCalledTimes(2);
    } finally { scheduler.stop(); vi.useRealTimers(); }
  });
});

describe('scheduler dependency failures', () => {
  it('reports the held lease even if the requested definition became obsolete', async () => {
    const { store, definition } = await setup();
    const lease = store.acquireLease();
    store.delete(definition.id);
    try {
      await expect(schedulerFixture(store, emptyPoll).check(definition)).rejects.toBeInstanceOf(LeaseHeldError);
      expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'skipped', reason: 'automation polling lease is held by another process' });
    } finally { lease?.release(); }
  });

  it('propagates a store reload error instead of treating it as an obsolete check', async () => {
    const { store, definition } = await setup();
    const error = new Error('cannot reload definitions');
    vi.spyOn(store, 'reloadIfChanged').mockImplementation(() => { throw error; });
    await expect(schedulerFixture(store, emptyPoll).check(definition)).rejects.toBe(error);
    expect(store.logs({ automationId: definition.id })).toEqual([]);
  });

  it('does not audit duplicates after launch deletes the automation', async () => {
    const { store, definition } = await setup();
    store.reserveReceipt({ automationId: definition.id, revision: 1, eventId: candidate.eventId, candidate });
    const fresh = { ...candidate, number: 8, eventId: 'new-item' };
    await schedulerFixture(store, async options => {
      expect(options.accept!(candidate)).toBe(false);
      expect(options.accept!(fresh)).toBe(true);
      return { candidates: [fresh], truncated: false, pages: 1 };
    }, { launch: async () => { store.delete(definition.id); return { runId: 'already-launched' }; } }).check(definition);
    expect(store.logs({ automationId: definition.id }).filter(row => row.result === 'duplicate')).toEqual([]);
    expect(store.state(definition.id)?.lastSuccessAt).toBeUndefined();
  });
});

it('an explicit preview without a launcher does not reschedule execution', async () => {
  const { store, definition } = await setup();
  const state = { cursor: { timestamp: candidate.timestamp, tieBreaker: 'saved' },
    nextCheckAt: '2026-07-27T00:00:00.000Z', consecutiveFailures: 2 };
  store.setState(definition.id, () => state);
  const scheduler = schedulerFixture(store, emptyPoll, { launch: undefined });
  await scheduler.check(definition, 'preview');
  expect(store.state(definition.id)).toEqual(state);
  expect(store.receipts()).toEqual([]);
  expect(store.logs({ automationId: definition.id })[0]).toMatchObject({ result: 'preview' });
});

it('PR events are not collapsed onto issue receipts', async () => {
  const { store, definition } = await setup();
  const issueReceipt = store.reserveReceipt({ automationId: definition.id, revision: definition.revision,
    eventId: candidate.eventId, candidate })!;
  const pullRequest: GithubCandidate = { ...candidate, event: 'pull_request.opened', eventId: 'pr-opened' };
  const launch = vi.fn(async () => ({ runId: 'pr-run' }));
  await schedulerFixture(store, async options => {
    expect(options.accept!(pullRequest)).toBe(true);
    return { candidates: [pullRequest], truncated: false, pages: 1 };
  }, { launch }).check(definition);
  expect(launch).toHaveBeenCalledTimes(1);
  expect([...store.latestReceipts().values()]).toEqual([
    issueReceipt,
    expect.objectContaining({ status: 'launched', runId: 'pr-run', eventId: pullRequest.eventId, candidate: pullRequest }),
  ]);
  expect(store.logs({ automationId: definition.id }).filter(row => row.result === 'duplicate')).toEqual([]);
});
