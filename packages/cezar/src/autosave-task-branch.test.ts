import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { autosaveCommit, type AutosaveOutcome } from './git-worktree.ts';

const run = promisify(execFile);
// The fixture reads Git directly, so a test's PATH shim reaches only the save.
const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const TASK_BRANCH = 'cez/abcd1234';

/**
 * hearsay-tools/cezarion#1004: an agent checked its own feature branch out in
 * its task worktree, and the `run finalize` flush committed
 * `cezar autosave (run finalize)` onto that branch. Given the task branch, the
 * save commits only while HEAD is that branch; anywhere else it leaves the
 * index and working tree alone and reports what it left.
 */
describe('autosave task-branch rule (#1004)', () => {
  let repo: string;
  let bin: string | undefined;

  const git = (args: string[]) => run(realGit, args, { cwd: repo });
  const out = async (args: string[]) => (await git(args)).stdout.trim();

  beforeEach(async () => {
    repo = mkdtempSync(join(tmpdir(), 'cez-autosave-branch-'));
    await git(['init', '-q', '-b', TASK_BRANCH]);
    await git(['config', 'gc.auto', '0']);
    await git(['config', 'maintenance.auto', 'false']);
    writeFileSync(join(repo, 'a.txt'), 'base\n');
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'base']);
  });

  /** Put a `git` on PATH that runs `body` (sh) for the save's commands; `$REAL` is the real Git. */
  const shim = (body: string[]) => {
    bin = mkdtempSync(join(tmpdir(), 'cez-autosave-branch-bin-'));
    writeFileSync(join(bin, 'git'), ['#!/bin/sh', `REAL=${JSON.stringify(realGit)}`, ...body, 'exec "$REAL" "$@"', ''].join('\n'), { mode: 0o755 });
    vi.stubEnv('PATH', `${bin}:${process.env.PATH}`);
    return bin;
  };

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    rmSync(repo, { recursive: true, force: true });
    if (bin) rmSync(bin, { recursive: true, force: true });
    bin = undefined;
  });

  it('leaves a dirty tree uncommitted on a branch other than the task branch', async () => {
    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    const tip = await out(['rev-parse', 'fix/1004-x']);
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'run finalize', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('skipped');

    expect(outcomes).toEqual([{ result: 'skipped', branch: 'fix/1004-x', changedPaths: 2 }]);
    expect(await out(['rev-parse', 'fix/1004-x'])).toBe(tip);
    expect(await out(['rev-parse', TASK_BRANCH])).toBe(tip);
    // No `git add`: the edit stays unstaged and the new file untracked.
    expect((await git(['status', '--porcelain'])).stdout).toBe(' M a.txt\n?? new.txt\n');
  });

  it('leaves a dirty tree uncommitted on a detached HEAD', async () => {
    await git(['checkout', '-q', '--detach']);
    const head = await out(['rev-parse', 'HEAD']);
    writeFileSync(join(repo, 'new.txt'), 'untracked\n');
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('skipped');

    expect(outcomes).toEqual([{ result: 'skipped', branch: null, changedPaths: 1 }]);
    expect(await out(['rev-parse', 'HEAD'])).toBe(head);
    expect((await git(['status', '--porcelain'])).stdout).toBe('?? new.txt\n');
  });

  it('commits as before while HEAD is the task branch, and reports the commit', async () => {
    writeFileSync(join(repo, 'new.txt'), 'work\n');
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'run finalize', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('committed');

    expect(await out(['log', '-1', '--format=%s', TASK_BRANCH])).toBe('cezar autosave (run finalize)');
    expect(outcomes).toEqual([{ result: 'committed', sha: await out(['rev-parse', '--short', 'HEAD']), branch: TASK_BRANCH }]);
    expect((await git(['status', '--porcelain'])).stdout).toBe('');
  });

  // The commit landed, so the report must too: a missing sha is no reason to hide it.
  it.runIf(process.platform !== 'win32')('reports a commit whose sha cannot be read back', async () => {
    // Any abbreviation: the save shortens the commit it wrote, never a re-read HEAD.
    shim(['case " $* " in *" rev-parse --short "*) echo "fatal: shim" >&2; exit 128;; esac']);
    writeFileSync(join(repo, 'new.txt'), 'work\n');
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('committed');

    expect(await out(['log', '-1', '--format=%s', TASK_BRANCH])).toBe('cezar autosave (turn end)');
    expect(outcomes).toEqual([{ result: 'committed', sha: null, branch: TASK_BRANCH }]);
  });

  it('still commits on any branch when no task branch is given (pre-PR)', async () => {
    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    writeFileSync(join(repo, 'new.txt'), 'work\n');

    expect(await autosaveCommit(repo, 'pre-PR')).toBe('committed');

    expect(await out(['log', '-1', '--format=%s', 'fix/1004-x'])).toBe('cezar autosave (pre-PR)');
  });

  it('stays silent on a clean branch other than the task branch', async () => {
    await git(['checkout', '-q', '-b', 'fix/1004-x']);
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('nothing-to-do');

    expect(outcomes).toEqual([]);
  });

  // The review finding on hearsay-tools/cezarion#1111: HEAD was checked before
  // `git add`, and `git commit` resolved it again at its own start, so an agent
  // switching branches in between got the autosave on its own branch.
  it.runIf(process.platform !== 'win32')('commits on the task branch even when the agent checks another branch out mid-save', async () => {
    const base = await out(['rev-parse', TASK_BRANCH]);
    await git(['branch', 'fix/1004-x']);
    // The real `add -A`, then the agent's checkout: same tip, so the staged work carries over.
    shim(['case " $* " in *" add -A "*) "$REAL" "$@" || exit $?; exec "$REAL" checkout -q fix/1004-x;; esac']);
    writeFileSync(join(repo, 'new.txt'), 'work\n');
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('committed');

    expect(await out(['symbolic-ref', 'HEAD'])).toBe('refs/heads/fix/1004-x');
    expect(await out(['rev-parse', 'fix/1004-x'])).toBe(base);
    expect(await out(['rev-list', '--format=%s', '--no-commit-header', `${base}..${TASK_BRANCH}`])).toBe('cezar autosave (turn end)');
    expect(await out(['rev-parse', `${TASK_BRANCH}^`])).toBe(base);
    expect(await out(['show', `${TASK_BRANCH}:new.txt`])).toBe('work');
    expect(outcomes).toEqual([{ result: 'committed', sha: await out(['rev-parse', '--short', TASK_BRANCH]), branch: TASK_BRANCH }]);
  });

  it.runIf(process.platform !== 'win32')('writes nothing when the task branch moves before the ref update', async () => {
    const base = await out(['rev-parse', TASK_BRANCH]);
    const moved = await out([...GIT_ID, 'commit-tree', `${base}^{tree}`, '-p', base, '-m', 'agent commit']);
    // The real `commit-tree`, then the branch moves under the save.
    shim([`case " $* " in *" commit-tree "*) "$REAL" "$@"; s=$?; "$REAL" update-ref refs/heads/${TASK_BRANCH} ${moved}; exit $s;; esac`]);
    writeFileSync(join(repo, 'new.txt'), 'work\n');
    const refs = async () => (await git(['for-each-ref', '--format=%(refname) %(objectname)'])).stdout;
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'periodic', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('failed');

    expect(await out(['rev-parse', TASK_BRANCH])).toBe(moved);
    expect(await refs()).toBe(`refs/heads/${TASK_BRANCH} ${moved}\n`);
    expect(await out(['symbolic-ref', 'HEAD'])).toBe(`refs/heads/${TASK_BRANCH}`);
    expect(outcomes).toEqual([]);
  });

  it('leaves the index, status and HEAD reflog as a porcelain commit would', async () => {
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    writeFileSync(join(repo, 'new.txt'), 'work\n');

    expect(await autosaveCommit(repo, 'run finalize', { taskBranch: TASK_BRANCH })).toBe('committed');

    const tip = await out(['rev-parse', TASK_BRANCH]);
    expect((await git(['status', '--porcelain'])).stdout).toBe('');
    expect(await out(['write-tree'])).toBe(await out(['rev-parse', `${tip}^{tree}`]));
    expect(await out(['log', '-1', '--format=%H %s', 'HEAD'])).toBe(`${tip} cezar autosave (run finalize)`);
    expect(await out(['reflog', '-1', '--format=%H %gs', 'HEAD'])).toMatch(new RegExp(`^${tip} .*cezar autosave \\(run finalize\\)$`));
    expect(await out(['reflog', '-1', '--format=%H %gs', TASK_BRANCH])).toMatch(new RegExp(`^${tip} .*cezar autosave \\(run finalize\\)$`));
  });

  it('commits the first commit of an unborn task branch', async () => {
    const fresh = mkdtempSync(join(tmpdir(), 'cez-autosave-branch-unborn-'));
    try {
      await run(realGit, ['init', '-q', '-b', TASK_BRANCH], { cwd: fresh });
      writeFileSync(join(fresh, 'new.txt'), 'work\n');

      expect(await autosaveCommit(fresh, 'turn end', { taskBranch: TASK_BRANCH })).toBe('committed');

      const log = (await run(realGit, ['log', '--format=%s|%P', TASK_BRANCH], { cwd: fresh })).stdout;
      expect(log).toBe('cezar autosave (turn end)|\n');
      expect((await run(realGit, ['status', '--porcelain'], { cwd: fresh })).stdout).toBe('');
    } finally { rmSync(fresh, { recursive: true, force: true }); }
  });

  it('stays silent on a clean task branch', async () => {
    const tip = await out(['rev-parse', TASK_BRANCH]);
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('nothing-to-do');

    expect(await out(['rev-parse', TASK_BRANCH])).toBe(tip);
    expect(outcomes).toEqual([]);
  });

  // Dirty when the save looked, identical to the tip by the time it staged: the
  // porcelain failed here with "nothing to commit"; there is nothing to save.
  it.runIf(process.platform !== 'win32')('reports nothing to do when the staged tree equals the task branch tip', async () => {
    const tip = await out(['rev-parse', TASK_BRANCH]);
    shim([`case " $* " in *" add -A "*) printf 'base\\n' > a.txt;; esac`]);
    writeFileSync(join(repo, 'a.txt'), 'edited\n');
    const outcomes: AutosaveOutcome[] = [];

    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH, onOutcome: o => outcomes.push(o) })).toBe('nothing-to-do');

    expect(await out(['rev-parse', TASK_BRANCH])).toBe(tip);
    expect(outcomes).toEqual([]);
  });

  // commit-tree stopped reading commit.gpgSign in Git 2.9; the porcelain still
  // signs, so a user who signs every commit must get a signed autosave too.
  it.runIf(process.platform !== 'win32')('signs the task-branch save when commit.gpgSign is set, and only then', async () => {
    const gpg = join(shim([]), 'gpg');
    writeFileSync(gpg, [
      '#!/bin/sh',
      'cat >/dev/null',
      "printf '\\n[GNUPG:] SIG_CREATED D 1 8 00 0 0\\n' >&2",
      "printf -- '-----BEGIN PGP SIGNATURE-----\\n\\nfake\\n-----END PGP SIGNATURE-----\\n'",
      '',
    ].join('\n'), { mode: 0o755 });
    await git(['config', 'gpg.program', gpg]);
    const signed = async () => (await git(['cat-file', 'commit', TASK_BRANCH])).stdout.includes('\ngpgsig ');

    writeFileSync(join(repo, 'one.txt'), 'unsigned\n');
    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH })).toBe('committed');
    expect(await signed()).toBe(false);

    await git(['config', 'commit.gpgSign', 'true']);
    writeFileSync(join(repo, 'two.txt'), 'signed\n');
    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH })).toBe('committed');
    expect(await signed()).toBe(true);
  });

  // The agent is mid-operation and concludes it with its own message; an
  // autosave would conclude it for them under `cezar autosave` (#1004).
  describe.each([
    ['merge', 'MERGE_HEAD', async () => {
      await git(['checkout', '-q', '-b', 'side']);
      writeFileSync(join(repo, 'b.txt'), 'side\n');
      await git(['add', '-A']);
      await git([...GIT_ID, 'commit', '-q', '-m', 'side']);
      await git(['checkout', '-q', TASK_BRANCH]);
      await git([...GIT_ID, 'merge', '-q', '--no-commit', '--no-ff', 'side']);
    }],
    ['cherry-pick', 'CHERRY_PICK_HEAD', async () => {
      await git(['checkout', '-q', '-b', 'side']);
      writeFileSync(join(repo, 'a.txt'), 'side\n');
      await git([...GIT_ID, 'commit', '-q', '-am', 'side']);
      await git(['checkout', '-q', TASK_BRANCH]);
      writeFileSync(join(repo, 'a.txt'), 'task\n');
      await git([...GIT_ID, 'commit', '-q', '-am', 'task']);
      await git([...GIT_ID, 'cherry-pick', 'side']).catch(() => undefined);
      writeFileSync(join(repo, 'a.txt'), 'resolved\n');
      await git(['add', 'a.txt']);
    }],
    ['revert', 'REVERT_HEAD', async () => {
      writeFileSync(join(repo, 'a.txt'), 'one\n');
      await git([...GIT_ID, 'commit', '-q', '-am', 'one']);
      writeFileSync(join(repo, 'a.txt'), 'two\n');
      await git([...GIT_ID, 'commit', '-q', '-am', 'two']);
      await git([...GIT_ID, 'revert', 'HEAD~1']).catch(() => undefined);
      writeFileSync(join(repo, 'a.txt'), 'resolved\n');
      await git(['add', 'a.txt']);
    }],
  ] as const)('a resolved %s in progress on the task branch', (_name, pseudoRef, start) => {
    it('is refused, and the operation stays the agent\'s to conclude', async () => {
      await start();
      const tip = await out(['rev-parse', TASK_BRANCH]);
      const pending = await out(['rev-parse', pseudoRef]);
      const staged = (await git(['status', '--porcelain'])).stdout;
      expect(staged).toMatch(/^[MA] /m);
      vi.spyOn(console, 'warn').mockImplementation(() => undefined);

      expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH })).toBe('refused');

      expect(await out(['rev-parse', TASK_BRANCH])).toBe(tip);
      expect(await out(['rev-parse', pseudoRef])).toBe(pending);
      expect((await git(['status', '--porcelain'])).stdout).toBe(staged);
    });

    it('still commits without a task branch (pre-PR)', async () => {
      await start();
      const tip = await out(['rev-parse', 'HEAD']);

      expect(await autosaveCommit(repo, 'pre-PR')).toBe('committed');

      expect(await out(['rev-parse', 'HEAD^'])).toBe(tip);
    });
  });

  /** Commit `file` on a new branch `side` off the task branch, check the task branch out again. */
  const sideBranch = async (file: string, content: string) => {
    await git(['checkout', '-q', '-b', 'side']);
    writeFileSync(join(repo, file), content);
    await git(['add', '-A']);
    await git([...GIT_ID, 'commit', '-q', '-m', 'side']);
    await git(['checkout', '-q', TASK_BRANCH]);
    return out(['rev-parse', 'side']);
  };

  // Review round 4 on hearsay-tools/cezarion#1004: the agent's operation starts after
  // the pending check, just before the save's real `add -A`, so the save stages its
  // content. Committed as a plain autosave, a merge lost its second parent and its
  // MERGE_HEAD stayed behind a clean status; a conflicted pick committed its markers.
  it.runIf(process.platform !== 'win32')('refuses a merge that starts mid-save, and leaves it pending', async () => {
    const side = await sideBranch('b.txt', 'side\n');
    const tip = await out(['rev-parse', TASK_BRANCH]);
    shim([`case " $* " in *" add -A "*) "$REAL" ${GIT_ID.join(' ')} merge -q --no-ff --no-commit side || exit $?;; esac`]);
    writeFileSync(join(repo, 'new.txt'), 'work\n');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH })).toBe('refused');

    expect(await out(['rev-parse', TASK_BRANCH])).toBe(tip);
    expect(await out(['rev-parse', 'MERGE_HEAD'])).toBe(side);
  });

  it.runIf(process.platform !== 'win32')('refuses a cherry-pick that stops on a conflict mid-save, and leaves it pending', async () => {
    const side = await sideBranch('a.txt', 'side\n');
    writeFileSync(join(repo, 'a.txt'), 'task\n');
    await git([...GIT_ID, 'commit', '-q', '-am', 'task']);
    const tip = await out(['rev-parse', TASK_BRANCH]);
    shim([`case " $* " in *" add -A "*) "$REAL" ${GIT_ID.join(' ')} cherry-pick side >/dev/null 2>&1;; esac`]);
    writeFileSync(join(repo, 'new.txt'), 'work\n');
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    expect(await autosaveCommit(repo, 'turn end', { taskBranch: TASK_BRANCH })).toBe('refused');

    expect(await out(['rev-parse', TASK_BRANCH])).toBe(tip);
    expect(await out(['rev-parse', 'CHERRY_PICK_HEAD'])).toBe(side);
  });

  // The pre-PR flush names no branch: it keeps the porcelain commit, command for command.
  it.runIf(process.platform !== 'win32')('runs the same Git commands as before when no task branch is given', async () => {
    await git(['config', 'user.name', 'test']);
    await git(['config', 'user.email', 'test@local']);
    const log = join(shim([]), 'calls.log');
    writeFileSync(join(bin!, 'git'), [
      '#!/bin/sh',
      `printf '%s\\n' "$*" >> ${JSON.stringify(log)}`,
      `exec ${JSON.stringify(realGit)} "$@"`,
      '',
    ].join('\n'), { mode: 0o755 });
    writeFileSync(join(repo, 'new.txt'), 'work\n');

    expect(await autosaveCommit(repo, 'pre-PR')).toBe('committed');

    const prefix = '-c gc.auto=0 -c maintenance.auto=false ';
    expect(readFileSync(log, 'utf8').split('\n').filter(Boolean)).toEqual([
      `${prefix}status --porcelain`,
      `${prefix}add -A`,
      `${prefix}config user.name`,
      `${prefix}config user.email`,
      `${prefix}commit --no-verify -m cezar autosave (pre-PR)`,
    ]);
  });
});
