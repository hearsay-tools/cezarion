import { runInternals } from './run-internals.testkit.ts';
import { createActiveRun } from './active-run.ts';
import type { WorktreeAutosave } from './run/worktree-autosave.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createWorktree } from '../git-worktree.ts';
import { handoffPath, readHandoff, seedHandoffFile } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';

const run = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
// The fixture reads Git directly, so a test's PATH shim reaches only the save.
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();

/**
 * hearsay-tools/cezarion#1004: a resumed session reads the handoff, not
 * `git log`. Each turn-end / run-finalize save that commits or leaves work
 * behind says so in the handoff's records block, never the Progress log, and
 * the same text reaches the cockpit as a note. Periodic commits share one
 * merged record and no note. The run store holds the records
 * (hearsay-tools/cezarion#1809), so an agent edit to the file cannot lose one.
 * The runner-wire matrix for the same rule is R78/R79
 * (core/harness-autosave-branch.test.ts).
 */
describe('autosave report in the handoff and cockpit (#1004)', () => {
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let manager: WorktreeAutosave;
  let runId: string;
  let worktreePath: string;
  let branch: string;
  let bin: string | undefined;

  const git = (args: string[]) => run(realGit, args, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }));
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
  /** The records block's autosave lines (hearsay-tools/cezarion#1809). */
  const autosave = (id = runId) => section('### Autosave', id).split('\n').filter(line => line.startsWith('- ')).join('\n');
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
    manager = runInternals(createFixtureManager(store, repoRoot)).worktreeAutosave;
    runId = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] }).id;
    const wt = await createWorktree(repoRoot, runId, 'main');
    worktreePath = wt.path;
    branch = wt.branch;
    store.updateRun(runId, { worktreePath, branch });
    seedHandoffFile(dataDir, store.getRun(runId)!);
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    if (bin) rmSync(bin, { recursive: true, force: true });
    bin = undefined;
    await drainFixtureManagers(repoRoot);
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('reports a turn-end commit on the task branch with its sha and the fold-back command', async () => {
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');

    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'turn end');

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
      // Any abbreviation: the save shortens the commit it wrote, never a re-read HEAD.
      'case " $* " in *" rev-parse --short "*) echo "fatal: shim" >&2; exit 128;; esac',
      `exec ${JSON.stringify(realGit)} "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');

    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'turn end');

    expect(await out(['log', '-1', '--format=%s'])).toBe('cezar autosave (turn end)');
    const message = `turn end: cezar autosave committed on ${branch} (sha unavailable); to fold it into your own commits while it is HEAD, run \`git reset --soft HEAD~1\``;
    expectReported(message);
    expect(notes()).toContain(message);
  });

  it('leaves run-finalize work uncommitted on another branch and says so', async () => {
    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    const tip = await out(['rev-parse', 'HEAD']);
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');

    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'run finalize');

    expect(await out(['rev-parse', 'HEAD'])).toBe(tip);
    expect((await git(['status', '--porcelain'])).stdout).toBe('?? work.txt\n');
    const message = `run finalize: 1 changed path(s) left uncommitted on fix/1004-x; cezar does not autosave on a branch other than the task branch ${branch}`;
    expectReported(message);
    expect(notes()).toContain(message);
  });

  it('names a detached HEAD instead of a branch', async () => {
    await git(['checkout', '-q', '--detach']);
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');

    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'turn end');

    const message = `turn end: 1 changed path(s) left uncommitted on detached HEAD; cezar does not autosave on a branch other than the task branch ${branch}`;
    expectReported(message);
    expect(notes()).toContain(message);
  });

  /** The coalesced line a run of periodic commits on the task branch leaves (#1004 review). */
  const periodicLine = (count: number, first: string, latest: string) =>
    `periodic: ${count} cezar autosave commit(s) on ${branch}, first ${first}, latest ${latest}; ` +
    `to fold the latest into your own commits while it is HEAD, run \`git reset --soft ${latest}~1\``;
  const autosaveLines = (id = runId) => autosave(id).split('\n').filter(Boolean);
  const editHandoff = (edit: (text: string) => string) => writeFileSync(handoffPath(dataDir, runId), edit(readHandoff(dataDir, runId)));
  const autosaveNotes = () => notes().filter(message => message.includes('autosave'));

  // The automated review on hearsay-tools/cezarion#1111: the timer committed the last
  // work, the closing flush found a clean tree, and nothing told a resumed session.
  it('reports a periodic commit that leaves the closing turn-end flush nothing to save', async () => {
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'periodic');
    expect(await out(['log', '-1', '--format=%s'])).toBe('cezar autosave (periodic)');
    const sha = await out(['rev-parse', '--short', 'HEAD']);

    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'turn end');

    expect(await out(['rev-parse', '--short', 'HEAD'])).toBe(sha);
    expectReported(periodicLine(1, sha, sha));
    expect(autosave()).toContain(`on ${branch}`);
    expect(autosave()).toContain(`\`git reset --soft ${sha}~1\``);
    // A note every 90 s would flood the timeline; the handoff line is the report.
    expect(autosaveNotes()).toEqual([]);
  });

  it('coalesces consecutive periodic commits into one line', async () => {
    writeFileSync(join(worktreePath, 'one.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'periodic');
    const first = await out(['rev-parse', '--short', 'HEAD']);
    writeFileSync(join(worktreePath, 'two.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'periodic');
    const latest = await out(['rev-parse', '--short', 'HEAD']);
    expect(latest).not.toBe(first);

    expect(autosaveLines()).toHaveLength(1);
    expectReported(periodicLine(2, first, latest));
    expect(autosaveNotes()).toEqual([]);
  });

  it('starts a new periodic line after a turn-end report', async () => {
    writeFileSync(join(worktreePath, 'one.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'periodic');
    const one = await out(['rev-parse', '--short', 'HEAD']);
    writeFileSync(join(worktreePath, 'two.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'turn end');
    const two = await out(['rev-parse', '--short', 'HEAD']);
    writeFileSync(join(worktreePath, 'three.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'periodic');
    const three = await out(['rev-parse', '--short', 'HEAD']);

    const lines = autosaveLines();
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/ — periodic: /);
    expect(lines[0]).toContain(periodicLine(1, three, three));
    expect(lines[1]).toContain(`turn end: cezar autosave committed ${two} on ${branch};`);
    expect(lines[2]).toContain(periodicLine(1, one, one));
    // Only the turn-end flush reaches the cockpit.
    expect(autosaveNotes()).toEqual([expect.stringContaining(`turn end: cezar autosave committed ${two}`)]);
  });

  // The agent owns the file. Before hearsay-tools/cezarion#1809 it was the reports' only copy: a
  // rewrite without the section lost them, and an edited periodic line restarted the count.
  it('keeps a report when the agent rewrites the handoff without it', async () => {
    writeFileSync(join(worktreePath, 'one.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'turn end');
    const one = await out(['rev-parse', '--short', 'HEAD']);
    editHandoff(() => '# My own handoff\n\n## Progress log\n\n- 10:00 — rewrote it\n');
    writeFileSync(join(worktreePath, 'two.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'turn end');
    const two = await out(['rev-parse', '--short', 'HEAD']);

    const text = readHandoff(dataDir, runId);
    expect(text).toContain(`turn end: cezar autosave committed ${two} on ${branch};`);
    expect(text).toContain(`turn end: cezar autosave committed ${one} on ${branch};`);
    expect(text).toContain('- 10:00 — rewrote it');
  });

  it('counts on after the agent edits the periodic line', async () => {
    writeFileSync(join(worktreePath, 'one.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'periodic');
    const first = await out(['rev-parse', '--short', 'HEAD']);
    editHandoff(text => text.replace(/^(- \S+ — periodic: .*)$/m, '$1 (seen)'));
    writeFileSync(join(worktreePath, 'two.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'periodic');
    const latest = await out(['rev-parse', '--short', 'HEAD']);

    expect(readHandoff(dataDir, runId)).toContain(periodicLine(2, first, latest));
  });

  it('reports a periodic commit only in the handoff, and a periodic skip nowhere', async () => {
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'periodic');
    expect(await out(['log', '-1', '--format=%s'])).toBe('cezar autosave (periodic)');
    const sha = await out(['rev-parse', '--short', 'HEAD']);
    expect(autosaveLines()).toEqual([expect.stringContaining(periodicLine(1, sha, sha))]);
    const committed = readHandoff(dataDir, runId);

    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    writeFileSync(join(worktreePath, 'more.txt'), 'progress\n');
    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'periodic');
    // Same rule as the closing flushes: nothing lands on the agent's branch. The skip
    // stays silent: the closing flush reports it with the final path count.
    expect((await git(['status', '--porcelain'])).stdout).toBe('?? more.txt\n');

    expect(readHandoff(dataDir, runId)).toBe(committed);
    expect(autosaveNotes()).toEqual([]);
  });

  // The refusal now has two causes; the note must not claim conflicts that are not there.
  it('says an unfinished merge, not only conflicts, can refuse the save', async () => {
    await git(['checkout', '-q', '-b', 'side']);
    writeFileSync(join(worktreePath, 'b.txt'), 'side\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'side']);
    await git(['checkout', '-q', branch]);
    await git([...GIT_ID, 'merge', '-q', '--no-commit', '--no-ff', 'side']);
    const tip = await out(['rev-parse', branch]);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'turn end');

    expect(await out(['rev-parse', branch])).toBe(tip);
    expect(notes()).toContain(`turn end autosave refused: unresolved conflicts or an unfinished merge, cherry-pick or revert; working files remain in ${worktreePath}`);
  });

  it('writes nothing when there is nothing to save', async () => {
    const before = readHandoff(dataDir, runId);

    await manager.saveWorktree(runId, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'turn end');

    expect(readHandoff(dataDir, runId)).toBe(before);
    expect(notes()).toEqual([]);
  });

  it('keeps committing on whatever HEAD is for a run with no recorded branch', async () => {
    const legacy = store.createRun({ title: 'legacy', workflow: 'quick-task', task: 't', steps: [] }).id;
    store.updateRun(legacy, { worktreePath });
    seedHandoffFile(dataDir, store.getRun(legacy)!);
    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    writeFileSync(join(worktreePath, 'work.txt'), 'progress\n');

    await manager.saveWorktree(legacy, createActiveRun({ cwd: worktreePath, pendingHumanAsk: false, autonomous: false }), 'run finalize');

    expect(await out(['log', '-1', '--format=%s', 'fix/1004-x'])).toBe('cezar autosave (run finalize)');
    const sha = await out(['rev-parse', '--short', 'HEAD']);
    expectReported(`run finalize: cezar autosave committed ${sha} on fix/1004-x;`, legacy);
  });
});
