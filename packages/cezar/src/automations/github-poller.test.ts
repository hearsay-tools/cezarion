import { describe, expect, it, vi } from 'vitest';
import {
  buildSearchQuery,
  GithubPoller,
  matchesFilters,
  reconstructLabelEvents,
} from './github-poller.ts';
import type { GithubAutomationDefinition } from './types.ts';

const definition: GithubAutomationDefinition = {
  id: 'one', revision: 1, name: 'Issues', enabled: true, kind: 'github',
  events: ['issue.opened'], intervalSeconds: 300,
  filters: { lookbackDays: 7, maxRecords: 25 },
  task: { prompt: 'Review {{github.url}}' },
  createdAt: '2026-07-26T00:00:00.000Z', updatedAt: '2026-07-26T00:00:00.000Z',
};
const item = {
  id: 1, node_id: 'I_one', number: 7, title: 'A\u0000 title',
  html_url: 'https://github.com/acme/demo/issues/7',
  created_at: '2026-07-26T01:00:00.000Z', updated_at: '2026-07-26T01:00:00.000Z',
  user: { login: 'alice' }, assignees: [{ login: 'bob' }], labels: [{ name: 'bug' }],
  repository_url: 'https://api.github.com/repos/acme/demo',
};

describe('GithubPoller', () => {
  it('uses a fixed executable and argument array and rejects foreign repository rows', async () => {
    const run = vi.fn(async () => JSON.stringify({ items: [item, { ...item, node_id: 'foreign', repository_url: 'https://api.github.com/repos/evil/demo' }] }));
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition);
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['api', '--method', 'GET', '/search/issues']));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ repo: 'acme/demo', number: 7, title: 'A  title' });
  });

  it('drains opened and label-event searches independently in oldest-first order', async () => {
    const pullRequest = {
      ...item,
      node_id: 'PR_one',
      number: 8,
      html_url: 'https://github.com/acme/demo/pull/8',
      pull_request: {},
    };
    const run = vi.fn(async (_executable: string, args: readonly string[]) => {
      const query = args.find((arg) => arg.startsWith('q=')) ?? '';
      if (args.some((arg) => arg.includes('/timeline'))) {
        return JSON.stringify([
          {
            id: 1,
            event: 'labeled',
            created_at: '2026-07-20T02:00:00.000Z',
            label: { name: 'triage' },
          },
          {
            id: 9,
            event: 'labeled',
            created_at: '2026-07-26T02:00:00.000Z',
            label: { name: 'triage' },
          },
        ]);
      }
      return JSON.stringify({ items: [query.includes('is:pr') ? pullRequest : item] });
    });
    const result = await new GithubPoller({ run }).poll('acme', 'demo', {
      ...definition,
      events: ['pull_request.opened', 'issue.labeled'],
      filters: { ...definition.filters, changedLabels: ['triage'] },
    }, { since: '2026-07-25T23:58:00.000Z' });

    expect(result.candidates.map((candidate) => candidate.event)).toEqual([
      'pull_request.opened',
      'issue.labeled',
    ]);
    expect(result.cursor).toEqual({
      timestamp: '2026-07-26T02:00:00.000Z',
      tieBreaker: '9',
    });
    const searchCalls = run.mock.calls.filter(([, args]) => args.includes('/search/issues'));
    expect(searchCalls).toHaveLength(2);
    expect(searchCalls[0]?.[1]).toEqual(expect.arrayContaining([
      'sort=created',
      'order=asc',
      expect.stringContaining('created:>=2026-07-25T23:58:00.000Z'),
    ]));
    expect(searchCalls[1]?.[1]).toEqual(expect.arrayContaining([
      'sort=updated',
      'order=asc',
      expect.stringContaining('updated:>=2026-07-25T23:58:00.000Z'),
    ]));
  });

  it('builds activity-specific queries for opened and label-event drains', () => {
    expect(buildSearchQuery('acme', 'demo', definition, 'issues', 'created', '2026-07-25T00:00:00.000Z'))
      .toContain('created:>=2026-07-25T00:00:00.000Z');
    expect(buildSearchQuery('acme', 'demo', definition, 'issues', 'updated', '2026-07-25T00:00:00.000Z'))
      .toContain('updated:>=2026-07-25T00:00:00.000Z');
  });

  it('advances its scan cursor across locally filtered rows', async () => {
    const run = vi.fn(async () => JSON.stringify({ items: [item] }));
    const result = await new GithubPoller({ run }).poll('acme', 'demo', {
      ...definition,
      filters: { ...definition.filters, excludeLabels: ['bug'] },
    });
    expect(result.candidates).toEqual([]);
    expect(result.cursor).toEqual({
      timestamp: item.created_at,
      tieBreaker: item.node_id,
    });
  });

  it('resumes both historical sources and intra-item label events without exceeding the record cap', async () => {
    vi.useFakeTimers({ now: Date.parse('2026-07-27T00:00:00.000Z'), toFake: ['Date'] });
    const start = '2026-07-25T00:00:00.000Z';
    const rule = { ...definition, events: ['issue.opened', 'issue.labeled'] as const, filters: { ...definition.filters, includeExisting: true, maxRecords: 1, excludeLabels: ['ignored'] } };
    const run = vi.fn(async (_exe: string, args: readonly string[]) => {
      if (args.some((arg) => arg.includes('/timeline'))) return JSON.stringify([
        { id: 1, event: 'labeled', created_at: '2026-07-26T02:00:00.000Z', label: { name: 'bug' } },
        { id: 2, event: 'labeled', created_at: '2026-07-26T03:00:00.000Z', label: { name: 'urgent' } },
      ]);
      return JSON.stringify({ items: [{ ...item, labels: [{ name: 'bug' }, { name: 'urgent' }] }] });
    });
    const poller = new GithubPoller({ run });
    let historyScan;
    const events: string[] = [];
    try {
    for (let index = 0; index < 4; index++) {
      const result = await poller.poll('acme', 'demo', { ...rule, events: [...rule.events] }, { since: start, historyScan });
      expect(result.candidates.length).toBeLessThanOrEqual(1);
      expect(result.pages).toBeLessThanOrEqual(10);
      events.push(...result.candidates.map((candidate) => candidate.eventId));
      historyScan = result.historyScan;
      if (!historyScan) break;
      expect(result.cursor).toBeUndefined();
    }
    expect(events).toHaveLength(3);
    expect(new Set(events).size).toBe(3);
    expect(historyScan).toBeUndefined();
    expect(run.mock.calls.filter(([, args]) => args.includes('/search/issues')).map(([, args]) => args.find((arg) => arg.startsWith('q=')))).toEqual(expect.arrayContaining([expect.stringContaining('created:<='), expect.stringContaining('updated:>=2026-07-20')]));
    expect(run.mock.calls.filter(([, args]) => args.includes('/search/issues')).map(([, args]) => args.find((arg) => arg.startsWith('q='))).filter((query) => query?.includes('updated:')).every((query) => !query?.includes('updated:<='))).toBe(true);
    } finally { vi.useRealTimers(); }
  });

  it('keeps label history independent of a recent opened cursor and post-window issue activity', async () => {
    const now = Date.now();
    const since = new Date(now - 3_600_000).toISOString();
    const transition = new Date(now - 2 * 86_400_000).toISOString();
    const rule = { ...definition, events: ['issue.opened', 'issue.labeled'] as const, filters: { ...definition.filters, includeExisting: true } };
    const poller = new GithubPoller({ run: async (_exe, args) => {
      if (args.some((arg) => arg.includes('/timeline'))) return JSON.stringify([{ id: 1, event: 'labeled', created_at: transition, label: { name: 'bug' } }]);
      const query = args.find((arg) => arg.startsWith('q='))!;
      return JSON.stringify({ items: query.includes('updated:') ? [{ ...item, updated_at: new Date(now + 86_400_000).toISOString() }] : [] });
    } });
    const result = await poller.poll('acme', 'demo', { ...rule, events: [...rule.events] }, { since });
    expect(result.candidates.map((candidate) => candidate.timestamp)).toEqual([transition]);
    // A future comment must not move the opened watermark past unscanned new issues.
    expect(result.cursor).toBeUndefined();
    expect(result.truncated).toBe(false);
  });

  it('makes progress across locally excluded historical rows', async () => {
    const rule = { ...definition, filters: { ...definition.filters, includeExisting: true, maxRecords: 1, excludeLabels: ['ignored'] } };
    const poller = new GithubPoller({ run: async () => JSON.stringify({ items: [{ ...item, labels: [{ name: 'ignored' }] }, { ...item, number: 8, node_id: 'I_two' }] }) });
    const first = await poller.poll('acme', 'demo', rule, { since: '2026-07-25T00:00:00.000Z' });
    expect(first.candidates).toEqual([]);
    expect(first.historyScan).toBeDefined();
    const second = await poller.poll('acme', 'demo', rule, { historyScan: first.historyScan });
    expect(second.candidates.map((candidate) => candidate.number)).toEqual([8]);
    expect(second.truncated).toBe(false);
  });

  it('reports provider search limits instead of marking an unvisited historical page complete', async () => {
    const rule = { ...definition, filters: { ...definition.filters, includeExisting: true, maxRecords: 100 } };
    const poller = new GithubPoller({ run: async () => JSON.stringify({ items: Array.from({ length: 100 }, () => item) }) });
    await expect(poller.poll('acme', 'demo', rule, { historyScan: { since: '2026-07-25T00:00:00.000Z', until: '2026-07-27T00:00:00.000Z', source: 0, page: 10, item: 0, event: 0 } })).rejects.toThrow('1000-item limit');
  });

  it('repeats all/any/exclude/author/assignee filters locally', () => {
    const candidate = { eventId: 'e', event: 'issue.opened' as const, timestamp: item.created_at, tieBreaker: 'I', repo: 'acme/demo', nodeId: 'I', number: 7, title: 'x', url: item.html_url, author: 'alice', assignees: ['bob'], labels: ['bug', 'urgent'] };
    expect(matchesFilters(candidate, { ...definition, filters: { ...definition.filters, authors: ['alice'], assignees: ['bob'], allLabels: ['bug'], anyLabels: ['urgent'], excludeLabels: ['wontfix'] } })).toBe(true);
    expect(matchesFilters(candidate, { ...definition, filters: { ...definition.filters, excludeLabels: ['bug'] } })).toBe(false);
  });

  it('reconstructs pre-event labels for removals and stable transition identities', () => {
    const rows = reconstructLabelEvents('acme', 'demo', item, [{ id: 9, event: 'unlabeled', created_at: '2026-07-26T02:00:00.000Z', label: { name: 'triage' } }]);
    expect(rows[0]).toMatchObject({ event: 'issue.unlabeled', changedLabel: 'triage', labels: expect.arrayContaining(['triage']) });
    expect(rows[0]?.eventId).toContain('issue.unlabeled:9');
  });
});
