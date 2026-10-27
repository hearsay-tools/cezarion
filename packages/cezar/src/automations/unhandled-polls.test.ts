import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { GithubPoller } from './github-poller.ts';
import { ProjectAutomationScheduler } from './scheduler.ts';
import { AutomationStore } from './store.ts';
import type { GithubAutomationDefinition } from './types.ts';

const dirs: string[] = [];
afterEach(async () => Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))));
const epoch = Date.parse('2026-10-27T00:00:00Z');
const at = (seconds: number) => new Date(epoch + seconds * 1000).toISOString();
const issue = (number: number) => ({
  node_id: `I_${number}`, number, title: 'Issue', html_url: `https://github.com/acme/demo/issues/${number}`,
  created_at: at(10), updated_at: at(90), user: { login: 'alice' }, labels: [{ name: 'bug' }],
  assignees: [], repository_url: 'https://api.github.com/repos/acme/demo',
});
async function setup(includeExisting: boolean, maxRecords: number) {
  const dir = await mkdtemp(join(tmpdir(), 'cezar-unhandled-')); dirs.push(dir);
  const store = AutomationStore.open(dir);
  const rule = store.create({ name: 'Repair', enabled: true, events: ['issue.labeled'], intervalSeconds: 300,
    filters: { includeExisting, maxRecords, lookbackDays: 7, changedLabels: ['bug'] }, task: { prompt: 'Repair' },
  }) as GithubAutomationDefinition;
  store.setState(rule.id, () => ({ revision: rule.revision, baselineAt: at(0),
    cursor: { timestamp: at(100), tieBreaker: 'old' }, frozenHighWatermark: { timestamp: at(100), tieBreaker: 'old' } }));
  return { store, rule };
}
function provider(items: ReturnType<typeof issue>[], label: (number: number) => string = () => 'bug') {
  const calls: string[][] = [];
  const poller = new GithubPoller({ run: async (_exe, args) => {
    calls.push([...args]);
    const path = args.find(arg => arg.includes('/timeline'));
    if (path) {
      const number = Number(path.split('/').at(-2));
      return JSON.stringify([{ id: number, event: 'labeled', created_at: at(90), label: { name: label(number) } }]);
    }
    const page = Number(args.find(arg => arg.startsWith('page='))?.slice(5) ?? 1);
    const size = Number(args.find(arg => arg.startsWith('per_page='))!.slice(9));
    return JSON.stringify({ items: items.slice((page - 1) * size, page * size) });
  } });
  return { poller, calls };
}
function scheduler(store: AutomationStore, poller: GithubPoller, launched: number[], fail = false) {
  return new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
    github: { owner: 'acme', repo: 'demo', poller }, launch: async (_rule, candidate) => {
      if (fail) throw new Error('launch failed');
      launched.push(candidate.number); return { runId: `run-${candidate.number}` };
    },
  });
}

it.each([false, true])('counts only unhandled matching issues and resumes after restart (history=%s)', async includeExisting => {
  const { store, rule } = await setup(includeExisting, 2);
  const { poller, calls } = provider(Array.from({ length: 105 }, (_, i) => issue(i + 1)));
  // A receipt from an older definition still owns the issue, regardless of event ID.
  for (let number = 1; number <= 100; number++) {
    store.reserveReceipt({ automationId: rule.id, revision: rule.revision, eventId: `old-${number}`,
      candidate: { ...issue(number), repo: 'acme/demo', nodeId: `I_${number}`, url: issue(number).html_url,
        eventId: `old-${number}`, event: 'issue.opened', timestamp: at(10), tieBreaker: `I_${number}`,
        author: 'alice', assignees: [], labels: ['bug'] } });
  }
  const launched: number[] = [];
  for (let check = 0; check < 30 && launched.length < 5; check++) {
    const reopened = AutomationStore.open(store.dataDir);
    const before = launched.length;
    const requests = calls.length;
    await scheduler(reopened, poller, launched).check(rule);
    expect(launched.length - before).toBeLessThanOrEqual(2);
    expect(calls.length - requests).toBeLessThanOrEqual(11);
  }
  expect(launched).toEqual([101, 102, 103, 104, 105]);
  expect(calls.some(args => args.includes('page=2'))).toBe(true);
});

it('drains dense unrelated overlap before a new matching issue', async () => {
  const { store, rule } = await setup(false, 1);
  const { poller } = provider(Array.from({ length: 31 }, (_, i) => issue(i + 1)), n => n < 31 ? 'other' : 'bug');
  const launched: number[] = [];
  for (let check = 0; check < 10 && !launched.length; check++) {
    await scheduler(AutomationStore.open(store.dataDir), poller, launched).check(rule);
  }
  expect(launched).toEqual([31]);
});

it('uses the new-work limit after excluding events before activation', async () => {
  const { store, rule } = await setup(false, 1);
  const { poller } = provider([issue(1), issue(2)]);
  store.setState(rule.id, current => ({ ...current, baselineAt: at(95) }));
  const launched: number[] = [];
  await scheduler(store, poller, launched).check(rule);
  expect(launched).toEqual([]);
  expect(store.latestReceipts().size).toBe(0);
});

it('keeps a failed launch retryable without advancing discovery', async () => {
  const { store, rule } = await setup(false, 1);
  const { poller } = provider([issue(1), issue(2)]);
  const launched: number[] = [];
  await expect(scheduler(store, poller, launched, true).check(rule)).rejects.toThrow('launch failed');
  expect(store.state(rule.id)?.historyScan).toBeUndefined();
  expect(store.state(rule.id)?.cursor?.timestamp).toBe(at(100));
  expect([...store.latestReceipts().values()][0]?.status).toBe('launch-error');
});

it('recovers a scan past 100 timeline events without losing the activation baseline', async () => {
  const { store, rule } = await setup(false, 1);
  store.setState(rule.id, current => ({ ...current, baselineAt: at(50) }));
  const timeline = Array.from({ length: 112 }, (_, index) => ({
    id: index + 1, event: 'labeled', created_at: at(60 + index / 10),
    label: { name: index === 110 ? 'bug' : 'other' },
  }));
  const poller = new GithubPoller({ run: async (_exe, args) => {
    const path = args.find(arg => arg.includes('/timeline'));
    if (!path) return JSON.stringify({ items: [issue(1), issue(2)] });
    if (path.includes('/issues/2/')) {
      return JSON.stringify([{ id: 200, event: 'labeled', created_at: at(10), label: { name: 'bug' } }]);
    }
    const page = Number(args.find(arg => arg.startsWith('page='))!.slice(5));
    return JSON.stringify(timeline.slice((page - 1) * 100, page * 100));
  } });
  const launched: number[] = [];
  await scheduler(store, poller, launched).check(rule);
  expect(launched).toEqual([1]);
  expect(store.state(rule.id)?.historyScan?.event).toBe(111);

  const reopened = AutomationStore.open(store.dataDir);
  expect(reopened.state(rule.id)?.baselineAt).toBe(at(50));
  expect(reopened.state(rule.id)?.historyScan?.event).toBe(111);
  await scheduler(reopened, poller, launched).check(rule);
  expect(launched).toEqual([1]);
  expect(reopened.state(rule.id)?.historyScan).toBeUndefined();
  expect(reopened.state(rule.id)?.baselineAt).toBe(at(50));
});

it.each([
  { event: 'issue.opened' as const, changed: 'label' },
  { event: 'issue.opened' as const, changed: 'assignee' },
  { event: 'issue.labeled' as const, changed: 'label' },
  { event: 'issue.labeled' as const, changed: 'assignee' },
])('does not skip a shifted $event issue after an earlier issue loses its $changed', async ({ event, changed }) => {
  const { store, rule: original } = await setup(false, 1);
  const rule = store.update(original.id, original.revision, { ...original, events: [event],
    filters: { ...original.filters, allLabels: ['bug'], assignees: ['alice'] },
  }) as GithubAutomationDefinition;
  store.setState(rule.id, () => ({ revision: rule.revision, baselineAt: at(0) }));
  const items = [1, 2, 3].map(number => ({ ...issue(number), created_at: at(number * 10),
    updated_at: at(number * 10), assignees: [{ login: 'alice' }],
  }));
  const poller = new GithubPoller({ run: async (_exe, args) => {
    const path = args.find(arg => arg.includes('/timeline'));
    if (path) {
      const number = Number(path.split('/').at(-2));
      return JSON.stringify([{ id: number, event: 'labeled', created_at: at(number * 10), label: { name: 'bug' } }]);
    }
    const query = args.find(arg => arg.startsWith('q='))!;
    const matches = items.filter(item => {
      return (!query.includes('label:') || item.labels.some(label => label.name === 'bug'))
        && (!query.includes('assignee:') || item.assignees.some(assignee => assignee.login === 'alice'));
    });
    const sort = args.includes('sort=updated') ? 'updated_at' : 'created_at';
    matches.sort((a, b) => a[sort].localeCompare(b[sort]));
    return JSON.stringify({ items: matches });
  } });
  const launched: number[] = [];
  await scheduler(store, poller, launched).check(rule);
  expect(launched).toEqual([1]);
  if (changed === 'label') items[0]!.labels = [];
  else items[0]!.assignees = [];
  items[0]!.updated_at = at(200);
  await scheduler(AutomationStore.open(store.dataDir), poller, launched).check(rule);
  expect(launched).toEqual([1, 2]);
  await scheduler(AutomationStore.open(store.dataDir), poller, launched).check(rule);
  expect(launched).toEqual([1, 2, 3]);
});

it('audits a later matching event for a handled issue without charging the new-work cap', async () => {
  const { store, rule } = await setup(false, 1);
  const candidate = { repo: 'acme/demo', nodeId: 'I_1', number: 1, title: 'Issue', url: issue(1).html_url,
    eventId: 'old-opened', event: 'issue.opened' as const, timestamp: at(10), tieBreaker: 'I_1',
    author: 'alice', assignees: [], labels: ['bug'] };
  const receipt = store.reserveReceipt({ automationId: rule.id, revision: rule.revision, eventId: candidate.eventId, candidate })!;
  store.appendReceipt({ ...receipt, status: 'launched', runId: 'old-run', updatedAt: at(20) });
  const { poller } = provider([issue(1), issue(2)]);
  const launched: number[] = [];
  const reopened = AutomationStore.open(store.dataDir);
  await scheduler(reopened, poller, launched).check(rule);
  expect(launched).toEqual([2]);
  expect(reopened.logs({ automationId: rule.id }).filter(row => row.result === 'duplicate')).toEqual([
    expect.objectContaining({ event: 'issue.labeled', githubNumber: 1, runId: 'old-run', reason: expect.stringContaining('old-run') }),
  ]);
  expect(reopened.latestReceipts().size).toBe(2);
});
