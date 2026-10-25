import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { identityOf, withWorktreeFiles, type EntryContent, type WorktreeFiles } from './worktree-manifest.ts';
import { readManifest } from './worktree-manifest.testkit.ts';

/**
 * A worktree on another filesystem than its git dir: a rename out of the staging dir fails with
 * `EXDEV`, so the entry is copied in place. Its own file, because the fault replaces `rename` and
 * `cp` for every module this file loads.
 */
const fault = vi.hoisted(() => ({ crossDevice: false, failCopy: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const rename = (...args: Parameters<typeof actual.rename>) => {
    if (fault.crossDevice && String(args[0]).includes(`${sep}cezar-staging${sep}`)) {
      return Promise.reject(Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' }));
    }
    return actual.rename(...args);
  };
  const cp = async (...args: Parameters<typeof actual.cp>) => {
    if (!fault.failCopy) return actual.cp(...args);
    fault.failCopy = false;
    // A copy that stops partway, as a full disk ends it.
    await actual.mkdir(String(args[1]), { recursive: true });
    await actual.writeFile(join(String(args[1]), 'SKILL.md'), 'v');
    throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
  };
  return { ...actual, rename, cp, default: { ...actual, rename, cp } };
});

const execFileAsync = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

describe('worktree manifest across filesystems', { timeout: 30_000 }, () => {
  let main: string;
  let worktree: string;
  const git = async (cwd: string, ...args: string[]) => {
    const { stdout } = await execFileAsync('git', args, { cwd });
    return stdout;
  };
  const pass = <T>(run: (files: WorktreeFiles) => Promise<T>) => withWorktreeFiles<T | 'fallback'>(worktree, 'skills', {}, 'fallback', run);
  const v1: EntryContent = { type: 'dir', files: [{ name: 'SKILL.md', text: 'v1' }] };
  const meta = { kind: 'generated' as const, skill: 'x' };

  beforeEach(async () => {
    main = realpathSync(mkdtempSync(join(tmpdir(), 'cez-manifest-xdev-')));
    await git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'a.txt'), 'one\n');
    await git(main, 'add', '-A');
    await git(main, ...GIT_ID, 'commit', '-q', '-m', 'base');
    worktree = `${main}-wt`;
    await git(main, 'worktree', 'add', '-q', '-b', 'task', worktree);
    Object.assign(fault, { crossDevice: true, failCopy: false });
  });

  afterEach(() => {
    rmSync(main, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('copies an entry in place when it cannot rename it', async () => {
    await pass((files) => files.put('skills/x', v1, meta));
    expect(readFileSync(join(worktree, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('v1');
    expect((await readManifest(worktree))?.entries).toEqual([
      expect.objectContaining({ kind: 'generated', identity: await identityOf(join(worktree, 'skills', 'x')) }),
    ]);
  });

  it('removes a copy that failed partway, so the next pass writes the entry again', async () => {
    fault.failCopy = true;
    await expect(pass((files) => files.put('skills/x', v1, meta))).rejects.toThrow('ENOSPC');
    expect(fault.failCopy).toBe(false);
    expect(existsSync(join(worktree, 'skills', 'x'))).toBe(false);
    await pass((files) => files.put('skills/x', v1, meta));
    expect(readFileSync(join(worktree, 'skills', 'x', 'SKILL.md'), 'utf8')).toBe('v1');
    const [entry] = (await readManifest(worktree))?.entries ?? [];
    expect(entry).toMatchObject({ kind: 'generated', identity: await identityOf(join(worktree, 'skills', 'x')) });
  });
});
