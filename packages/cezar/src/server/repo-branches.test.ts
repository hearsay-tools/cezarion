import { randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { BranchClass } from '@open-mercato/cezar-contract';
import { createOwnedWorkspace } from '../delegation/workspace.ts';
import type { RunRecord, RunStatus } from '../runs/store.ts';
import { getTracking } from './git.ts';
import {
  attributeLog,
  classifyBranches,
  deleteBranches,
  type BranchForge,
  type ClassifyInput,
  type ForgePr,
} from './repo-branches.ts';
import { getLogWithParents } from './git.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', [...GIT_ID, ...args], { cwd })).stdout.trim();
}

async function commit(cwd: string, file: string, message: string): Promise<string> {
  writeFileSync(join(cwd, file), `${message}\n`);
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A task branch forked from `from` with `commits` commits of its own; leaves `main` checked out. */
async function taskBranch(cwd: string, name: string, commits: number, from = 'main'): Promise<string> {
  await git(cwd, 'checkout', '-q', '-b', name, from);
  for (let i = 0; i < commits; i++) await commit(cwd, `${name.replace('/', '-')}-${i}.txt`, `${name} work ${i}`);
  const tip = await git(cwd, 'rev-parse', 'HEAD');
  await git(cwd, 'checkout', '-q', 'main');
  return tip;
}

function runRecord(id: string, status: RunStatus, extra: Partial<RunRecord> = {}): RunRecord {
  return {
    id,
    title: `task ${id.slice(0, 4)}`,
    workflow: 'quick-task',
    task: 't',
    status,
    steps: [],
    createdAt: '2026-09-01T00:00:00.000Z',
    archived: false,
    branch: `cez/${id.slice(0, 8)}`,
    ...extra,
  } as RunRecord;
}

/** A forge that answers from fixed tables and records what it was asked. */
function fakeForge(opts: { states?: Record<number, ForgePr['state']>; prs?: ForgePr[]; available?: boolean } = {}) {
  const calls = { prStates: 0, listPrs: 0 };
  const forge: BranchForge = {
    async prStates(_root, numbers) {
      calls.prStates++;
      if (opts.available === false) return { available: false, states: {} };
      return { available: true, states: Object.fromEntries(numbers.flatMap((n) => (opts.states?.[n] ? [[n, opts.states[n]]] : []))) };
    },
    async listPrs() {
      calls.listPrs++;
      if (opts.available === false) return { available: false, prs: [] };
      return { available: true, prs: opts.prs ?? [] };
    },
  };
  return { forge, calls };
}

/** A PR merged into main at `tip`; `onMain` is the commit the merge put on the base. */
function mergedPr(number: number, branch: string, tip: string, onMain: string): ForgePr {
  return {
    number,
    url: `https://github.com/acme/demo/pull/${number}`,
    headRefName: branch,
    baseRefName: 'main',
    headRefOid: tip,
    mergeCommitOid: onMain,
    state: 'merged',
  };
}

describe('the branch classifier (issue 08 §A)', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-branches-'));
    await git(root, 'init', '-q', '-b', 'main');
    await commit(root, 'base.txt', 'base');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  const input = (extra: Partial<ClassifyInput> = {}): ClassifyInput => ({
    root,
    runs: [],
    isActive: () => false,
    currentBranch: 'main',
    hasRemote: true,
    forge: fakeForge().forge,
    ...extra,
  });

  const classesOf = async (extra: Partial<ClassifyInput> = {}) => {
    const { payload } = await classifyBranches(input(extra));
    return { payload, cls: Object.fromEntries(payload.branches.map((b) => [b.name, b.class])) as Record<string, BranchClass> };
  };

  it('classifies not-landed, orphan, merged by ancestry, merged by PR state, and empty', async () => {
    const ids = { notLanded: 'aaaaaaaa-1', ancestry: 'cccccccc-1', squash: 'dddddddd-1', emptySha: 'eeeeeeee-1', emptyRef: 'ffffffff-1' };
    const forkSha = await git(root, 'rev-parse', 'HEAD');
    await taskBranch(root, 'cez/aaaaaaaa', 2);
    await taskBranch(root, 'cez/bbbbbbbb', 1);
    await taskBranch(root, 'cez/cccccccc', 1);
    await git(root, 'merge', '-q', '--no-ff', '-m', 'Merge cez/cccccccc', 'cez/cccccccc');
    const squashTip = await taskBranch(root, 'cez/dddddddd', 1);
    await git(root, 'branch', 'cez/eeeeeeee', forkSha);
    await git(root, 'branch', 'cez/ffffffff');
    // The base moves on, so the empty branches' tips are ancestors of main but not its tip. The
    // same commit stands in for #7's squash, which is what a squash merge puts on main.
    const squash = await commit(root, 'later.txt', 'later on main');

    const runs = [
      runRecord(ids.notLanded, 'done'),
      runRecord(ids.ancestry, 'done'),
      runRecord(ids.squash, 'done', { pullRequestUrl: 'https://github.com/acme/demo/pull/7' }),
      runRecord(ids.emptySha, 'failed', { baseBranch: forkSha }),
      runRecord(ids.emptyRef, 'cancelled', { baseBranch: 'main' }),
    ];
    const { forge, calls } = fakeForge({
      states: { 7: 'merged' },
      prs: [mergedPr(7, 'cez/dddddddd', squashTip, squash)],
    });
    const { payload, cls } = await classesOf({ runs, forge });

    expect(cls['cez/aaaaaaaa']).toBe('not-landed');
    expect(cls['cez/bbbbbbbb']).toBe('orphan');
    expect(cls['cez/cccccccc']).toBe('merged');
    expect(cls['cez/dddddddd']).toBe('merged');
    expect(cls['cez/eeeeeeee']).toBe('empty');
    expect(cls['cez/ffffffff']).toBe('empty');
    expect(calls.prStates).toBe(1);
    expect(payload.prStateKnown).toBe(true);
    expect(payload.counts).toEqual({ notLanded: 2, cleanup: 4 });

    const notLanded = payload.branches.find((b) => b.name === 'cez/aaaaaaaa');
    expect(notLanded).toMatchObject({ runId: ids.notLanded, runStatus: 'done', ahead: 2, pr: null });
    expect(notLanded?.diffStat).toEqual({ additions: 2, deletions: 0 });
    expect(payload.branches.find((b) => b.name === 'cez/bbbbbbbb')).toMatchObject({ runId: null, title: null, ahead: 1 });
    expect(payload.branches.find((b) => b.name === 'cez/dddddddd')?.pr).toEqual({
      number: 7, url: 'https://github.com/acme/demo/pull/7', state: 'merged',
    });
    // Diff stats are only computed for the rows that show them.
    expect(payload.branches.find((b) => b.name === 'cez/cccccccc')?.diffStat).toBeNull();
  });

  it('classifies a squash-merged orphan through the cached PR list', async () => {
    const tip = await taskBranch(root, 'cez/bbbbbbbb', 1);
    const squash = await commit(root, 'squash.txt', 'Squash cez/bbbbbbbb (#9)');
    const { forge, calls } = fakeForge({ prs: [mergedPr(9, 'cez/bbbbbbbb', tip, squash)] });
    const { cls } = await classesOf({ forge });
    expect(cls['cez/bbbbbbbb']).toBe('merged');
    expect(calls.listPrs).toBe(1);
  });

  it('a merged PR proves only the tip it merged, and only into this base', async () => {
    const otherBase = await taskBranch(root, 'cez/aaaaaaaa', 1);
    const created = await taskBranch(root, 'cez/bbbbbbbb', 1);
    const merged = await taskBranch(root, 'cez/cccccccc', 1);
    // Work added after the PR merged: the tip moved past the head GitHub merged.
    await git(root, 'checkout', '-q', 'cez/cccccccc');
    await commit(root, 'after.txt', 'after the merge');
    await git(root, 'checkout', '-q', 'main');
    const onMain = await git(root, 'rev-parse', 'main');
    const runs = [
      runRecord('aaaaaaaa-1', 'done'),
      runRecord('bbbbbbbb-1', 'done', { pullRequestUrl: 'https://github.com/acme/demo/pull/8' }),
      runRecord('cccccccc-1', 'done'),
    ];
    const { forge } = fakeForge({
      states: { 8: 'merged' },
      prs: [
        { ...mergedPr(7, 'cez/aaaaaaaa', otherBase, onMain), baseRefName: 'release' },
        { ...mergedPr(8, 'cez/bbbbbbbb', created, onMain), baseRefName: 'release' },
        mergedPr(9, 'cez/cccccccc', merged, onMain),
      ],
    });
    const { payload, cls } = await classesOf({ runs, forge });
    expect(cls).toMatchObject({ 'cez/aaaaaaaa': 'not-landed', 'cez/bbbbbbbb': 'not-landed', 'cez/cccccccc': 'not-landed' });
    // The PR is still shown for what it is; it just does not decide the class.
    expect(payload.branches.find((b) => b.name === 'cez/bbbbbbbb')?.pr?.state).toBe('merged');
    expect(payload.counts).toEqual({ notLanded: 3, cleanup: 0 });
  });

  it('a merged PR counts only while its merge commit is on the base as read', async () => {
    const tip = await taskBranch(root, 'cez/aaaaaaaa', 1);
    const before = await git(root, 'rev-parse', 'main');
    const squash = await commit(root, 'squash.txt', 'Squash cez/aaaaaaaa (#9)');
    const runs = [runRecord('aaaaaaaa-1', 'done')];
    const forge = fakeForge({ prs: [mergedPr(9, 'cez/aaaaaaaa', tip, squash)] }).forge;
    expect((await classesOf({ runs, forge })).cls['cez/aaaaaaaa']).toBe('merged');
    // main is reset (or force-pushed) back past the squash: the PR is history, the work is gone.
    await git(root, 'reset', '-q', '--hard', before);
    expect((await classesOf({ runs, forge })).cls['cez/aaaaaaaa']).toBe('not-landed');
    // A merged PR with no merge commit the base can show proves nothing either.
    const noMerge = fakeForge({ prs: [{ ...mergedPr(9, 'cez/aaaaaaaa', tip, squash), mergeCommitOid: null }] }).forge;
    expect((await classesOf({ runs, forge: noMerge })).cls['cez/aaaaaaaa']).toBe('not-landed');
  });

  it('shows the open PR at the current tip on a reused branch, not its old merged one', async () => {
    const oldTip = await taskBranch(root, 'cez/aaaaaaaa', 1);
    await git(root, 'checkout', '-q', 'cez/aaaaaaaa');
    const tip = await commit(root, 'more.txt', 'more work after the merge');
    await git(root, 'checkout', '-q', 'main');
    const squash = await commit(root, 'squash.txt', 'Squash cez/aaaaaaaa (#1)');
    const open: ForgePr = { ...mergedPr(2, 'cez/aaaaaaaa', tip, squash), mergeCommitOid: null, state: 'open' };
    const { forge } = fakeForge({ prs: [mergedPr(1, 'cez/aaaaaaaa', oldTip, squash), open] });
    const { payload, cls } = await classesOf({ runs: [runRecord('aaaaaaaa-1', 'done')], forge });
    expect(cls['cez/aaaaaaaa']).toBe('not-landed');
    expect(payload.branches.find((b) => b.name === 'cez/aaaaaaaa')?.pr).toMatchObject({ number: 2, state: 'open' });

    // The same when the task RECORDED #1 as its own PR: the record is history, #2 is current.
    const recorded = fakeForge({ states: { 1: 'merged' }, prs: [mergedPr(1, 'cez/aaaaaaaa', oldTip, squash), open] });
    const runs = [runRecord('aaaaaaaa-1', 'done', { pullRequestUrl: 'https://github.com/acme/demo/pull/1' })];
    const again = await classesOf({ runs, forge: recorded.forge });
    expect(again.cls['cez/aaaaaaaa']).toBe('not-landed');
    expect(again.payload.branches.find((b) => b.name === 'cez/aaaaaaaa')?.pr).toMatchObject({ number: 2, state: 'open' });
  });

  it('never classifies by prNumber — the PR a task is ABOUT is display-only', async () => {
    await taskBranch(root, 'cez/aaaaaaaa', 1);
    const { forge } = fakeForge({ states: { 12: 'merged' } });
    const { cls } = await classesOf({ runs: [runRecord('aaaaaaaa-1', 'done', { prNumber: 12 })], forge });
    expect(cls['cez/aaaaaaaa']).toBe('not-landed');
  });

  it('marks in-use branches active: live, review, owned, current, base, and checked out in a worktree', async () => {
    const base = await git(root, 'rev-parse', 'HEAD');
    await taskBranch(root, 'cez/11111111', 1);
    await taskBranch(root, 'cez/22222222', 1);
    await taskBranch(root, 'cez/33333333', 1);
    await taskBranch(root, 'cez/44444444', 1);
    await git(root, 'worktree', 'add', '-q', join(root, 'wt'), 'cez/44444444');
    // An owned delegation workspace, its checkout detached so ONLY the receipt protects the ref.
    const workerId = randomUUID();
    const workspace = await createOwnedWorkspace(root, workerId, base);
    await git(workspace.path, 'checkout', '-q', '--detach');
    await git(root, 'branch', 'topic');
    await git(root, 'checkout', '-q', 'topic');

    const { cls } = await classesOf({
      currentBranch: 'topic',
      configuredBase: 'main',
      runs: [
        runRecord('11111111-1', 'done'), // live by the manager, finished by the record
        runRecord('22222222-1', 'review'),
        runRecord('33333333-1', 'running', { activity: 'monitoring' }),
      ],
      isActive: (id) => id === '11111111-1',
    });
    expect(cls['cez/11111111']).toBe('active');
    expect(cls['cez/22222222']).toBe('active');
    expect(cls['cez/33333333']).toBe('active');
    expect(cls['cez/44444444']).toBe('active');
    expect(cls[workspace.branch]).toBe('active');
    expect(cls.topic).toBe('active');
    expect(cls.main).toBe('active');
  });

  it('calls a user branch other', async () => {
    await taskBranch(root, 'feature/login', 3);
    const { cls } = await classesOf();
    expect(cls['feature/login']).toBe('other');
  });

  it('without a forge, a squash-merged branch stays not-landed and prStateKnown is false', async () => {
    await taskBranch(root, 'cez/dddddddd', 1);
    const runs = [runRecord('dddddddd-1', 'done', { pullRequestUrl: 'https://github.com/acme/demo/pull/7' })];
    const offline = await classesOf({ runs, forge: fakeForge({ available: false }).forge });
    expect(offline.cls['cez/dddddddd']).toBe('not-landed');
    expect(offline.payload.prStateKnown).toBe(false);

    const { forge, calls } = fakeForge({ states: { 7: 'merged' } });
    const noRemote = await classesOf({ runs, hasRemote: false, forge });
    expect(noRemote.cls['cez/dddddddd']).toBe('not-landed');
    expect(noRemote.payload.prStateKnown).toBe(false);
    expect(calls.prStates + calls.listPrs).toBe(0);
  });

  it('does not report work merged on origin as not landed when the local base is stale', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'cez-branches-origin-'));
    try {
      await git(origin, 'init', '-q', '--bare', '-b', 'main');
      await git(root, 'remote', 'add', 'origin', origin);
      await git(root, 'push', '-q', '-u', 'origin', 'main');
      await taskBranch(root, 'cez/aaaaaaaa', 1);
      // The work lands on origin through another clone; the local main is never pulled.
      const other = mkdtempSync(join(tmpdir(), 'cez-branches-clone-'));
      await git(other, 'clone', '-q', origin, '.');
      await git(root, 'push', '-q', 'origin', 'cez/aaaaaaaa');
      await git(other, 'fetch', '-q', 'origin', 'cez/aaaaaaaa');
      await git(other, 'merge', '-q', '--no-ff', '-m', 'Merge task', 'FETCH_HEAD');
      await git(other, 'push', '-q', 'origin', 'main');
      rmSync(other, { recursive: true, force: true });
      await git(root, 'fetch', '-q', 'origin');

      const { payload, cls } = await classesOf({ runs: [runRecord('aaaaaaaa-1', 'done')] });
      expect(payload.base).toBe('origin/main');
      expect(cls['cez/aaaaaaaa']).toBe('merged');
    } finally {
      rmSync(origin, { recursive: true, force: true });
    }
  });

  it('anchors on the base BRANCH, never a same-named tag at an unlanded tip', async () => {
    const tip = await taskBranch(root, 'cez/aaaaaaaa', 1);
    // Unqualified, `main^{commit}` resolves to this tag before refs/heads/main.
    await git(root, 'tag', 'main', tip);
    const { payload, cls } = await classesOf({ runs: [runRecord('aaaaaaaa-1', 'done')] });
    expect(payload.base).toBe('main');
    expect(cls['cez/aaaaaaaa']).toBe('not-landed');
    expect(payload.branches.find((b) => b.name === 'cez/aaaaaaaa')?.ahead).toBe(1);
  });

  it('never lets a symbolic alias delete the branch it points at', async () => {
    const tip = await taskBranch(root, 'topic', 1);
    await git(root, 'symbolic-ref', 'refs/heads/cez/aaaaaaaa', 'refs/heads/topic');
    const { cls } = await classesOf();
    expect(cls).toMatchObject({ topic: 'other', 'cez/aaaaaaaa': 'other' });
    const result = await deleteBranches(input(), ['cez/aaaaaaaa'], 'cez/aaaaaaaa');
    expect(result.deleted).toEqual([]);
    expect(await git(root, 'rev-parse', 'refs/heads/topic')).toBe(tip);
    expect(await git(root, 'symbolic-ref', 'refs/heads/cez/aaaaaaaa')).toBe('refs/heads/topic');
  });

  it('with the main checkout detached and no base configured, the base is the checkout commit', async () => {
    await git(root, 'branch', 'cez/aaaaaaaa');
    const tip = await taskBranch(root, 'cez/bbbbbbbb', 1);
    await git(root, 'checkout', '-q', '--detach', 'main');
    const runs = [runRecord('aaaaaaaa-1', 'done'), runRecord('bbbbbbbb-1', 'done')];
    const { payload, cls } = await classesOf({ runs, currentBranch: 'HEAD' });
    expect(payload.base).toBe('HEAD');
    // Forked at the checkout and never committed: safe, like merged — not "the whole history is mine".
    expect(cls['cez/aaaaaaaa']).toBe('empty');
    expect(cls['cez/bbbbbbbb']).toBe('not-landed');
    expect(payload.branches.find((b) => b.name === 'cez/bbbbbbbb')?.ahead).toBe(1);
    expect((await deleteBranches(input({ runs, currentBranch: 'HEAD' }), ['cez/aaaaaaaa'])).deleted).toEqual(['cez/aaaaaaaa']);
    expect(await git(root, 'rev-parse', 'cez/bbbbbbbb')).toBe(tip);
  });

  it('an alias is never the ref that keeps a branch\'s commits, nor the base', async () => {
    // (a) The only "other" ref holding the fork commit is an alias for the task branch itself.
    await taskBranch(root, 'topic', 1);
    await git(root, 'branch', 'cez/aaaaaaaa', 'topic');
    await git(root, 'branch', '-D', 'topic');
    await git(root, 'symbolic-ref', 'refs/heads/witness', 'refs/heads/cez/aaaaaaaa');
    const runs = [runRecord('aaaaaaaa-1', 'done', { baseBranch: 'topic' })];
    expect((await classesOf({ runs })).cls['cez/aaaaaaaa']).toBe('not-landed');
    expect((await deleteBranches(input({ runs }), ['cez/aaaaaaaa'])).deleted).toEqual([]);

    // (b) The configured base is an alias for a task branch with work main lacks.
    await taskBranch(root, 'cez/bbbbbbbb', 1);
    await git(root, 'symbolic-ref', 'refs/heads/base-alias', 'refs/heads/cez/bbbbbbbb');
    const viaAlias = [runRecord('bbbbbbbb-1', 'done')];
    expect((await classesOf({ runs: viaAlias, configuredBase: 'base-alias' })).cls['cez/bbbbbbbb']).toBe('not-landed');
    expect((await deleteBranches(input({ runs: viaAlias, configuredBase: 'base-alias' }), ['cez/bbbbbbbb'])).deleted).toEqual([]);
  });

  it('names a task branch exactly when a tag shares its name', async () => {
    await taskBranch(root, 'cez/aaaaaaaa', 1);
    // `%(refname:short)` would spell the branch `heads/cez/aaaaaaaa` to disambiguate it from this tag.
    await git(root, 'tag', 'cez/aaaaaaaa', 'main');
    const runs = [runRecord('aaaaaaaa-1', 'done')];
    const { payload, cls } = await classesOf({ runs });
    expect(cls['cez/aaaaaaaa']).toBe('not-landed');
    expect(payload.branches.find((b) => b.name === 'cez/aaaaaaaa')).toMatchObject({ runId: 'aaaaaaaa-1', ahead: 1 });
    expect(payload.counts.notLanded).toBe(1);
    expect((await deleteBranches(input({ runs }), ['cez/aaaaaaaa'], 'cez/aaaaaaaa')).deleted).toEqual(['cez/aaaaaaaa']);
  });

  it('does not read an expired creation entry\'s survivor as the fork point', async () => {
    const tip = await taskBranch(root, 'cez/aaaaaaaa', 1);
    await git(root, 'branch', 'backup', tip);
    // Entries newest first: @{0} the task commit, @{1} the creation. Expire the creation.
    await git(root, 'reflog', 'delete', 'refs/heads/cez/aaaaaaaa@{1}');
    expect((await git(root, 'log', '-g', '--format=%H', 'refs/heads/cez/aaaaaaaa')).split('\n')).toEqual([tip]);
    const { cls } = await classesOf({ runs: [runRecord('aaaaaaaa-1', 'done', { baseBranch: 'main' })] });
    expect(cls['cez/aaaaaaaa']).toBe('not-landed');
  });

  describe('deleteBranches', () => {
    it('never lets two empty branches vouch for each other in one bulk delete', async () => {
      // Both fork from an unmerged topic tip with no commits of their own; then the topic goes.
      const tip = await taskBranch(root, 'topic', 1);
      await git(root, 'branch', 'cez/aaaaaaaa', 'topic');
      await git(root, 'branch', 'cez/bbbbbbbb', 'topic');
      await git(root, 'branch', '-D', 'topic');
      const runs = [runRecord('aaaaaaaa-1', 'done', { baseBranch: 'topic' }), runRecord('bbbbbbbb-1', 'done', { baseBranch: 'topic' })];
      const { cls } = await classesOf({ runs });
      expect(cls).toMatchObject({ 'cez/aaaaaaaa': 'empty', 'cez/bbbbbbbb': 'empty' });

      const bulk = await deleteBranches(input({ runs }), ['cez/aaaaaaaa', 'cez/bbbbbbbb']);
      expect(bulk.deleted).toEqual([]);
      expect(bulk.refused.map((r) => r.name).sort()).toEqual(['cez/aaaaaaaa', 'cez/bbbbbbbb']);
      // One at a time is fine while the other still holds the commit; the last one is then not-landed.
      expect((await deleteBranches(input({ runs }), ['cez/aaaaaaaa'])).deleted).toEqual(['cez/aaaaaaaa']);
      expect((await classesOf({ runs })).cls['cez/bbbbbbbb']).toBe('not-landed');
      expect(await git(root, 'rev-parse', 'cez/bbbbbbbb')).toBe(tip);
    });

    it('refuses a merged branch when the base moved after it was classified', async () => {
      const before = await git(root, 'rev-parse', 'main');
      const mergedTip = await taskBranch(root, 'cez/cccccccc', 1);
      await git(root, 'merge', '-q', '--no-ff', '-m', 'Merge', 'cez/cccccccc');
      await taskBranch(root, 'cez/aaaaaaaa', 1); // pending, so the forge is asked mid-classification
      const forge: BranchForge = {
        prStates: async () => ({ available: true, states: {} }),
        async listPrs() {
          // main is reset after its sha was read, before the delete: the merge is gone from it.
          await git(root, 'update-ref', 'refs/heads/main', before);
          return { available: true, prs: [] };
        },
      };
      const runs = [runRecord('cccccccc-1', 'done'), runRecord('aaaaaaaa-1', 'done')];
      const result = await deleteBranches(input({ runs, forge }), ['cez/cccccccc']);
      expect(result.deleted).toEqual([]);
      expect(result.refused[0]?.reason).toContain('changed since it was classified');
      expect(await git(root, 'rev-parse', 'cez/cccccccc')).toBe(mergedTip);
    });

    it('bulk deletes only merged and empty; a not-landed name in the bulk loses nothing', async () => {
      const notLandedTip = await taskBranch(root, 'cez/aaaaaaaa', 2);
      await taskBranch(root, 'cez/cccccccc', 1);
      await git(root, 'merge', '-q', '--no-ff', '-m', 'Merge', 'cez/cccccccc');
      await git(root, 'branch', 'cez/eeeeeeee');
      await taskBranch(root, 'cez/bbbbbbbb', 1);
      await git(root, 'branch', 'mine');
      const runs = [runRecord('aaaaaaaa-1', 'done'), runRecord('cccccccc-1', 'done'), runRecord('eeeeeeee-1', 'done', { baseBranch: 'main' })];

      const result = await deleteBranches(input({ runs }), ['cez/aaaaaaaa', 'cez/cccccccc', 'cez/eeeeeeee', 'cez/bbbbbbbb', 'mine', 'main'], 'cez/aaaaaaaa');
      expect(result.deleted.sort()).toEqual(['cez/cccccccc', 'cez/eeeeeeee']);
      expect(result.refused.map((r) => r.name).sort()).toEqual(['cez/aaaaaaaa', 'cez/bbbbbbbb', 'main', 'mine']);
      expect(result.dropped).toBeUndefined();
      // Everything refused is still there, untouched.
      expect(await git(root, 'rev-parse', 'cez/aaaaaaaa')).toBe(notLandedTip);
      const left = await git(root, 'branch', '--format=%(refname:short)');
      expect(left.split('\n').sort()).toEqual(['cez/aaaaaaaa', 'cez/bbbbbbbb', 'main', 'mine']);
    });

    it('deletes a not-landed or orphan branch only alone and with a matching confirm, naming the commits dropped', async () => {
      await taskBranch(root, 'cez/aaaaaaaa', 2);
      await taskBranch(root, 'cez/bbbbbbbb', 1);
      const runs = [runRecord('aaaaaaaa-1', 'done')];

      const unconfirmed = await deleteBranches(input({ runs }), ['cez/aaaaaaaa']);
      expect(unconfirmed.deleted).toEqual([]);
      const wrong = await deleteBranches(input({ runs }), ['cez/aaaaaaaa'], 'cez/aaaaaaa');
      expect(wrong.deleted).toEqual([]);

      const confirmed = await deleteBranches(input({ runs }), ['cez/aaaaaaaa'], 'cez/aaaaaaaa');
      expect(confirmed.deleted).toEqual(['cez/aaaaaaaa']);
      expect(confirmed.dropped?.map((c) => c.subject)).toEqual(['cez/aaaaaaaa work 1', 'cez/aaaaaaaa work 0']);

      const orphan = await deleteBranches(input({ runs }), ['cez/bbbbbbbb'], 'cez/bbbbbbbb');
      expect(orphan.deleted).toEqual(['cez/bbbbbbbb']);
    });

    it('never deletes active or other branches, whatever the confirm says', async () => {
      await taskBranch(root, 'cez/22222222', 1);
      await git(root, 'branch', 'mine');
      const runs = [runRecord('22222222-1', 'review')];
      for (const name of ['cez/22222222', 'mine', 'main']) {
        const result = await deleteBranches(input({ runs }), [name], name);
        expect(result.deleted).toEqual([]);
        expect(result.refused).toHaveLength(1);
      }
      expect((await git(root, 'branch', '--format=%(refname:short)')).split('\n').sort()).toEqual(['cez/22222222', 'main', 'mine']);
    });

    it('never deletes an owned delegation ref, even one whose run looks finished and merged', async () => {
      const base = await git(root, 'rev-parse', 'HEAD');
      const workerId = randomUUID();
      const workspace = await createOwnedWorkspace(root, workerId, base);
      await git(workspace.path, 'checkout', '-q', '--detach');
      const runs = [runRecord(workerId, 'done', { branch: workspace.branch })];
      const result = await deleteBranches(input({ runs }), [workspace.branch]);
      expect(result.deleted).toEqual([]);
      expect(await git(root, 'rev-parse', '--verify', workspace.branch)).toBe(base);
    });
  });
});

describe('tracking (issue 08 §B1)', () => {
  let root: string;
  let origin: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-tracking-'));
    origin = mkdtempSync(join(tmpdir(), 'cez-tracking-origin-'));
    await git(root, 'init', '-q', '-b', 'main');
    await commit(root, 'base.txt', 'base');
  });

  afterEach(() => {
    delete process.env.GIT_TRACE;
    rmSync(root, { recursive: true, force: true });
    rmSync(origin, { recursive: true, force: true });
  });

  it('is null when the base has no upstream', async () => {
    expect(await getTracking(root, 'main')).toBeNull();
  });

  it('counts ahead/behind against the last-fetched upstream without spawning a fetch', async () => {
    await git(origin, 'init', '-q', '--bare', '-b', 'main');
    await git(root, 'remote', 'add', 'origin', origin);
    await git(root, 'push', '-q', '-u', 'origin', 'main');
    const other = mkdtempSync(join(tmpdir(), 'cez-tracking-clone-'));
    await git(other, 'clone', '-q', origin, '.');
    await commit(other, 'a.txt', 'upstream 1');
    await commit(other, 'b.txt', 'upstream 2');
    await git(other, 'push', '-q', 'origin', 'main');
    rmSync(other, { recursive: true, force: true });
    await git(root, 'fetch', '-q', 'origin');
    await commit(root, 'local.txt', 'local only');

    // Every git process the call spawns inherits the trace; a `fetch` would be named in it.
    const trace = join(root, '..', `cez-trace-${randomUUID()}.log`);
    process.env.GIT_TRACE = trace;
    const tracking = await getTracking(root, 'main');
    delete process.env.GIT_TRACE;
    const log = readFileSync(trace, 'utf8');
    rmSync(trace, { force: true });

    expect(tracking).toMatchObject({ ref: 'origin/main', ahead: 1, behind: 2 });
    expect(tracking?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(log).toMatch(/rev-list/);
    expect(log).not.toMatch(/\bfetch\b/);
  });

  it('dates the freshness by the newest fetch in ANY worktree — agents fetch from theirs', async () => {
    const origin = mkdtempSync(join(tmpdir(), 'cez-tracking-origin-'));
    try {
      await git(origin, 'init', '-q', '--bare', '-b', 'main');
      await git(root, 'remote', 'add', 'origin', origin);
      await git(root, 'push', '-q', '-u', 'origin', 'main');
      const task = join(root, '..', `cez-tracking-wt-${randomUUID()}`);
      await git(root, 'worktree', 'add', '-q', '-b', 'cez/aaaaaaaa', task);
      try {
        // The main checkout never fetched; the task worktree just did.
        expect((await getTracking(root, 'main'))?.fetchedAt).toBeNull();
        await git(task, 'fetch', '-q', 'origin');
        expect((await getTracking(root, 'main'))?.fetchedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
      } finally {
        rmSync(task, { recursive: true, force: true });
      }
    } finally {
      rmSync(origin, { recursive: true, force: true });
    }
  });
});

describe('log source attribution (issue 08 §B5)', () => {
  let root: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-logsource-'));
    await git(root, 'init', '-q', '-b', 'main');
    await commit(root, 'base.txt', 'base');
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('credits a merge to the task its PR records, not a later branch sitting at the same tip', async () => {
    await taskBranch(root, 'cez/zzzzzzzz', 1);
    await git(root, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #41 from acme/cez/zzzzzzzz', 'cez/zzzzzzzz');
    await git(root, 'branch', 'cez/aaaaaaaa', 'cez/zzzzzzzz'); // a later task, forked at that tip
    await git(root, 'branch', '-D', 'cez/zzzzzzzz'); // cleaned up after merging
    const runs = [
      runRecord('zzzzzzzz-1', 'done', { title: 'the work', pullRequestUrl: 'https://github.com/acme/demo/pull/41' }),
      runRecord('aaaaaaaa-1', 'done', { title: 'later, empty' }),
    ];
    const log = await getLogWithParents(root);
    const sources = await attributeLog(root, log, runs);
    const merge = log.findIndex((entry) => entry.subject.startsWith('Merge pull request #41'));
    expect(sources[merge]).toEqual({ runId: 'zzzzzzzz-1', title: 'the work', prNumber: 41 });
  });

  it('maps every merge row by its second parent, not only the first one to ask', async () => {
    await taskBranch(root, 'cez/aaaaaaaa', 1);
    await taskBranch(root, 'cez/bbbbbbbb', 1);
    // Subjects that name no branch and no PR: only the second parent can attribute them.
    await git(root, 'merge', '-q', '--no-ff', '-m', 'land the first', 'cez/aaaaaaaa');
    await git(root, 'merge', '-q', '--no-ff', '-m', 'land the second', 'cez/bbbbbbbb');
    const runs = [runRecord('aaaaaaaa-1', 'done', { title: 'first' }), runRecord('bbbbbbbb-1', 'done', { title: 'second' })];
    const log = await getLogWithParents(root);
    const sources = await attributeLog(root, log, runs);
    const bySubject = Object.fromEntries(log.map((entry, i) => [entry.subject, sources[i]]));
    expect(bySubject['land the first']).toMatchObject({ runId: 'aaaaaaaa-1' });
    expect(bySubject['land the second']).toMatchObject({ runId: 'bbbbbbbb-1' });
  });

  it('maps a merge commit by its second parent and a squash commit by its (#N)', async () => {
    await taskBranch(root, 'cez/aaaaaaaa', 1);
    await git(root, 'merge', '-q', '--no-ff', '-m', 'Merge pull request #41 from acme/cez/aaaaaaaa', 'cez/aaaaaaaa');
    await commit(root, 'squash.txt', 'feat: the squashed task (#42)');
    await commit(root, 'hand.txt', 'chore: committed by hand (#99)');
    const runs = [
      runRecord('aaaaaaaa-1', 'done', { title: 'merged task' }),
      runRecord('bbbbbbbb-1', 'done', { title: 'squashed task', pullRequestUrl: 'https://github.com/acme/demo/pull/42' }),
    ];
    const log = await getLogWithParents(root);
    const sources = await attributeLog(root, log, runs);
    const bySubject = Object.fromEntries(log.map((entry, i) => [entry.subject, sources[i]]));
    expect(bySubject['Merge pull request #41 from acme/cez/aaaaaaaa']).toEqual({ runId: 'aaaaaaaa-1', title: 'merged task', prNumber: 41 });
    expect(bySubject['feat: the squashed task (#42)']).toEqual({ runId: 'bbbbbbbb-1', title: 'squashed task', prNumber: 42 });
    expect(bySubject['chore: committed by hand (#99)']).toBeNull();
    expect(bySubject['cez/aaaaaaaa work 0']).toBeNull();

    // The branch deleted after merging: the subject still names it.
    await git(root, 'branch', '-D', 'cez/aaaaaaaa');
    const again = await attributeLog(root, log, runs);
    expect(again[log.findIndex((e) => e.subject.startsWith('Merge pull request #41'))]).toMatchObject({ runId: 'aaaaaaaa-1' });
  });
});
