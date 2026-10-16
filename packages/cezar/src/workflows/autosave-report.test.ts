import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree, type AutosaveReason } from '../git-worktree.ts';
import { readHandoff, seedHandoffFile } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
// The fixture reads Git directly, so a test's PATH shim reaches only the save.
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

/** The slice of ActiveRun that saveWorktree reads. */
interface SaveSeam {
  saveWorktree(runId: string, state: { cwd: string }, reason: AutosaveReason): Promise<void>;
}

/**
 * hearsay-tools/cezarion#1004: a resumed session reads the handoff, not
 * `git log`. Each turn-end / run-finalize save that commits or leaves work
 * behind says so in its `## Autosave (cezar)` section, never the Progress log,
 * and the same text reaches the cockpit as a note.
 * The runner-wire matrix for the same rule is R77/R78
 * (core/harness-autosave-branch.test.ts).
 */
describe('autosave report in the handoff and cockpit (#1004)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: SaveSeam;
  let runId: string;
  let worktreePath: string;
  let branch: string;
  let bin: string | undefined;

  const git = (args: string[]) => run(realGit, args, { cwd: worktreePath });
  const out = async (args: string[]) => (await git(args)).stdout.trim();
  const notes = (id = runId) => store.readEvents(id).flatMap(event => event.type === 'note' ? [String(event.message)] : []);
  /** Text of one `## Header` section, up to the next `## ` header. */
  const section = (header: string, id: string) => {
    const text = readHandoff(dataDir, id);
    const start = text.indexOf(`${header}\n`);
    if (start < 0) return '';
    const rest = text.slice(start + header.length + 1);
    const next = rest.indexOf('\n## ');
    return next >= 0 ? rest.slice(0, next) : rest;
  };
  const autosave = (id = runId) => section('## Autosave (cezar)', id);
  // The top of the Progress log is the agent's own summary: the variant compare
  // column and the draft-PR body both read it, so the report must stay out of it.
  const progress = (id = runId) => section('## Progress log', id);
  const expectReported = (message: string, id = runId) => {
    expect(autosave(id)).toContain(message);
    expect(progress(id)).not.toContain(message);
  };

  beforeEach(async () => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-autosave-report-'));
    await run('git', ['init', '-q', '-b', 'main'], { cwd: repoRoot });
    await run('git', ['config', 'gc.auto', '0'], { cwd: repoRoot });
    await run('git', ['config', 'maintenance.auto', 'false'], { cwd: repoRoot });
    writeFileSync(join(repoRoot, 'a.txt'), 'base\n');
    await run('git', ['add', '-A'], { cwd: repoRoot });
    await run('git', [...GIT_ID, 'commit', '-q', '-m', 'base'], { cwd: repoRoot });
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    manager = createFixtureManager(store, repoRoot) as unknown as SaveSeam;
    runId = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] }).id;
    const wt = await createWorktree(repoRoot, runId, 'main');
    worktreePath = wt.path;
    branch = wt.branch;
    store.updateRun(runId, { worktreePath, branch });
    seedHandoffFile(dataDir, store.getRun(runId)!);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    if (bin) rmSync(bin, { recursive: true, force: true });
    bin = undefined;
    await drainFixtureManagers(repoRoot);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('reports a turn-end commit on the task branch with its sha and the fold-back command', async () => {
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');

    await manager.saveWorktree(runId, { cwd: worktreePath }, 'turn end');

    const sha = await out(['rev-parse', '--short', 'HEAD']);
    expect(await out(['log', '-1', '--format=%s'])).toBe('cezar autosave (turn end)');
    const message = `turn end: cezar autosave committed ${sha} on ${branch}; to fold it into your own commits while it is HEAD, run \`git reset --soft ${sha}~1\``;
    expectReported(message);
    expect(notes()).toContain(message);
  });

  it.runIf(process.platform !== 'win32')('still reports a commit whose sha cannot be read back', async () => {
    bin = mkdtempSync(join(tmpdir(), 'cez-autosave-report-bin-'));
    writeFileSync(join(bin, 'git'), [
      '#!/bin/sh',
      'case " $* " in *" rev-parse --short HEAD "*) echo "fatal: shim" >&2; exit 128;; esac',
      `exec ${JSON.stringify(realGit)} "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');

    await manager.saveWorktree(runId, { cwd: worktreePath }, 'turn end');

    expect(await out(['log', '-1', '--format=%s'])).toBe('cezar autosave (turn end)');
    const message = `turn end: cezar autosave committed on ${branch} (sha unavailable); to fold it into your own commits while it is HEAD, run \`git reset --soft HEAD~1\``;
    expectReported(message);
    expect(notes()).toContain(message);
  });

  it('leaves run-finalize work uncommitted on another branch and says so', async () => {
    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    const tip = await out(['rev-parse', 'HEAD']);
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');

    await manager.saveWorktree(runId, { cwd: worktreePath }, 'run finalize');

    expect(await out(['rev-parse', 'HEAD'])).toBe(tip);
    expect((await git(['status', '--porcelain'])).stdout).toBe('?? work.txt\n');
    const message = `run finalize: 1 changed path(s) left uncommitted on fix/1004-x; cezar does not autosave on a branch other than the task branch ${branch}`;
    expectReported(message);
    expect(notes()).toContain(message);
  });

  it('names a detached HEAD instead of a branch', async () => {
    await git(['checkout', '-q', '--detach']);
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');

    await manager.saveWorktree(runId, { cwd: worktreePath }, 'turn end');

    const message = `turn end: 1 changed path(s) left uncommitted on detached HEAD; cezar does not autosave on a branch other than the task branch ${branch}`;
    expectReported(message);
    expect(notes()).toContain(message);
  });

  it('writes no handoff line or note for a periodic save, committed or skipped', async () => {
    const before = readHandoff(dataDir, runId);
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');
    await manager.saveWorktree(runId, { cwd: worktreePath }, 'periodic');
    expect(await out(['log', '-1', '--format=%s'])).toBe('cezar autosave (periodic)');

    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    writeFileSync(join(worktreePath, 'more.txt'), 'progress\n');
    await manager.saveWorktree(runId, { cwd: worktreePath }, 'periodic');
    // Same rule as the closing flushes: nothing lands on the agent's branch.
    expect((await git(['status', '--porcelain'])).stdout).toBe('?? more.txt\n');

    expect(readHandoff(dataDir, runId)).toBe(before);
    expect(notes().filter(message => message.includes('autosave'))).toEqual([]);
  });

  it('writes nothing when there is nothing to save', async () => {
    const before = readHandoff(dataDir, runId);

    await manager.saveWorktree(runId, { cwd: worktreePath }, 'turn end');

    expect(readHandoff(dataDir, runId)).toBe(before);
    expect(notes()).toEqual([]);
  });

  it('keeps committing on whatever HEAD is for a run with no recorded branch', async () => {
    const legacy = store.createRun({ title: 'legacy', workflow: 'quick-task', task: 't', steps: [] }).id;
    store.updateRun(legacy, { worktreePath });
    seedHandoffFile(dataDir, store.getRun(legacy)!);
    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');

    await manager.saveWorktree(legacy, { cwd: worktreePath }, 'run finalize');

    expect(await out(['log', '-1', '--format=%s', 'fix/1004-x'])).toBe('cezar autosave (run finalize)');
    const sha = await out(['rev-parse', '--short', 'HEAD']);
    expectReported(`run finalize: cezar autosave committed ${sha} on fix/1004-x;`, legacy);
  });
});
