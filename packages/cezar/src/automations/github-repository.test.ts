import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { automationFailureNotice } from '@open-mercato/cezar-contract/automations';
import { GithubPoller, type GithubCandidate } from './github-poller.ts';
import { githubRepository, readUnderCanonicalName, type GithubRepository } from './github-repository.ts';
import { isRepositoryNameMiss } from '../server/forge/github-repo-handle.ts';
import { ProjectAutomationScheduler } from './scheduler.ts';
import { AutomationStore } from './store.ts';
import type { GithubAutomationDefinition } from './types.ts';

const dirs: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** What `gh api` throws for a search that names a renamed repository by its old name. */
function validationFailed(): Error {
  return Object.assign(new Error('Command failed: gh api --method GET /search/issues'), { stderr: 'gh: Validation Failed (HTTP 422)\n' });
}

describe('githubRepository', () => {
  it('reads under the name GitHub reports, and falls back to the origin URL text', async () => {
    const resolve = vi.fn(async () => ({ owner: 'acme', repo: 'squawk' }));
    const forget = vi.fn();
    const repository = githubRepository('/root', 'git@github.com:acme/cezarion.git', resolve, forget)!;
    expect(repository).toMatchObject({ owner: 'acme', repo: 'cezarion' });
    expect(await repository.canonical!()).toEqual({ owner: 'acme', repo: 'squawk' });
    expect(resolve).toHaveBeenCalledWith('/root', { owner: 'acme', repo: 'cezarion' });
    repository.forget!();
    expect(forget).toHaveBeenCalledWith('/root');
    resolve.mockResolvedValueOnce(null as never);
    expect(await repository.canonical!()).toEqual({ owner: 'acme', repo: 'cezarion' });
  });

  it('is undefined without a github.com remote', () => {
    expect(githubRepository('/root', undefined)).toBeUndefined();
    expect(githubRepository('/root', 'https://gitlab.com/acme/demo.git')).toBeUndefined();
  });
});

describe('readUnderCanonicalName', () => {
  const stale = (names: string[]): GithubRepository & { forgotten: number } => {
    const repository = {
      owner: 'acme', repo: 'cezarion', forgotten: 0,
      canonical: async () => ({ owner: 'acme', repo: names[Math.min(repository.forgotten, names.length - 1)]! }),
      forget: () => { repository.forgotten++; },
    };
    return repository;
  };

  it('asks for the name again after GitHub refuses the cached one, then reads once under the new name', async () => {
    const repository = stale(['cezarion', 'squawk']);
    const read = vi.fn(async ({ repo }: { repo: string }) => {
      if (repo === 'cezarion') throw validationFailed();
      return repo;
    });
    expect(await readUnderCanonicalName(repository, read)).toBe('squawk');
    expect(read.mock.calls.map(([name]) => name.repo)).toEqual(['cezarion', 'squawk']);
    expect(repository.forgotten).toBe(1);
  });

  it('rethrows when the name did not change, and never retries an unrelated failure', async () => {
    const unchanged = stale(['cezarion']);
    await expect(readUnderCanonicalName(unchanged, async () => { throw validationFailed(); })).rejects.toThrow('Command failed');
    expect(unchanged.forgotten).toBe(1);
    const other = stale(['cezarion', 'squawk']);
    const read = vi.fn(async () => { throw new Error('socket hang up'); });
    await expect(readUnderCanonicalName(other, read)).rejects.toThrow('socket hang up');
    expect(read).toHaveBeenCalledTimes(1);
    expect(other.forgotten).toBe(0);
  });

  it('classifies 404 and 422 answers as a name miss', () => {
    expect(isRepositoryNameMiss(validationFailed())).toBe(true);
    expect(isRepositoryNameMiss(new Error('gh: Not Found (HTTP 404)'))).toBe(true);
    expect(isRepositoryNameMiss(new Error("GraphQL: Could not resolve to a Repository with the name 'acme/cezarion'."))).toBe(true);
    expect(isRepositoryNameMiss(new Error('gh: Bad credentials (HTTP 401)'))).toBe(false);
    expect(isRepositoryNameMiss('HTTP 422')).toBe(false);
  });
});

describe('a GitHub poll after a repository rename', () => {
  const labeledAt = '2026-01-02T00:00:00Z';
  const issue = (repo: string) => ({
    node_id: 'I_7', number: 7, title: 'Main CI failed', html_url: `https://github.com/acme/${repo}/issues/7`,
    created_at: '2026-01-01T12:00:00Z', user: { login: 'bot' }, assignees: [], labels: [{ name: 'main-ci-failure' }],
    repository_url: `https://api.github.com/repos/acme/${repo}`,
  });

  async function setup() {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-rename-')); dirs.push(dir);
    const store = AutomationStore.open(dir);
    const definition = store.create({
      name: 'Main CI', enabled: true, events: ['issue.labeled'], intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25, changedLabels: ['main-ci-failure'] }, task: { prompt: 'Repair' },
    }, 'one') as GithubAutomationDefinition;
    store.setState(definition.id, (current) => ({ ...current, baselineAt: '2026-01-01T00:00:00.000Z', cursor: { timestamp: '2026-01-01T00:00:00.000Z' } }));
    const searches: string[] = [];
    // GitHub answers a search by the old name with HTTP 422; reads under the new name succeed.
    const poller = new GithubPoller({ run: async (_gh, args) => {
      if (args.includes('/search/issues')) {
        const query = args.find((arg) => arg.startsWith('q='))!;
        searches.push(query.split(' ')[0]!);
        if (query.startsWith('q=repo:acme/cezarion ')) throw validationFailed();
        return JSON.stringify({ items: [issue('squawk')] });
      }
      expect(args[3]).toBe('repos/acme/squawk/issues/7/timeline');
      return JSON.stringify([{ event: 'labeled', node_id: 'LE_1', created_at: labeledAt, label: { name: 'main-ci-failure' } }]);
    } });
    return { store, definition, searches, poller };
  }

  it('finds a newly labelled issue under the canonical name while origin keeps the old one', async () => {
    const { store, definition, searches, poller } = await setup();
    let forgotten = 0;
    const launched: GithubCandidate[] = [];
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: {
        // origin still names acme/cezarion; the cached canonical name is stale until forgotten.
        owner: 'acme', repo: 'cezarion', poller,
        canonical: async () => ({ owner: 'acme', repo: forgotten ? 'squawk' : 'cezarion' }),
        forget: () => { forgotten++; },
      },
      launch: async (_definition, candidate) => { launched.push(candidate); return { runId: 'repair' }; },
    });
    await scheduler.check(definition);
    expect(searches).toEqual(['q=repo:acme/cezarion', 'q=repo:acme/squawk']);
    expect(forgotten).toBe(1);
    expect(launched).toEqual([expect.objectContaining({ repo: 'acme/squawk', number: 7, event: 'issue.labeled', changedLabel: 'main-ci-failure' })]);
    expect(store.state(definition.id)).toMatchObject({ consecutiveFailures: 0 });
    expect(store.state(definition.id)?.lastError).toBeUndefined();
  });

  it('does not launch an issue again whose receipt was recorded under the old name', async () => {
    const { store, definition, poller } = await setup();
    const receipt = store.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId: 'acme/cezarion:I_7:issue.labeled:LE_0', candidate: {
      eventId: 'acme/cezarion:I_7:issue.labeled:LE_0', event: 'issue.labeled', timestamp: '2026-01-01T18:00:00Z', tieBreaker: 'LE_0',
      repo: 'acme/cezarion', nodeId: 'I_7', number: 7, title: 'Main CI failed', url: 'https://github.com/acme/cezarion/issues/7',
      author: 'bot', assignees: [], labels: ['main-ci-failure'], changedLabel: 'main-ci-failure',
    } })!;
    store.appendReceipt({ ...receipt, status: 'launched', runId: 'earlier', updatedAt: new Date().toISOString() });
    const launch = vi.fn(async () => ({ runId: 'again' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: { owner: 'acme', repo: 'squawk', poller }, launch });
    await scheduler.check(definition);
    expect(launch).not.toHaveBeenCalled();
    expect(store.logs({ automationId: definition.id })).toContainEqual(expect.objectContaining({ result: 'duplicate', runId: 'earlier', githubNumber: 7 }));
  });

  const renamed = (owner: string, repo: string, forgotten: () => number) => ({
    owner, repo: 'cezarion',
    canonical: async () => ({ owner, repo: forgotten() ? repo : 'cezarion' }),
  });

  it('retries with a clean acceptor, so a match seen before the failure still launches', async () => {
    const { store, definition } = await setup();
    let forgotten = 0;
    const labelled = (repo: string): GithubCandidate => ({ eventId: `acme/${repo}:I_9:issue.labeled:LE_9`, event: 'issue.labeled',
      timestamp: labeledAt, tieBreaker: 'LE_9', repo: `acme/${repo}`, nodeId: 'I_9', number: 9, title: 'Flaky', url: `https://github.com/acme/${repo}/issues/9`,
      author: 'bot', assignees: [], labels: ['main-ci-failure'], changedLabel: 'main-ci-failure' });
    // The first page accepted issue 9, then a later page under the old name failed with 422.
    const poll = vi.fn(async (_owner: string, repo: string, _definition: unknown, options: { accept?: (candidate: GithubCandidate) => boolean }) => {
      expect(options.accept!(labelled(repo))).toBe(true);
      if (repo === 'cezarion') throw validationFailed();
      return { candidates: [labelled(repo)], truncated: false, pages: 1 };
    });
    const launch = vi.fn(async () => ({ runId: 'repair' }));
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: { ...renamed('acme', 'squawk', () => forgotten), forget: () => { forgotten++; }, poller: { poll } as never }, launch });
    await scheduler.check(definition);
    expect(poll).toHaveBeenCalledTimes(2);
    expect(launch).toHaveBeenCalledTimes(1);
    expect(store.logs({ automationId: definition.id }).filter(row => row.result === 'duplicate')).toEqual([]);
  });

  it('does not launch a pull request again whose receipt was recorded under the old name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-rename-pr-')); dirs.push(dir);
    const store = AutomationStore.open(dir);
    const definition = store.create({ name: 'PRs', enabled: true, events: ['pull_request.opened'], intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'one') as GithubAutomationDefinition;
    store.setState(definition.id, (current) => ({ ...current, baselineAt: '2026-01-01T00:00:00.000Z' }));
    const opened = (repo: string): GithubCandidate => ({ eventId: `acme/${repo}:PR_4:pull_request.opened:${labeledAt}`, event: 'pull_request.opened',
      timestamp: labeledAt, tieBreaker: 'PR_4', repo: `acme/${repo}`, nodeId: 'PR_4', number: 4, title: 'Fix', url: `https://github.com/acme/${repo}/pull/4`,
      author: 'alice', assignees: [], labels: [] });
    const receipt = store.reserveReceipt({ automationId: definition.id, revision: definition.revision, eventId: opened('cezarion').eventId, candidate: opened('cezarion') })!;
    store.appendReceipt({ ...receipt, status: 'launched', runId: 'earlier', updatedAt: new Date().toISOString() });
    const accepted: boolean[] = [];
    const poll = vi.fn(async (_owner: string, repo: string, _definition: unknown, options: { accept?: (candidate: GithubCandidate) => boolean }) => {
      accepted.push(options.accept!(opened(repo)));
      return { candidates: [], truncated: false, pages: 1 };
    });
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: { owner: 'acme', repo: 'squawk', poller: { poll } as never }, launch: async () => ({ runId: 'again' }) });
    await scheduler.check(definition);
    expect(accepted).toEqual([false]);
  });
});

describe('repeated poll failures', () => {
  it('keep the last error on the state until a check succeeds, and show it from the third failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cezar-failures-')); dirs.push(dir);
    const store = AutomationStore.open(dir);
    const definition = store.create({ name: 'Issues', enabled: true, events: ['issue.opened'], intervalSeconds: 300,
      filters: { lookbackDays: 7, maxRecords: 25 }, task: { prompt: 'Review' } }, 'one') as GithubAutomationDefinition;
    let now = Date.parse('2026-11-11T18:17:00.000Z');
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    let fail = true;
    const poll = vi.fn(async () => {
      if (fail) throw validationFailed();
      return { candidates: [], truncated: false, pages: 1 };
    });
    const scheduler = new ProjectAutomationScheduler({ projectId: 'p', store, timeZone: 'UTC',
      github: { owner: 'acme', repo: 'demo', poller: { poll } as never }, launch: async () => ({ runId: 'unused' }) });
    const check = async () => { await scheduler.check(definition).catch(() => undefined); now += 60 * 60_000; };

    await check();
    await check();
    expect(store.state(definition.id)).toMatchObject({ consecutiveFailures: 2, lastError: 'Command failed: gh api --method GET /search/issues', lastErrorAt: '2026-11-11T19:17:00.000Z' });
    expect(automationFailureNotice(store.state(definition.id))).toBeUndefined();

    await check();
    expect(automationFailureNotice(store.state(definition.id))).toEqual({
      consecutiveFailures: 3, lastError: 'Command failed: gh api --method GET /search/issues',
      lastErrorAt: '2026-11-11T20:17:00.000Z', retryAt: '2026-11-11T20:21:00.000Z',
    });

    // A check refused during backoff counts, but keeps the error that caused the backoff.
    now = Date.parse('2026-11-11T20:18:00.000Z');
    await check();
    expect(store.state(definition.id)).toMatchObject({ consecutiveFailures: 4, lastError: 'Command failed: gh api --method GET /search/issues', lastErrorAt: '2026-11-11T20:17:00.000Z' });

    fail = false;
    now += 24 * 60 * 60_000;
    await check();
    const state = store.state(definition.id);
    expect(state?.consecutiveFailures).toBe(0);
    expect(state?.lastError).toBeUndefined();
    expect(state?.lastErrorAt).toBeUndefined();
  });
});
