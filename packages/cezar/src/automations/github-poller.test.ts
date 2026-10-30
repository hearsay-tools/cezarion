import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  beforeEach(() => vi.useFakeTimers({ now: Date.parse('2026-07-27T00:00:00.000Z'), toFake: ['Date'] }));
  afterEach(() => vi.useRealTimers());
  it('uses a fixed executable and argument array and rejects foreign repository rows', async () => {
    const run = vi.fn(async () => JSON.stringify({ items: [item, { ...item, node_id: 'foreign', repository_url: 'https://api.github.com/repos/evil/demo' }] }));
    const result = await new GithubPoller({ run }).poll('acme', 'demo', definition);
    expect(run).toHaveBeenCalledWith('gh', expect.arrayContaining(['api', '--method', 'GET', '/search/issues']));
    expect(result.candidates).toHaveLength(1);
    expect(result.candidates[0]).toMatchObject({ repo: 'acme/demo', number: 7, title: 'A  title' });
  });

  it('drains opened and label-event searches independently in stable creation order', async () => {
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
      'sort=created',
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

  it.each(['created', 'updated'] as const)('keeps mutable qualifiers out of %s search membership', activity => {
    const rule = { ...definition, filters: { ...definition.filters, allLabels: ['bug'], assignees: ['bob'], authors: ['alice'] } };
    const query = buildSearchQuery('acme', 'demo', rule, 'issues', activity);
    expect(query).toContain('author:alice');
    expect(query).not.toContain('label:');
    expect(query).not.toContain('assignee:');
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
    expect(first.candidates.map(candidate => candidate.number)).toEqual([8]);
    expect(first.historyScan).toBeUndefined();
    expect(first.truncated).toBe(false);
  });

  it.each([
    { includeExisting: true, event: 'issue.labeled' as const },
    { includeExisting: true, event: 'issue.unlabeled' as const },
    { includeExisting: false, event: 'issue.labeled' as const },
    { includeExisting: false, event: 'issue.unlabeled' as const },
  ])('matches past $event labels after removal (includeExisting=$includeExisting)', async ({ includeExisting, event }) => {
    const now = Date.now();
    const addedAt = new Date(now - 2 * 3_600_000).toISOString();
    const removedAt = new Date(now - 3_600_000).toISOString();
    const issue = { ...item, created_at: new Date(now - 3 * 3_600_000).toISOString(), updated_at: removedAt, labels: [] };
    const poller = new GithubPoller({ run: async (_exe, args) => {
      if (args.some((arg) => arg.includes('/timeline'))) return JSON.stringify([
        { id: 1, event: 'labeled', created_at: addedAt, label: { name: 'bug' } },
        { id: 2, event: 'unlabeled', created_at: removedAt, label: { name: 'bug' } },
      ]);
      // GitHub evaluates label qualifiers against current labels, which are empty.
      const query = args.find((arg) => arg.startsWith('q='))!;
      return JSON.stringify({ items: query.includes('label:') ? [] : [issue] });
    } });
    const result = await poller.poll('acme', 'demo', {
      ...definition,
      events: ['issue.opened', event],
      filters: { ...definition.filters, includeExisting, allLabels: ['bug'] },
    }, { since: new Date(now - 4 * 3_600_000).toISOString() });
    expect(result.candidates).toEqual([expect.objectContaining({
      event, number: 7, labels: ['bug'], changedLabel: 'bug',
      timestamp: event === 'issue.labeled' ? addedAt : removedAt,
    })]);
  });

  describe('mixed GitHub timelines (hearsay-tools/cezarion#1182)', () => {
    // Shapes from the issue timeline API: only labeled/unlabeled carry a label.
    const unrelated = (createdAt: string) => [
      { id: 101, node_id: 'IC_1', event: 'commented', created_at: createdAt, body: 'hi', user: { login: 'alice' } },
      { id: 102, node_id: 'AE_1', event: 'assigned', created_at: createdAt, assignee: { login: 'bob' } },
      { id: 103, node_id: 'CE_1', event: 'closed', created_at: createdAt, commit_id: null },
      { sha: 'abc', node_id: 'C_1', event: 'committed', message: 'fix' },
    ];
    const labelPoller = (timeline: unknown[], now: number) => {
      const issue = { ...item, created_at: new Date(now - 3 * 3_600_000).toISOString(), updated_at: new Date(now - 3_600_000).toISOString(), labels: [] };
      return new GithubPoller({ run: async (_exe, args) => args.some((arg) => arg.includes('/timeline'))
        ? JSON.stringify(timeline)
        : JSON.stringify({ items: [issue] }) });
    };
    const labelRule = (includeExisting: boolean): GithubAutomationDefinition => ({
      ...definition,
      events: ['issue.labeled', 'issue.unlabeled'],
      filters: { ...definition.filters, includeExisting },
    });

    it.each([false, true])('keeps label changes among comments, assignments and closures (includeExisting=%s)', async (includeExisting) => {
      const now = Date.now();
      const addedAt = new Date(now - 2 * 3_600_000).toISOString();
      const removedAt = new Date(now - 3_600_000).toISOString();
      const other = new Date(now - 90 * 60_000).toISOString();
      const [comment, assigned, closed, committed] = unrelated(other);
      const result = await labelPoller([
        { id: 1, node_id: 'LE_1', event: 'labeled', created_at: addedAt, label: { name: 'bug' } },
        comment, assigned,
        { id: 2, node_id: 'UE_1', event: 'unlabeled', created_at: removedAt, label: { name: 'bug' } },
        closed, committed,
      ], now).poll('acme', 'demo', labelRule(includeExisting), { since: new Date(now - 4 * 3_600_000).toISOString() });
      expect(result.candidates).toEqual([
        expect.objectContaining({ event: 'issue.labeled', changedLabel: 'bug', labels: ['bug'], timestamp: addedAt, eventId: 'acme/demo:I_one:issue.labeled:LE_1' }),
        expect.objectContaining({ event: 'issue.unlabeled', changedLabel: 'bug', labels: ['bug'], timestamp: removedAt, eventId: 'acme/demo:I_one:issue.unlabeled:UE_1' }),
      ]);
    });

    it.each([false, true])('reads a timeline with no label changes as no candidates (includeExisting=%s)', async (includeExisting) => {
      const now = Date.now();
      const result = await labelPoller(unrelated(new Date(now - 3_600_000).toISOString()), now)
        .poll('acme', 'demo', labelRule(includeExisting), { since: new Date(now - 4 * 3_600_000).toISOString() });
      expect(result.candidates).toEqual([]);
    });

    it.each([false, true])('names the issue and entry of a malformed label change (includeExisting=%s)', async (includeExisting) => {
      const now = Date.now();
      const at = new Date(now - 3_600_000).toISOString();
      const poll = labelPoller([unrelated(at)[0], { id: 3, event: 'labeled', created_at: at }], now)
        .poll('acme', 'demo', labelRule(includeExisting), { since: new Date(now - 4 * 3_600_000).toISOString() });
      await expect(poll).rejects.toThrow(/acme\/demo#7 timeline entry 1 \(labeled\).*label/);
    });

    // The timeline is oldest first, 100 per page: on a busy issue the newest label
    // changes, the ones a live poll wants, sit past the first page.
    const comments = (count: number, at: string, from = 0) => Array.from({ length: count }, (_, index) => (
      { id: 1_000 + from + index, event: 'commented', created_at: at, body: 'x' }));
    const pagedPoller = (issues: Array<{ number: number; nodeId: string; pages: (page: number) => unknown[] }>, now: number) => {
      const timelineCalls: Array<{ number: number; page: number }> = [];
      const poller = new GithubPoller({ run: async (_exe, args) => {
        const path = args.find((arg) => arg.includes('/timeline'));
        if (path) {
          const number = Number(path.split('/').at(-2));
          const page = Number(args.find((arg) => arg.startsWith('page='))?.slice(5) ?? '1');
          timelineCalls.push({ number, page });
          return JSON.stringify(issues.find((issue) => issue.number === number)!.pages(page));
        }
        return JSON.stringify({ items: issues.map((issue) => ({
          ...item, number: issue.number, node_id: issue.nodeId, labels: [{ name: 'bug' }],
          created_at: new Date(now - 3 * 3_600_000).toISOString(), updated_at: new Date(now - 3_600_000).toISOString(),
        })) });
      } });
      return { poller, timelineCalls };
    };

    it.each([false, true])('reads label changes past the first timeline page (includeExisting=%s)', async (includeExisting) => {
      const now = Date.now();
      const old = new Date(now - 30 * 86_400_000).toISOString();
      const at = new Date(now - 2 * 3_600_000).toISOString();
      const { poller, timelineCalls } = pagedPoller([{ number: 7, nodeId: 'I_one', pages: (page) => page === 1
        ? comments(100, old)
        : page === 2 ? [...comments(49, old, 100), { id: 5, node_id: 'LE_5', event: 'labeled', created_at: at, label: { name: 'bug' } }] : [] }], now);
      const result = await poller.poll('acme', 'demo', labelRule(includeExisting), { since: new Date(now - 4 * 3_600_000).toISOString() });
      expect(result.candidates).toEqual([expect.objectContaining({ event: 'issue.labeled', timestamp: at, eventId: 'acme/demo:I_one:issue.labeled:LE_5' })]);
      expect(timelineCalls.map((call) => call.page)).toEqual([1, 2]);
    });

    it('names the entry across pages when a later page holds a malformed label change', async () => {
      const now = Date.now();
      const at = new Date(now - 3_600_000).toISOString();
      const { poller } = pagedPoller([{ number: 7, nodeId: 'I_one', pages: (page) => page === 1
        ? comments(100, at)
        : page === 2 ? [{ id: 3, event: 'unlabeled', created_at: at }] : [] }], now);
      await expect(poller.poll('acme', 'demo', labelRule(false), { since: new Date(now - 4 * 3_600_000).toISOString() }))
        .rejects.toThrow('acme/demo#7 timeline entry 100 (unlabeled)');
    });

    it.each([false, true])('refuses a timeline longer than its page cap even when most entries are not label changes (includeExisting=%s)', async (includeExisting) => {
      const now = Date.now();
      const at = new Date(now - 3_600_000).toISOString();
      const { poller, timelineCalls } = pagedPoller([{ number: 7, nodeId: 'I_one', pages: (page) => [
        { id: page, event: 'labeled', created_at: at, label: { name: 'bug' } },
        ...comments(99, at, page * 100),
      ] }], now);
      await expect(poller.poll('acme', 'demo', labelRule(includeExisting), { since: new Date(now - 4 * 3_600_000).toISOString() }))
        .rejects.toThrow('acme/demo#7 has more label history than');
      // Live polls read the whole page cap; a history check also spends one request on its search.
      expect(timelineCalls).toHaveLength(includeExisting ? 9 : 10);
    });

    it('resumes an issue whose timeline does not fit the rest of a history check\'s request budget', async () => {
      const now = Date.now();
      const at = new Date(now - 2 * 3_600_000).toISOString();
      const fivePages = (id: number) => (page: number) => page < 5
        ? comments(100, at, page * 100)
        : page === 5 ? [{ id, node_id: `LE_${id}`, event: 'labeled', created_at: at, label: { name: 'bug' } }] : [];
      const { poller, timelineCalls } = pagedPoller([
        { number: 7, nodeId: 'I_one', pages: fivePages(1) },
        { number: 8, nodeId: 'I_two', pages: fivePages(2) },
      ], now);
      const since = new Date(now - 4 * 3_600_000).toISOString();
      const first = await poller.poll('acme', 'demo', labelRule(true), { since });
      expect(first.pages).toBeLessThanOrEqual(10);
      expect(first.candidates.map((candidate) => candidate.number)).toEqual([7]);
      expect(first.historyScan).toBeDefined();
      const second = await poller.poll('acme', 'demo', labelRule(true), { since, historyScan: first.historyScan });
      expect(second.pages).toBeLessThanOrEqual(10);
      expect(second.candidates.map((candidate) => candidate.number)).toEqual([8]);
      expect(second.historyScan).toBeUndefined();
      expect(timelineCalls.filter((call) => call.number === 8).at(-1)).toEqual({ number: 8, page: 5 });
    });
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

it.each([undefined, 'unknown'])('a fresh launch read cannot authorize an item with state %s', async (state) => {
  const poller = new GithubPoller({ run: async () => JSON.stringify({ state, labels: [{ name: 'bug' }] }) });
  const candidate = { eventId: 'e', event: 'issue.opened' as const, timestamp: item.created_at, tieBreaker: 'I',
    repo: 'acme/demo', nodeId: 'I', number: 7, title: 'x', url: item.html_url, author: 'alice', assignees: [], labels: ['bug'] };
  await expect(poller.matchesCurrentLabels(candidate, definition)).rejects.toThrow();
});

const filterCandidate = {
  eventId: 'e', event: 'issue.labeled' as const, timestamp: item.created_at, tieBreaker: 'I',
  repo: 'acme/demo', nodeId: 'I', number: 7, title: 'x', url: item.html_url,
  author: 'ALICE', assignees: ['other', 'BOB'], labels: ['BUG', 'urgent'], changedLabel: 'BUG',
};

it.each([
  { authors: ['carol'] },
  { assignees: ['carol'] },
  { allLabels: ['bug', 'missing'] },
  { anyLabels: ['missing'] },
  { excludeLabels: ['bug'] },
  { changedLabels: ['missing'] },
])('refuses a candidate that fails the local filter %j', filters => {
  expect(matchesFilters(filterCandidate, { ...definition, filters: { ...definition.filters, ...filters } })).toBe(false);
});

it.each([
  {},
  { authors: [], assignees: [], allLabels: [], anyLabels: [], excludeLabels: [], changedLabels: [] },
  { authors: ['alice'], assignees: ['bob'], allLabels: ['bug'], anyLabels: ['absent', 'URGENT'], excludeLabels: ['absent'], changedLabels: ['bug'] },
])('accepts case-insensitive filters and empty filter lists %j', filters => {
  expect(matchesFilters(filterCandidate, { ...definition, filters: { ...definition.filters, ...filters } })).toBe(true);
});

it('does not apply changed-label filters to an opened event', () => {
  const { changedLabel: _changedLabel, ...candidate } = filterCandidate;
  expect(matchesFilters({ ...candidate, event: 'issue.opened' }, {
    ...definition, filters: { ...definition.filters, changedLabels: ['missing'] },
  })).toBe(true);
});

it.each([
  { state: 'open', labels: ['bug'], allowed: true },
  { state: 'closed', labels: ['bug'], allowed: false },
  { state: 'open', labels: ['missing'], allowed: false },
])('checks fresh state and labels before launch: %j', async ({ state, labels, allowed }) => {
  const run = vi.fn(async () => JSON.stringify({ state, labels: labels.map(name => ({ name })) }));
  const candidate = { ...filterCandidate, labels: ['stale'] };
  const rule = { ...definition, filters: { ...definition.filters, allLabels: ['bug'], authors: ['alice'] } };
  expect(await new GithubPoller({ run }).matchesCurrentLabels(candidate, rule)).toBe(allowed);
  expect(run).toHaveBeenCalledExactlyOnceWith('gh', ['api', 'repos/acme/demo/issues/7']);
  expect(candidate.labels).toEqual(['stale']);
});

it.each(['mixed', 'issues', 'prs'] as const)('builds an exact %s query and strips unsafe author characters', family => {
  vi.useFakeTimers({ now: Date.parse('2026-07-27T12:00:00.000Z'), toFake: ['Date'] });
  try {
    const rule = { ...definition, filters: { ...definition.filters, authors: ['Ab_1.c-d+ :!/@', 'second'] } };
    const kind = family === 'mixed' ? '' : family === 'issues' ? ' is:issue' : ' is:pr';
    expect(buildSearchQuery('acme', 'demo', rule, family))
      .toBe(`repo:acme/demo${kind} created:>=2026-07-20 author:Ab_1.c-d author:second`);
  } finally {
    vi.useRealTimers();
  }
});

it('normalizes all visible opened-item fields and bounds control-free titles', async () => {
  const title = '\u0000\u001f\u007f' + 'x'.repeat(501);
  const run = async () => JSON.stringify({ items: [{ ...item, title, assignees: [{ login: 'first' }, { login: 'second' }], labels: [{ name: 'one' }, { name: 'two' }] }] });
  const result = await new GithubPoller({ run }).poll('acme', 'demo', definition, {
    historyScan: { since: item.created_at, until: item.created_at, source: 0, page: 1, item: 0, event: 0 },
  });
  expect(result).toEqual({
    candidates: [{
      eventId: `acme/demo:I_one:issue.opened:${item.created_at}`, event: 'issue.opened',
      timestamp: item.created_at, tieBreaker: 'I_one', repo: 'acme/demo', nodeId: 'I_one', number: 7,
      title: '   ' + 'x'.repeat(497), url: item.html_url, author: 'alice',
      assignees: ['first', 'second'], labels: ['one', 'two'],
    }],
    truncated: false, pages: 1, cursor: { timestamp: item.created_at, tieBreaker: 'I_one' },
  });
});

it('reconstructs schema-valid empty node identities and fallback identities in observation order', () => {
  const at = item.created_at;
  const rows = reconstructLabelEvents('acme', 'demo', { ...item, labels: [] }, [
    { node_id: '', id: 5, event: 'unlabeled', created_at: at, label: { name: 'BUG' } },
    { event: 'labeled', created_at: at, label: { name: 'BUG' } },
    { id: 9, event: 'unlabeled', created_at: '2026-07-26T02:00:00.000Z', label: { name: 'last' } },
  ]);
  expect(rows.map(row => ({ event: row.event, eventId: row.eventId, tieBreaker: row.tieBreaker, labels: row.labels }))).toEqual([
    { event: 'issue.unlabeled', eventId: 'acme/demo:I_one:issue.unlabeled:', tieBreaker: '', labels: ['last', 'BUG'] },
    { event: 'issue.labeled', eventId: `acme/demo:I_one:issue.labeled:${at}:bug`, tieBreaker: `${at}:bug`, labels: ['last', 'BUG'] },
    { event: 'issue.unlabeled', eventId: 'acme/demo:I_one:issue.unlabeled:9', tieBreaker: '9', labels: ['last'] },
  ]);
});

it('keeps a resumed scan immutable and filters timestamps at both inclusive bounds', async () => {
  const since = '2026-07-26T01:00:00.000Z';
  const until = '2026-07-26T02:00:00.000Z';
  const historyScan = { since, until, source: 0, page: 2, item: 1, event: 0 };
  const snapshot = structuredClone(historyScan);
  const times = ['2026-07-26T00:59:59.999Z', since, until, '2026-07-26T02:00:00.001Z'];
  const run = vi.fn(async () => JSON.stringify({ items: [item, ...times.map((created_at, index) => ({
    ...item, node_id: `I_${index}`, created_at,
  }))] }));
  const result = await new GithubPoller({ run }).poll('acme', 'demo', definition, { historyScan });
  expect(result.candidates.map(row => row.nodeId)).toEqual(['I_1', 'I_2']);
  expect(result.cursor).toEqual({ timestamp: until, tieBreaker: 'I_2' });
  expect(result.truncated).toBe(false);
  expect(historyScan).toEqual(snapshot);
  expect(run).toHaveBeenCalledExactlyOnceWith('gh', [
    'api', '--method', 'GET', '/search/issues', '-f',
    `q=repo:acme/demo is:issue created:>=${since} created:<=${until}`,
    '-f', 'per_page=100', '-f', 'page=2', '-f', 'sort=created', '-f', 'order=asc',
  ]);
});

it('keeps the latest cursor and sorts candidates by timestamp then identity', async () => {
  const later = '2026-07-26T02:00:00.000Z';
  const run = async () => JSON.stringify({ items: [
    { ...item, node_id: 'Z', created_at: later },
    { ...item, node_id: 'B' }, { ...item, node_id: 'A' },
  ] });
  const result = await new GithubPoller({ run }).poll('acme', 'demo', definition, {
    historyScan: { since: item.created_at, until: later, source: 0, page: 1, item: 0, event: 0 },
  });
  expect(result.candidates.map(row => row.nodeId)).toEqual(['A', 'B', 'Z']);
  expect(result.cursor).toEqual({ timestamp: later, tieBreaker: 'Z' });
});

it('advances a tied cursor by identity and retains an existing higher cursor', async () => {
  const run = async () => JSON.stringify({ items: [{ ...item, node_id: 'Z' }, { ...item, node_id: 'B' }] });
  const result = await new GithubPoller({ run }).poll('acme', 'demo', definition, {
    historyScan: { since: item.created_at, until: item.created_at, source: 0, page: 1, item: 0, event: 0,
      cursor: { timestamp: item.created_at, tieBreaker: 'A' } },
  });
  expect(result.cursor).toEqual({ timestamp: item.created_at, tieBreaker: 'Z' });
});

it('drains a full search page before requesting the next page', async () => {
  const run = vi.fn(async (_exe: string, args: readonly string[]) => JSON.stringify({
    items: args.includes('page=1') ? Array.from({ length: 100 }, (_, index) => ({ ...item, node_id: `I_${index}` })) : [item],
  }));
  const poller = new GithubPoller({ run });
  const rule = { ...definition, filters: { ...definition.filters, maxRecords: 100 } };
  const first = await poller.poll('acme', 'demo', rule, { since: item.created_at });
  expect(first.candidates).toHaveLength(100);
  expect(first.historyScan).toMatchObject({ source: 0, page: 2, item: 0, event: 0 });
  expect(first.cursor).toBeUndefined();
  const second = await poller.poll('acme', 'demo', rule, { historyScan: first.historyScan });
  expect(second.candidates).toHaveLength(1);
  expect(second.truncated).toBe(false);
  expect(run.mock.calls.map(([, args]) => args.find(arg => arg.startsWith('page=')))).toEqual(['page=1', 'page=2']);
});

it.each([false, true])('reports the exact label-history request bound (includeExisting=%s)', async includeExisting => {
  const run = async (_exe: string, args: readonly string[]) => args.some(arg => arg.includes('/timeline'))
    ? JSON.stringify(Array.from({ length: 100 }, () => ({ event: 'commented' })))
    : JSON.stringify({ items: [item] });
  await expect(new GithubPoller({ run }).poll('acme', 'demo', {
    ...definition, events: ['issue.labeled'], filters: { ...definition.filters, includeExisting },
  }, { since: item.created_at })).rejects.toThrow(
    `GitHub issue acme/demo#7 has more label history than one check reads (${includeExisting ? 900 : 1000} timeline entries); narrow the automation filters or process this item separately.`,
  );
});
