import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { runsIndexResponseSchema, runsSearchResponseSchema, type RunsIndexResponse } from '@open-mercato/cezar-contract';
import { readPersistedText, seedRuns } from '../runs/run-store.testkit.ts';
const resolveRepoHandle = vi.hoisted(() => vi.fn());
vi.mock('./forge/github.ts', async (importOriginal) => ({
  ...await importOriginal<typeof import('./forge/github.ts')>(),
  resolveRepoHandle,
}));

import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp, type ServerDeps } from './server.ts';
import { __seedRefStatusCacheForTests } from './forge/github.ts';

/**
 * `GET /api/v1/workspace/runs-index` — the ⌘K palette's cross-project task finder.
 *
 * The behaviours worth pinning are the ones a future change could quietly break: that a project
 * this process has never opened still contributes rows (read off disk), that reading them does
 * NOT build a context — which would prune worktrees and resume agents — and that the wire shape
 * stays slim, because the whole reason this route exists instead of N `/runs` calls is that
 * `RunRecord` carries `steps[]`.
 */

/** A stored record, written straight to a cold project's run database. */
function storedRun(over: Record<string, unknown> & { id: string; title: string }) {
  return {
    workflow: 'build',
    task: 'do the thing',
    status: 'done',
    createdAt: '2026-07-14T10:00:00Z',
    tokensUsed: 0,
    archived: false,
    steps: [{ id: 's1', name: 'work', kind: 'agent', status: 'done', iterations: 1, tokensUsed: 0 }],
    ...over,
  };
}

describe('workspace runs index API', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;

  beforeEach(() => {
    resolveRepoHandle.mockReset().mockResolvedValue(null);
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-runs-index-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-runs-index-boot-'));
    otherRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-runs-index-other-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    clearProjectProbeCache();
  });

  afterEach(() => {
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = savedHome;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  const makeApp = (over: Partial<ServerDeps> = {}) =>
    createApp({ repoRoot, store, manager: { finishBlockedReason: () => 'no open session' } as unknown as RunManager, version: '0.0.0-test', ...over });

  const getIndex = async (over: Partial<ServerDeps> = {}): Promise<RunsIndexResponse> => {
    const res = await apiRequest(makeApp(over), '/api/v1/workspace/runs-index');
    expect(res.status).toBe(200);
    return (await res.json()) as RunsIndexResponse;
  };

  /** Give `root` persisted runs without ever opening a store on it — a genuinely COLD project. */
  const seedColdProject = (root: string, runs: unknown[]) => {
    mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    seedRuns(join(root, '.ai/cezar'), runs);
  };

  it('answers an empty index for an empty registry — never a 404', async () => {
    const body = await getIndex();
    expect(body).toEqual({ runs: [], perProjectLimit: 200, truncated: [], referenceStatuses: {} });
  });

  it('merges the boot project’s live store with a cold project read off disk, newest first', async () => {
    const boot = await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    const live = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });
    store.updateRun(live.id, { createdAt: '2026-07-10T10:00:00Z' });
    seedColdProject(otherRoot, [
      storedRun({ id: 'cold-1', title: 'Cold task', createdAt: '2026-07-15T10:00:00Z' }),
    ]);

    const body = await getIndex();

    expect(body.runs.map((run) => run.id)).toEqual(['cold-1', live.id]);
    expect(body.runs.map((run) => run.projectId)).toEqual([other.id, boot.id]);
    expect(body.truncated).toEqual([]);
  });

  it('agrees with a cold read on a run this cezar cannot read, and opening it says why (#779)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    await registerProject(repoRoot);
    // Valid summaries, records this schema rejects: only decoding finds out.
    const steps = [{ id: 's1', name: 'work', kind: 'agent', status: 'bogus', iterations: 1, tokensUsed: 0 }];
    store.close();
    seedRuns(join(repoRoot, '.ai/cezar'), [
      storedRun({ id: 'ok', title: 'Readable' }),
      storedRun({ id: 'live-bad', title: 'Live', status: 'running', steps }),
      storedRun({ id: 'done-bad', title: 'Done', steps }),
    ]);
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    const ids = async () => (await getIndex()).runs.map((run) => run.id).sort();
    // The live row was read at open; a finished one is served from its summary until it is read.
    expect(await ids()).toEqual(['done-bad', 'ok']);

    const res = await apiRequest(makeApp(), '/api/v1/runs/done-bad');
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: expect.stringMatching(/could not be read by this cezar/) });
    expect(await ids()).toEqual(['ok']);
    const missing = await apiRequest(makeApp(), '/api/v1/runs/no-such-run');
    expect(await missing.json()).toEqual({ error: 'not found' });
  });

  it('never builds a project context — a search must not resume agents', async () => {
    await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    seedColdProject(otherRoot, [storedRun({ id: 'cold-1', title: 'Cold task' })]);
    const contexts = new ProjectContexts({ listProjects });

    const body = await getIndex({ contexts });

    expect(body.runs.map((run) => run.id)).toEqual(['cold-1']);
    // The row came from disk, and the project is still unopened: no store, no manager, no
    // `recover()`. This is the guarantee the whole read-only reader exists to provide.
    expect(contexts.peek(other.id)).toBeUndefined();
    expect(contexts.ids()).toEqual([]);
    contexts.disposeAll();
  });

  it('scopes cold rows after delayed discovery without opening or writing their project', async () => {
    await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    const foreignPr = 'https://github.com/foreign/repo/pull/42';
    const foreignIssue = 'https://github.com/foreign/repo/issues/43';
    seedColdProject(otherRoot, [storedRun({
      id: 'cold', title: 'Research', referencedPullRequestUrl: foreignPr,
      referencedIssueUrl: foreignIssue, issueNumber: 43, referencedIssueNumberSeeded: true,
      referencedPrCandidates: [foreignPr], referencedIssueCandidates: [foreignIssue],
    })]);
    const original = readPersistedText(join(otherRoot, '.ai/cezar'));
    let finish!: (handle: { owner: string; name: string }) => void;
    resolveRepoHandle.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const contexts = new ProjectContexts({ listProjects });
    const app = makeApp({ contexts });
    const request = async () => runsIndexResponseSchema.parse(
      await (await apiRequest(app, '/api/v1/workspace/runs-index')).json(),
    );

    // Both responses finish while the lookup is still pending; the second must not spawn again.
    expect((await request()).runs[0]?.referencedPullRequestUrl).toBe(foreignPr);
    await request();
    expect(resolveRepoHandle).toHaveBeenCalledTimes(1);
    expect(resolveRepoHandle.mock.calls[0]?.[0]).toBe(otherRoot);
    finish({ owner: 'local', name: 'repo' });
    await new Promise((resolve) => setImmediate(resolve));
    const row = (await request()).runs[0];
    expect(row?.referencedPullRequestUrl).toBeUndefined();
    expect(row?.referencedIssueUrl).toBeUndefined();
    expect(row?.issueNumber).toBeUndefined();
    expect(contexts.peek(other.id)).toBeUndefined();
    expect(contexts.ids()).toEqual([]);
    expect(existsSync(join(otherRoot, '.ai/cezar/runs'))).toBe(false);
    expect(readPersistedText(join(otherRoot, '.ai/cezar'))).toBe(original);
    contexts.disposeAll();
  });

  it.each(['unavailable', 'rejected'])('keeps cold references when identity is %s', async (failure) => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    const url = 'https://github.com/foreign/repo/pull/42';
    seedColdProject(otherRoot, [storedRun({ id: 'cold', title: 'Research', referencedPullRequestUrl: url })]);
    if (failure === 'rejected') resolveRepoHandle.mockRejectedValue(new Error('offline'));
    const app = makeApp();
    for (let i = 0; i < 2; i++) {
      const response = await apiRequest(app, '/api/v1/workspace/runs-index');
      expect(response.status).toBe(200);
      expect(runsIndexResponseSchema.parse(await response.json()).runs[0]?.referencedPullRequestUrl).toBe(url);
    }
    expect(resolveRepoHandle).toHaveBeenCalledTimes(1);
  });

  it('sends the slim row — no steps, and optional keys absent rather than null', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'cold-1',
        title: 'raw title',
        titleSummary: 'Nice summary',
        titleOrigin: 'auto',
        finishedAt: '2026-07-14T11:00:00Z',
        seenAt: '2026-07-14T12:00:00Z',
      }),
    ]);

    const body = await getIndex();

    const [row] = body.runs;
    expect(row).toEqual({
      projectId: expect.any(String),
      id: 'cold-1',
      title: 'raw title',
      titleSummary: 'Nice summary',
      titleOrigin: 'auto',
      status: 'done',
      createdAt: '2026-07-14T10:00:00Z',
      finishedAt: '2026-07-14T11:00:00Z',
      // The read receipt and the archive flag ride along so the palette can compute `isUnread`
      // for a project it is not standing in — the same inputs the Tasks badge reads.
      seenAt: '2026-07-14T12:00:00Z',
      archived: false,
      // The global Tasks page's own columns: always-present workflow, plus branch/startedAt
      // when the run has them (this one does not — see the absent-key assertions below).
      workflow: 'build',
      // The run summary (#817) the index row now extends: the list label and the token count.
      workflowLabel: 'build',
      tokensUsed: 0,
    });
    // The fat keys neither consumer has a use for never reach the wire — `workflow` rides along
    // as a plain string, `steps[]` and `workflowDef` (the expensive half) do not.
    expect(row).not.toHaveProperty('steps');
    expect(row).not.toHaveProperty('task');
    expect(row).not.toHaveProperty('workflowDef');
    // An absent optional is absent, not `undefined` — the wire has no such value.
    expect(Object.keys(row!)).not.toContain('activity');
    expect(Object.keys(row!)).not.toContain('branch');
    expect(Object.keys(row!)).not.toContain('startedAt');
    // …including every tracker-reference input and every usage field: an untracked, never-run
    // task carries none of them.
    for (const key of [
      'pullRequestUrl',
      'referencedPullRequestUrl',
      'prNumber',
      'issueNumber',
      'referencedIssueUrl',
      'markerRefs',
      'costUsd',
      'peakRssBytes',
      'peakProcCount',
      'usage',
    ]) {
      expect(Object.keys(row!), key).not.toContain(key);
    }
  });

  it('carries cost and the persisted usage peaks the cross-project table paints', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'measured',
        title: 'Measured',
        costUsd: 0.31,
        peakRssBytes: 943718400,
        peakProcCount: 4,
      }),
    ]);

    const body = await getIndex();
    const row = body.runs.find((entry) => entry.id === 'measured');

    expect(row).toMatchObject({ costUsd: 0.31, peakRssBytes: 943718400, peakProcCount: 4 });
    // The LIVE sample is not persisted, so a cold project's row never carries one.
    expect(Object.keys(row!)).not.toContain('usage');
  });

  it('carries the tracker-reference inputs so a cross-project row can show its PR/issue chip', async () => {
    // Verbatim, not pre-resolved: the rule that picks between them (#407, #526) lives in the
    // cockpit's `taskReference()`, and resolving it a second time here would be a second rule.
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'tracked',
        title: 'Ship it',
        branch: 'feat/ship',
        startedAt: '2026-07-14T10:00:05Z',
        pullRequestUrl: 'https://github.com/acme/demo/pull/42',
        prNumber: 42,
        markerRefs: { pr: 42 },
      }),
    ]);

    const body = await getIndex();
    const row = body.runs.find((entry) => entry.id === 'tracked');

    expect(row).toMatchObject({
      branch: 'feat/ship',
      startedAt: '2026-07-14T10:00:05Z',
      pullRequestUrl: 'https://github.com/acme/demo/pull/42',
      prNumber: 42,
      markerRefs: { pr: 42 },
    });
    // Still the slim row — the expensive half never rides along.
    expect(row).not.toHaveProperty('steps');
    expect(row).not.toHaveProperty('workflowDef');
  });

  it('includes archived runs — findable from a project is findable from anywhere', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({ id: 'live', title: 'Live', createdAt: '2026-07-14T11:00:00Z' }),
      storedRun({ id: 'filed', title: 'Archived', archived: true, createdAt: '2026-07-14T10:00:00Z' }),
    ]);

    const body = await getIndex();

    // The project-scoped `GET /runs` carries archived runs, so the cross-project finder must
    // too — otherwise a task disappears from search the moment you switch away from it.
    expect(body.runs.map((run) => run.id)).toEqual(['live', 'filed']);
  });

  it('caps each project\'s archived roots and names it in `truncated`, so no cap is silent', async () => {
    await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    // 210 archived roots > the 200 window (#864: unarchived runs are never cut). Ids sort with the
    // timestamps so the newest survivors are predictable.
    seedColdProject(
      otherRoot,
      Array.from({ length: 210 }, (_, i) => {
        const n = String(i).padStart(3, '0');
        const hour = String(10 + Math.floor(i / 60)).padStart(2, '0');
        const minute = String(i % 60).padStart(2, '0');
        return storedRun({ id: `r-${n}`, title: `Task ${n}`, createdAt: `2026-07-14T${hour}:${minute}:00Z`, archived: true });
      }),
    );

    const body = await getIndex();

    expect(body.runs).toHaveLength(200);
    expect(body.perProjectLimit).toBe(200);
    expect(body.truncated).toEqual([other.id]);
    // The NEWEST 200 survived, not the first 200 in file order.
    expect(body.runs[0]?.id).toBe('r-209');
    expect(body.runs.at(-1)?.id).toBe('r-010');
  });

  it('keeps parent wait phases and leaves workers out of a slim live/cold index without ownership resources', async () => {
    await registerProject(repoRoot); await registerProject(otherRoot);
    const workerId = '10000000-0000-4000-8000-000000000002';
    const live = store.createRun({ title: 'parent', task: 'parent', workflow: 'quick-task', steps: [] });
    const wait = { id: workerId, workerIds: [workerId], deadline: '2026-09-06T00:00:00.000Z', phase: 'parked' as const, outcomes: [] };
    store.updateRun(live.id, { status: 'waiting', delegation: { role: 'root', permissions: [], receipts: [], wait } });
    seedColdProject(otherRoot, [storedRun({ id: workerId, title: 'Worker', delegation: { role: 'worker', permissions: [], parentRunId: live.id, wait: { ...wait, workerIds: [], requestIds: [workerId] }, workspace: { kind: 'owned-isolated', ownerRunId: workerId, resourceId: workerId, path: '/managed/worker', branch: 'cez/worker', baselineSha: 'a'.repeat(40) } } }), storedRun({ id: 'ordinary', title: 'Ordinary' })]);
    const body = await getIndex();
    expect(body.runs.find(run => run.id === live.id)).toHaveProperty('delegation', { role: 'root', wait: { phase: 'parked', workerIds: [workerId], outcomes: [] } });
    // No worker rows at all (#864): no index reader lists workers, and a parent's wait label
    // comes from its own delegation, carried above.
    expect(body.runs.find(run => run.id === workerId)).toBeUndefined();
    expect(body.runs.filter(run => run.delegation?.role === 'worker')).toEqual([]);
    expect(body.runs.find(run => run.id === 'ordinary')).not.toHaveProperty('delegation');
    expect(runsIndexResponseSchema.parse(body)).toEqual(body);
    // Run ids are not ownership resources: since #817 the summary carries a worker's `parentRunId`
    // (a list lights the parent row) and a root wait's worker ids and reported ids (the counted
    // label). Paths, permissions, receipts and outcome details still never leave.
    expect(JSON.stringify(body)).not.toMatch(/receipts|workspace|permissions|managed|observedAt|deadline/);
  });

  it('carries pending human attention for hot and cold parked roots without opening the cold project', async () => {
    await registerProject(repoRoot);
    const other = await registerProject(otherRoot);
    const live = store.createRun({ title: 'Hot question', workflow: 'quick-task', task: 'task', steps: [] });
    const delegation = { role: 'root' as const, permissions: [], receipts: [], wait: { id: live.id, workerIds: [live.id], deadline: '2026-09-09T00:00:00.000Z', phase: 'parked' as const, outcomes: [] } };
    const question = { type: 'ask.requested', requestId: 'question', questions: [{ header: 'Choice', question: 'Which option?', options: [{ label: 'First' }, { label: 'Second' }] }] };
    store.updateRun(live.id, { status: 'waiting', delegation });
    store.appendEvent(live.id, question);
    seedColdProject(otherRoot, [storedRun({ id: 'cold-question', title: 'Cold question', status: 'waiting', delegation, hasPendingHumanAsk: false })]);
    mkdirSync(join(otherRoot, '.ai/cezar/runs'));
    writeFileSync(join(otherRoot, '.ai/cezar/runs/cold-question.ndjson'), JSON.stringify({ ...question, seq: 1, ts: new Date().toISOString() }) + '\n');
    const before = readPersistedText(join(otherRoot, '.ai/cezar'));
    const contexts = new ProjectContexts({ listProjects });
    const app = makeApp({ contexts });
    try {
      const body = runsIndexResponseSchema.parse(await (await apiRequest(app, '/api/v1/workspace/runs-index')).json());
      for (const id of [live.id, 'cold-question']) expect(body.runs.find(run => run.id === id)).toHaveProperty('hasPendingHumanAsk', true);
      const full = await (await apiRequest(app, `/api/v1/runs/${live.id}`)).json();
      expect(full).toHaveProperty('hasPendingHumanAsk', true);
      expect(contexts.peek(other.id)).toBeUndefined();
      expect(readPersistedText(join(otherRoot, '.ai/cezar'))).toBe(before);
    } finally { contexts.disposeAll(); }
  });

  it('carries `autoResumeAt`, so a usage-limit park does not read as a failure', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [
      storedRun({
        id: 'parked',
        title: 'Waiting out the limit',
        status: 'failed',
        finishedAt: '2026-07-14T11:00:00Z',
        autoResumeAt: '2026-07-14T15:00:00Z',
      }),
    ]);

    const body = await getIndex();

    // `deriveAttention` and `isUnread` both read this field. Dropping it from the slim row would
    // make the palette paint a red "failed" dot on work that is merely waiting for its slot.
    expect(body.runs[0]).toMatchObject({
      id: 'parked',
      status: 'failed',
      autoResumeAt: '2026-07-14T15:00:00Z',
    });
  });

  it('reads a crashed process’s `running` row as interrupted, exactly as opening it would', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    seedColdProject(otherRoot, [storedRun({ id: 'ghost', title: 'Ghost', status: 'running' })]);

    const body = await getIndex();

    // Shared with `RunStore.open` through `reconcileLoadedRun`: a task cannot read as running in
    // the palette and failed the moment it is opened.
    expect(body.runs[0]?.status).toBe('failed');
  });

  it('skips a project whose folder is gone and degrades a corrupt index to no rows', async () => {
    await registerProject(repoRoot);
    await registerProject(otherRoot);
    mkdirSync(join(otherRoot, '.ai/cezar'), { recursive: true });
    // Never migrated, so the legacy file is what the cold reader parses.
    writeFileSync(join(otherRoot, '.ai/cezar/runs.json'), '{ not json', 'utf8');
    const live = store.createRun({ title: 'Boot task', workflow: 'build', task: 't', steps: [] });

    const body = await getIndex();

    // One unreadable project costs its own rows, never the whole workspace's search.
    expect(body.runs.map((run) => run.id)).toEqual([live.id]);
  });

  /**
   * Statuses ride along with the rows that carry the references, so the chips are coloured in the
   * same paint as the table rather than a round trip later. The rule that makes it free — and
   * therefore safe on a route the palette hits — is that it reads the ref-status cache and NEVER
   * asks the forge.
   */
  describe('reference statuses', () => {
    it('ships an empty map when the server has looked nothing up', async () => {
      await registerProject(repoRoot);
      const run = store.createRun({ title: 'Has a PR', workflow: 'build', task: 't', steps: [] });
      store.updateRun(run.id, { pullRequestUrl: 'https://github.com/acme/demo/pull/42' });

      const body = await getIndex();

      // Present but empty — never absent, so a consumer can read it without a guard, and never
      // invented, so a cold reference stays "nothing known" rather than a guessed status.
      expect(body.referenceStatuses).toEqual({});
      expect(body.runs.some((row) => row.id === run.id)).toBe(true);
    });

    it('ships what the cache holds, keyed by project', async () => {
      await registerProject(repoRoot);
      const run = store.createRun({ title: 'Has a PR', workflow: 'build', task: 't', steps: [] });
      store.updateRun(run.id, {
        pullRequestUrl: 'https://github.com/acme/demo/pull/42',
        issueNumber: 7,
      });
      // Warm the cache the way the lazy route would have.
      __seedRefStatusCacheForTests(realpathSync(repoRoot), [
        [42, { kind: 'pr', status: 'merged' }],
        [7, { kind: 'issue', status: 'open' }],
      ]);

      const body = await getIndex();

      const project = Object.keys(body.referenceStatuses)[0]!;
      expect(body.referenceStatuses[project]).toEqual({ prs: { 42: 'merged' }, issues: { 7: 'open' } });
    });

    it('looks up every number a run MENTIONS, not just the one its chip will show', async () => {
      // Which reference is displayed is the cockpit's rule (#407, #526) and is deliberately not
      // re-derived here. A cache read costs nothing per number, so the superset is free — and it
      // is what lets the client apply its own rule to whatever it gets.
      await registerProject(repoRoot);
      const run = store.createRun({ title: 'Several', workflow: 'build', task: 't', steps: [] });
      store.updateRun(run.id, {
        pullRequestUrl: 'https://github.com/acme/demo/pull/42',
        referencedPullRequestUrl: 'https://github.com/acme/demo/pull/40',
        referencedIssueUrl: 'https://github.com/acme/demo/issues/12',
      });
      __seedRefStatusCacheForTests(realpathSync(repoRoot), [
        [42, { kind: 'pr', status: 'merged' }],
        [40, { kind: 'pr', status: 'ready' }],
        [12, { kind: 'issue', status: 'completed' }],
      ]);

      const body = await getIndex();

      const project = Object.keys(body.referenceStatuses)[0]!;
      expect(body.referenceStatuses[project]).toEqual({
        prs: { 40: 'ready', 42: 'merged' },
        issues: { 12: 'completed' },
      });
    });
  });
  /**
   * The live incident behind #864: a project's newest 200 rows were mostly archived workers, so
   * an older waiting root fell out of the index and the rail never said Needs You. The window
   * carries every unarchived run and leaves archived workers out, for an owned project and a cold
   * one alike.
   */
  describe('the window (#864)', () => {
    const PARENT = '10000000-0000-4000-8000-0000000000aa';
    /** Minute `n` after a fixed start, so a larger `n` is newer. */
    const at = (n: number) => new Date(Date.UTC(2026, 9, 1) + n * 60_000).toISOString();
    const workerDelegation = (id: string) => ({
      role: 'worker', parentRunId: PARENT, permissions: [],
      workspace: { ownerRunId: id, resourceId: id, kind: 'owned-isolated', path: `/managed/${id}`, branch: `cez/${id}`, baselineSha: '0'.repeat(40) },
    });
    const incident = () => [
      storedRun({ id: 'old-waiting', title: 'File an issue', status: 'waiting', hasPendingHumanAsk: true, createdAt: at(0) }),
      ...Array.from({ length: 250 }, (_, i) => storedRun({ id: `arch-${i}`, title: `Archived ${i}`, archived: true, createdAt: at(10 + i * 2) })),
      ...Array.from({ length: 300 }, (_, i) => {
        const id = `10000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
        return storedRun({ id, title: `Worker ${i}`, archived: true, createdAt: at(11 + i * 2), delegation: workerDelegation(id) });
      }),
    ];
    const expectWindow = (body: RunsIndexResponse, projectId: string) => {
      const rows = body.runs.filter((run) => run.projectId === projectId);
      expect(rows.map((run) => run.id)).toContain('old-waiting');
      expect(rows.filter((run) => run.delegation?.role === 'worker')).toEqual([]);
      expect(rows.filter((run) => run.archived)).toHaveLength(200);
      expect(body.truncated).toContain(projectId);
    };

    it('keeps an old waiting root of a cold project behind newer archived roots and workers', async () => {
      await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      seedColdProject(otherRoot, incident());
      expectWindow(await getIndex(), other.id);
    });

    it('keeps an old waiting root of the owned boot project too', async () => {
      const boot = await registerProject(repoRoot);
      store.close();
      seedRuns(join(repoRoot, '.ai/cezar'), incident());
      store = RunStore.open(join(repoRoot, '.ai/cezar'));
      expectWindow(await getIndex(), boot.id);
    });
  });

  /**
   * `GET /api/v1/workspace/runs-search` (#864) — what lets ⌘K reach a run past a project's window.
   * Same source rule and the same side-effect-free contract as the index.
   */
  describe('workspace run search', () => {
    const search = async (query: string, over: Partial<ServerDeps> = {}) => {
      const res = await apiRequest(makeApp(over), `/api/v1/workspace/runs-search${query}`);
      return { status: res.status, body: await res.json() as unknown };
    };
    const ids = (body: unknown) => runsSearchResponseSchema.parse(body).runs.map((run) => run.id);
    const oldAndMany = () => [
      storedRun({ id: 'oldest', title: 'Bound the run lists', archived: true, createdAt: '2025-01-01T00:00:00Z', prNumber: 870, issueNumber: 864 }),
      ...Array.from({ length: 205 }, (_, i) => storedRun({ id: `newer-${i}`, title: `Newer ${i}`, archived: true, createdAt: `2026-07-14T10:${String(i % 60).padStart(2, '0')}:${String(Math.floor(i / 60)).padStart(2, '0')}Z` })),
      storedRun({
        id: '10000000-0000-4000-8000-0000000000bb', title: 'Bound the run lists, worker', archived: true, createdAt: '2025-01-02T00:00:00Z',
        delegation: { role: 'worker', parentRunId: '10000000-0000-4000-8000-0000000000aa', permissions: [], workspace: { ownerRunId: '10000000-0000-4000-8000-0000000000bb', resourceId: '10000000-0000-4000-8000-0000000000cc', kind: 'owned-isolated', path: '/m', branch: 'cez/w', baselineSha: '0'.repeat(40) } },
      }),
    ];

    it('finds a cold project\'s run older than its newest 200 by title, PR and issue, never a worker', async () => {
      await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      seedColdProject(otherRoot, oldAndMany());
      const index = await getIndex();
      expect(index.runs.map((run) => run.id)).not.toContain('oldest');

      for (const query of ['?q=bound%20lists', '?q=%23870', '?q=864']) {
        const { status, body } = await search(query);
        expect(status, query).toBe(200);
        expect(ids(body), query).toEqual(['oldest']);
        expect(runsSearchResponseSchema.parse(body).runs[0]?.projectId).toBe(other.id);
      }
    });

    it('finds runs in the owned boot project too', async () => {
      await registerProject(repoRoot);
      const run = store.createRun({ title: 'Boot needle', workflow: 'build', task: 't', steps: [] });
      store.setArchived(run.id, true);
      expect(ids((await search('?q=needle')).body)).toEqual([run.id]);
    });

    it('caps each project and names it in `truncated`', async () => {
      await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      seedColdProject(otherRoot, oldAndMany());
      const { body } = await search('?q=newer&limit=2');
      expect(runsSearchResponseSchema.parse(body)).toMatchObject({ runs: [{}, {}], truncated: [other.id] });
    });

    it('refuses a query shorter than two characters and a limit over 50', async () => {
      for (const query of ['', '?q=a', '?q=%20a%20', '?q=ab&limit=51']) {
        const { status, body } = await search(query);
        expect(status, query).toBe(400);
        expect(body).toHaveProperty('error');
      }
    });

    it('degrades an unreadable project to no rows, never a 500', async () => {
      await registerProject(repoRoot);
      await registerProject(otherRoot);
      mkdirSync(join(otherRoot, '.ai/cezar'), { recursive: true });
      writeFileSync(join(otherRoot, '.ai/cezar/runs.db'), 'not a database');
      const run = store.createRun({ title: 'Still here', workflow: 'build', task: 't', steps: [] });
      expect(ids((await search('?q=still')).body)).toEqual([run.id]);
    });

    it('skips an owned project whose store throws, never a 500 (index and search alike)', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      onTestFinished(() => warn.mockRestore());
      await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      seedColdProject(otherRoot, [storedRun({ id: 'cold-needle', title: 'Cold needle' })]);
      vi.spyOn(store, 'searchRunSummaries').mockImplementation(() => { throw new Error('database is locked'); });
      // Only the windowed read the index makes; the app's own boot lists every run.
      const list = store.listRunSummaries.bind(store);
      vi.spyOn(store, 'listRunSummaries').mockImplementation((options) => {
        if (options?.archivedWindow !== undefined) throw new Error('database is locked');
        return list(options);
      });
      const found = await search('?q=needle');
      expect(found.status).toBe(200);
      expect(ids(found.body)).toEqual(['cold-needle']);
      const index = await getIndex();
      expect(index.runs.map((run) => run.projectId)).toEqual([other.id]);
    });

    it('treats a token that names a project as satisfied in that project, as the palette does', async () => {
      await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      seedColdProject(otherRoot, [storedRun({ id: 'cold-db', title: 'Database migration' })]);
      const projectToken = other.name.toLowerCase().split(/[^a-z0-9]+/).filter((part) => part.length >= 3).pop()!;
      const { status, body } = await search(`?q=${encodeURIComponent(`${projectToken} database`)}`);
      expect(status).toBe(200);
      expect(ids(body)).toEqual(['cold-db']);
    });

    it('never builds a project context', async () => {
      await registerProject(repoRoot);
      const other = await registerProject(otherRoot);
      seedColdProject(otherRoot, [storedRun({ id: 'cold-1', title: 'Cold needle' })]);
      const contexts = new ProjectContexts({ listProjects });
      expect(ids((await search('?q=needle', { contexts })).body)).toEqual(['cold-1']);
      expect(contexts.peek(other.id)).toBeUndefined();
      expect(contexts.ids()).toEqual([]);
      contexts.disposeAll();
    });

    it('is workspace-level only: no project-scoped spelling', async () => {
      await registerProject(repoRoot);
      const res = await apiRequest(makeApp(), '/api/v1/p/default/workspace/runs-search?q=ab');
      expect(res.status).toBe(404);
    });
  });
});
