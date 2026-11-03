import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { run, GIT_ID, TURN_TEXT } from './run-fixture.testkit.ts';
describe('TurnBookkeeper.recordTurnEnd', () => {
  const savedAutoname = process.env.CEZ_AUTONAME;
  beforeAll(() => {
    process.env.CEZ_AUTONAME = '0';
  });
  afterAll(() => {
    if (savedAutoname === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoname;
  });
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeAll(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-turnend-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'one\ntwo\nthree\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterAll(async () => {
    await drainFixtureManagers(repoRoot);
    manager.dispose();
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A run with a real worktree forked off main, holding an edit + a new file. */
  async function makeWorktreeRun(): Promise<RunRecord> {
    const record = store.createRun({ title: 'fix the login bug', workflow: 'quick-task', task: 'fix the login bug', steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    store.updateRun(record.id, { worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch });
    writeFileSync(join(wt.path, 'a.txt'), 'one\nTWO\nthree\n'); // 1 add, 1 del
    writeFileSync(join(wt.path, 'new.txt'), 'x\ny\n'); // 2 adds, untracked
    return store.getRun(record.id) as RunRecord;
  }

  it('computes a real diffStat and never derives a title from turn text', async () => {
    const record = await makeWorktreeRun();
    await runInternals(manager).turnBookkeeper.recordTurnEnd(record.id, TURN_TEXT);

    const after = store.getRun(record.id);
    // The agent's words are not a title source (they produced "Reading the
    // handoff…"-class titles) — naming is the namer's job, or the user's.
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.diffStat).toEqual({ adds: 3, dels: 1, files: 2 });

    // Second turn: the diff stat keeps refreshing.
    writeFileSync(join(store.getRun(record.id)!.worktreePath!, 'more.txt'), 'z\n');
    await runInternals(manager).turnBookkeeper.recordTurnEnd(record.id, 'Now I rewrote everything from scratch with a different approach.');
    const later = store.getRun(record.id);
    expect(later?.titleSummary).toBeUndefined();
    expect(later?.diffStat).toEqual({ adds: 4, dels: 1, files: 3 });
  });

  /**
   * #751: `recordTurnEnd` is the ONE place `RunRecord.diffStat` is written, so it
   * is also the one place `run.branch` has to reach `worktreeShortstat` — without
   * it, a review/QA run that checked another branch out into its worktree stores
   * that branch's whole diff as this task's work.
   */
  it('stores only the uncommitted diff when the agent repointed the worktree HEAD', async () => {
    const record = await makeWorktreeRun();
    const wt = record.worktreePath as string;

    // A branch with real commits on it, checked out into the task's worktree —
    // exactly what a `review/pr-NNN` or QA run does.
    await run('git', ['checkout', '-q', '-b', 'someone-elses-branch'], { cwd: wt });
    writeFileSync(join(wt, 'theirs.txt'), 'a\nb\nc\nd\ne\nf\n'); // 6 lines that are NOT this task's
    await run('git', ['add', '-A'], { cwd: wt });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'their work'], { cwd: wt });
    writeFileSync(join(wt, 'mine.txt'), 'z\n'); // the 1 line this task produced

    await runInternals(manager).turnBookkeeper.recordTurnEnd(record.id, TURN_TEXT);

    // 1 uncommitted line, flagged — not the 6 committed ones the foreign branch carries
    // (which, with `a.txt`'s edit and `new.txt`, would have read `+10 −1 / 4 files`).
    expect(store.getRun(record.id)?.diffStat).toEqual({
      adds: 1,
      dels: 0,
      files: 1,
      repointed: true,
    });
  });

  it('drops the repointed flag again once HEAD returns to the task branch', async () => {
    const record = await makeWorktreeRun();
    const wt = record.worktreePath as string;
    await run('git', ['checkout', '-q', '-b', 'a-detour'], { cwd: wt });
    await runInternals(manager).turnBookkeeper.recordTurnEnd(record.id, TURN_TEXT);
    expect(store.getRun(record.id)?.diffStat?.repointed).toBe(true);

    // `updateRun` replaces `diffStat` wholesale, so a stale `repointed: true` can
    // never outlive the repoint that caused it.
    await run('git', ['checkout', '-q', record.branch as string], { cwd: wt });
    await runInternals(manager).turnBookkeeper.recordTurnEnd(record.id, TURN_TEXT);
    const after = store.getRun(record.id);
    expect(after?.diffStat).toEqual({ adds: 3, dels: 1, files: 2 });
    expect(after?.diffStat).not.toHaveProperty('repointed');
  });

  it('never overwrites a user-edited title (PATCH sets titleSummary too)', async () => {
    const record = await makeWorktreeRun();
    // What PATCH /api/v1/runs/:id does on a rename:
    store.updateRun(record.id, { title: 'My name', titleSummary: 'My name', titleOrigin: 'user' });
    await runInternals(manager).turnBookkeeper.recordTurnEnd(record.id, TURN_TEXT);
    expect(store.getRun(record.id)?.titleSummary).toBe('My name');
  });

  it('skips diffStat for a worktree-less run, and never throws', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'do the thing', steps: [] });
    await expect(runInternals(manager).turnBookkeeper.recordTurnEnd(record.id, TURN_TEXT)).resolves.toBeUndefined();
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.diffStat).toBeUndefined();
  });

  it('is a quiet no-op for an unknown run', async () => {
    await expect(runInternals(manager).turnBookkeeper.recordTurnEnd('nope', TURN_TEXT)).resolves.toBeUndefined();
  });

  it('applies in-band CEZ markers from the turn text (spec 2026-07-18-task-ref-markers)', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'implement comment threads', steps: [] });
    await runInternals(manager).turnBookkeeper.recordTurnEnd(
      record.id,
      'Progress so far.\nCEZ:PR=500\nCEZ:ISSUE=433\nCEZ:TITLE=implementing comment threads\nMore to come.',
    );
    const after = store.getRun(record.id);
    expect(after?.prNumber).toBe(500);
    expect(after?.issueNumber).toBe(433);
    expect(after?.markerRefs).toEqual({ pr: 500, issue: 433 });
    // The declared title lands number-prefixed, marker-owned.
    expect(after?.titleSummary).toBe('500: implementing comment threads');
    expect(after?.titleOrigin).toBe('marker');
  });

  it('a marker title never overwrites a user rename — but the numbers still land', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    store.updateRun(record.id, { title: 'My name', titleSummary: 'My name', titleOrigin: 'user' });
    await runInternals(manager).turnBookkeeper.recordTurnEnd(record.id, 'CEZ:PR=500\nCEZ:TITLE=implementing comment threads');
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBe('My name');
    expect(after?.titleOrigin).toBe('user');
    expect(after?.prNumber).toBe(500);
  });

  it('a junk CEZ:TITLE never blanks the title', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    await runInternals(manager).turnBookkeeper.recordTurnEnd(record.id, 'CEZ:PR=500\nCEZ:TITLE=...');
    const after = store.getRun(record.id);
    expect(after?.titleSummary).toBeUndefined();
    expect(after?.titleOrigin).toBeUndefined();
    expect(after?.prNumber).toBe(500); // the number still lands
  });

  it('prose that merely mentions a marker changes nothing', async () => {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    await runInternals(manager).turnBookkeeper.recordTurnEnd(record.id, 'I will emit CEZ:PR=442 once the PR exists.');
    const after = store.getRun(record.id);
    expect(after?.markerRefs).toBeUndefined();
    expect(after?.prNumber).toBeUndefined();
    expect(after?.titleSummary).toBeUndefined();
  });
});
