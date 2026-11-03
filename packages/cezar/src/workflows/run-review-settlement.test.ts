import { run, GIT_ID } from './run-fixture.testkit.ts';
import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { RunManager } from './run.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
describe('RunSettlement.settleSuccess — optional review gate', () => {
  const savedGate = process.env.CEZ_REVIEW_GATE;
  const savedAutoname = process.env.CEZ_AUTONAME;
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  beforeAll(async () => {
    process.env.CEZ_AUTONAME = '0';
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-reviewgate-'));
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
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
    if (savedGate === undefined) delete process.env.CEZ_REVIEW_GATE;
    else process.env.CEZ_REVIEW_GATE = savedGate;
    if (savedAutoname === undefined) delete process.env.CEZ_AUTONAME;
    else process.env.CEZ_AUTONAME = savedAutoname;
  });

  afterEach(() => {
    delete process.env.CEZ_REVIEW_GATE;
    // Reset the config file each test so config.reviewGate never leaks across cases.
    rmSync(join(repoRoot, '.ai/cezar', 'config.json'), { force: true });
  });

  /** A fresh run + worktree holding a real diff (edit + new file) vs main. */
  async function changedRun(autonomous?: boolean): Promise<RunRecord> {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', autonomous, steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    // settleSuccess runs at a live turn's end, never on a queued run (hearsay-tools/cezarion#1804).
    store.updateRun(record.id, { status: RUN_STATUS.running, worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch });
    writeFileSync(join(wt.path, 'a.txt'), 'one\nTWO\nthree\n');
    writeFileSync(join(wt.path, 'new.txt'), 'x\n');
    return store.getRun(record.id) as RunRecord;
  }

  /** A fresh run + worktree with no changes vs main (empty diff). */
  async function cleanRun(): Promise<RunRecord> {
    const record = store.createRun({ title: 't', workflow: 'w', task: 'task', steps: [] });
    const wt = await createWorktree(repoRoot, record.id, 'main');
    store.updateRun(record.id, { status: RUN_STATUS.running, worktreePath: wt.path, branch: wt.branch, baseBranch: wt.baseBranch });
    return store.getRun(record.id) as RunRecord;
  }

  const settle = (id: string) => runInternals(manager).runSettlement.settleSuccess(id);

  it('gate off (default) + changes → done, diff left in the worktree', async () => {
    const record = await changedRun();
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  });

  it('gate on (env) + non-autonomous + changes → review', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const record = await changedRun();
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('review');
  });

  it('gate on + autonomous + changes → done (autonomous wins — the #489 fix)', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const record = await changedRun(true);
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  });

  it('gate on + no changes → done (the diff check stays first)', async () => {
    process.env.CEZ_REVIEW_GATE = '1';
    const record = await cleanRun();
    await settle(record.id);
    expect(store.getRun(record.id)?.status).toBe('done');
  });
});
