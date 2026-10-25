import { execFile } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Skill } from './skills.ts';
import { provisionSkills } from './skills-provision.ts';
import { uncoveredPaths } from './worktree-manifest.testkit.ts';

/**
 * A write that fails partway, as a full disk or a crash would end it. Its own file, because the
 * fault replaces `writeFile` for every module this file loads.
 */
const fault = vi.hoisted(() => ({ failNextSkillWrite: false }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const writeFile = (...args: Parameters<typeof actual.writeFile>) => {
    if (fault.failNextSkillWrite && String(args[0]).endsWith('SKILL.md')) {
      fault.failNextSkillWrite = false;
      return Promise.reject(Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }));
    }
    return actual.writeFile(...args);
  };
  return { ...actual, writeFile, default: { ...actual, writeFile } };
});

const execFileAsync = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

describe('provisionSkills after an interrupted write', { timeout: 30_000 }, () => {
  let main: string;
  let worktree: string;
  const git = async (cwd: string, ...args: string[]) => (await execFileAsync('git', args, { cwd })).stdout;

  beforeEach(async () => {
    main = realpathSync(mkdtempSync(join(tmpdir(), 'cez-provision-interrupted-')));
    await git(main, 'init', '-q', '-b', 'main');
    writeFileSync(join(main, 'a.txt'), 'one\n');
    await git(main, 'add', '-A');
    await git(main, ...GIT_ID, 'commit', '-q', '-m', 'base');
    worktree = `${main}-wt`;
    await git(main, 'worktree', 'add', '-q', '-b', 'task', worktree);
  });

  afterEach(() => {
    rmSync(main, { recursive: true, force: true });
    rmSync(worktree, { recursive: true, force: true });
  });

  it('writes a generated SKILL.md whose first write failed at the next pass', async () => {
    const builtin: Skill = { name: 'auto-skill', description: 'Built in.', body: 'BUILTIN-BODY', path: 'builtin:auto-skill', source: 'builtin' };
    fault.failNextSkillWrite = true;
    await provisionSkills(worktree, [builtin], [builtin]);
    expect(fault.failNextSkillWrite).toBe(false);
    await provisionSkills(worktree, [builtin], [builtin]);
    for (const dir of ['.claude', '.agents', '.cursor']) {
      expect(readFileSync(join(worktree, dir, 'skills', 'auto-skill', 'SKILL.md'), 'utf8'))
        .toBe('---\nname: "auto-skill"\ndescription: "Built in."\n---\n\nBUILTIN-BODY\n');
    }
    expect(await git(worktree, 'status', '--porcelain', '--untracked-files=all')).toBe('');
    expect(await uncoveredPaths(worktree)).toEqual([]);
  });
});
