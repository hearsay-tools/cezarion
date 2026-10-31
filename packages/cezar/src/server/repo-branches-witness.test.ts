import { execFile, execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOwnedWorkspace } from '../delegation/workspace.ts';
import type { WorktreeGit } from '../git-worktree-lock.ts';
import { commit, fakeForge, owners, runRecord, taskBranch } from './repo-branches.testkit.ts';
import { branchOwnerOf, type RunRecord } from '../runs/store.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];
const hook = vi.hoisted(() => ({
  beforeUpdateRef: undefined as (() => Promise<void>) | undefined,
  beforeOperation: undefined as (() => Promise<void>) | undefined,
  gitResult: undefined as ((args: string[]) => { ok: boolean; stdout: string; stderr: string } | undefined) | undefined,
  command: undefined as ((args: string[]) => ReturnType<WorktreeGit> | undefined) | undefined,
}));

// Keep fixture setup on the real promisified executable; classification can supply exact output.
vi.mock('node:child_process', async (original) => {
  const real = await original<typeof import('node:child_process')>();
  const { promisify } = await import('node:util');
  const controlled = (...args: unknown[]) => {
    const result = args[0] === 'git' && Array.isArray(args[1]) ? hook.gitResult?.(args[1]) : undefined;
    const callback = args.at(-1);
    if (!result || typeof callback !== 'function') return Reflect.apply(real.execFile, undefined, args);
    queueMicrotask(() => callback(result.ok ? null : new Error('controlled git failure'), result.stdout, result.stderr));
    return undefined;
  };
  Object.defineProperty(controlled, promisify.custom, { value: Reflect.get(real.execFile, promisify.custom) });
  return { ...real, execFile: controlled };
});

// The lock seam covers two windows: before the locked operation rechecks protection, and after
// it reads its witness but before the ref transaction. Commands can also return a controlled
// failure or partial output. Outside processes (a shell, an IDE) do not follow cezar's lock.
vi.mock('../git-worktree-lock.ts', async (original) => {
  const real = await original<typeof import('../git-worktree-lock.ts')>();
  return {
    ...real,
    withWorktreeMutation: <T>(root: string, operation: Parameters<typeof real.withWorktreeMutation<T>>[1]) =>
      real.withWorktreeMutation(root, async (git) => {
        await hook.beforeOperation?.();
        return operation(async (cwd, args, timeout, input) => {
          const injected = hook.command?.(args);
          if (injected) return injected;
          if (args[0] === 'update-ref' && hook.beforeUpdateRef) await hook.beforeUpdateRef();
          return git(cwd, args, timeout, input);
        });
      }),
  };
});

const { attributeLog, classifyBranches, deleteBranches } = await import('./repo-branches.ts');

async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', [...GIT_ID, ...args], { cwd })).stdout.trim();
}

describe('branch deletion with a controlled mutation lock', () => {
  let root: string;
  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-branches-witness-'));
    await git(root, 'init', '-q', '-b', 'main');
    writeFileSync(join(root, 'base.txt'), 'base\n');
    await git(root, 'add', '-A');
    await git(root, 'commit', '-q', '-m', 'base');
  });
  afterEach(() => {
    hook.beforeUpdateRef = undefined;
    hook.beforeOperation = undefined;
    hook.command = undefined;
    rmSync(root, { recursive: true, force: true });
  });

  describe('deleting an empty branch whose commits another ref keeps (issue 08)', () => {
    it('refuses when that ref goes between the check and the delete', async () => {
      await git(root, 'checkout', '-q', '-b', 'topic');
      writeFileSync(join(root, 'topic.txt'), 'unmerged\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '-q', '-m', 'topic work');
      const tip = await git(root, 'rev-parse', 'HEAD');
      await git(root, 'checkout', '-q', 'main');
      await git(root, 'branch', 'cez/aaaaaaaa', 'topic');
      hook.beforeUpdateRef = async () => {
        hook.beforeUpdateRef = undefined;
        await git(root, 'branch', '-D', 'topic');
      };
      const runs = [{
        id: 'aaaaaaaa-1', title: 't', workflow: 'w', task: 't', status: 'done', steps: [],
        createdAt: '2026-09-01T00:00:00.000Z', archived: false, branch: 'cez/aaaaaaaa', baseBranch: 'topic',
      } as unknown as RunRecord].flatMap((run) => branchOwnerOf(run) ?? []);
      const result = await deleteBranches(
        { root, runs, isActive: () => false, currentBranch: 'main', hasRemote: false, forge: { prStates: async () => ({ available: true, states: {} }), prsForHeads: async () => ({ available: true, prs: [], incomplete: new Set<string>() }) } },
        ['cez/aaaaaaaa'],
      );
      expect(result.deleted).toEqual([]);
      expect(await git(root, 'rev-parse', 'cez/aaaaaaaa')).toBe(tip);
    });
  });

  describe('branch deletion guard regressions (hearsay-tools/cezarion#2291)', () => {
    function input() {
      return { root, runs: [], isActive: () => false, currentBranch: 'main', hasRemote: false, forge: fakeForge().forge };
    }

    it('refuses a branch checked out after classification at the mutation lock', async () => {
      const name = 'cez/checkout';
      await git(root, 'branch', name);
      const tip = await git(root, 'rev-parse', name);
      hook.beforeOperation = async () => { await git(root, 'worktree', 'add', '-q', join(root, '.wt'), name); };
      expect(await deleteBranches(input(), [name])).toEqual({
        deleted: [], refused: [{ name, reason: 'checked out in a worktree' }],
      });
      expect(await git(root, 'rev-parse', name)).toBe(tip);
      expect(await git(join(root, '.wt'), 'symbolic-ref', '--short', 'HEAD')).toBe(name);
    });

    it('refuses a delegated workspace owner appearing after classification at the mutation lock', async () => {
      const tip = await git(root, 'rev-parse', 'HEAD');
      const workspace = await createOwnedWorkspace(root, 'aaaaaaaa-1111-4111-8111-111111111111', tip);
      await git(root, 'worktree', 'remove', '--force', workspace.path);
      const receipts = join(root, '.git', 'cezar-owned-workspaces');
      const hidden = join(root, '.git', 'hidden-receipts');
      renameSync(receipts, hidden);
      hook.beforeOperation = async () => { renameSync(hidden, receipts); };
      expect(await deleteBranches(input(), [workspace.branch])).toEqual({
        deleted: [], refused: [{ name: workspace.branch, reason: 'owned by a delegated workspace' }],
      });
      expect(await git(root, 'rev-parse', workspace.branch)).toBe(tip);
    });

    it('refuses uncertain ownership appearing at the mutation lock', async () => {
      const name = 'cez/uncertain';
      await git(root, 'branch', name);
      hook.beforeOperation = async () => {
        const receipts = join(root, '.git', 'cezar-owned-workspaces');
        mkdirSync(receipts);
        writeFileSync(join(receipts, 'broken.json'), '{');
      };
      expect(await deleteBranches(input(), [name])).toEqual({
        deleted: [], refused: [{ name, reason: 'owned by a delegated workspace' }],
      });
      expect(await git(root, 'rev-parse', name)).toBe(await git(root, 'rev-parse', 'main'));
    });

    it('refuses a symbolic alias substituted at the mutation lock', async () => {
      const name = 'cez/alias';
      await git(root, 'branch', name);
      const tip = await git(root, 'rev-parse', 'main');
      hook.beforeOperation = async () => { await git(root, 'symbolic-ref', `refs/heads/${name}`, 'refs/heads/main'); };
      expect(await deleteBranches(input(), [name])).toEqual({
        deleted: [], refused: [{ name, reason: 'not a cezar task branch' }],
      });
      expect(await git(root, 'rev-parse', 'main')).toBe(tip);
      expect(await git(root, 'symbolic-ref', `refs/heads/${name}`)).toBe('refs/heads/main');
    });

    it('keeps completed deletions and refusals when a later locked command throws, and releases claims', async () => {
      const names = ['cez/aaaaaaaa', 'cez/bbbbbbbb', 'cez/cccccccc', 'cez/dddddddd'];
      for (const name of names) await git(root, 'branch', name);
      const releases = names.map(() => vi.fn());
      let claim = 0;
      const claimRuns = () => releases[claim++]!;
      hook.beforeOperation = async () => { await git(root, 'worktree', 'add', '-q', join(root, '.wt'), names[1]!); };
      hook.command = (args) => {
        if (args[0] === 'symbolic-ref' && args[2] === `refs/heads/${names[2]}`) return Promise.reject(new Error('lost keeper'));
        return undefined;
      };
      const runs = owners(names.map((branch, i) => runRecord(`${'abcd'[i]!.repeat(8)}-1`, 'done', { branch })));
      expect(await deleteBranches({ ...input(), runs, claimRuns }, names)).toEqual({
        deleted: [names[0]],
        refused: [
          { name: names[1], reason: 'checked out in a worktree' },
          { name: names[2], reason: 'the repository is busy — try again' },
          { name: names[3], reason: 'the repository is busy — try again' },
        ],
      });
      for (const release of releases) expect(release).toHaveBeenCalledOnce();
      expect(await git(root, 'branch', '--list', names[0]!)).toBe('');
      for (const name of names.slice(1)) expect(await git(root, 'branch', '--list', name)).toContain(name);
    });

    it('refuses an empty branch when its retention lookup fails with partial output', async () => {
      await git(root, 'checkout', '-q', '-b', 'topic');
      writeFileSync(join(root, 'topic.txt'), 'unmerged\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '-q', '-m', 'topic');
      const tip = await git(root, 'rev-parse', 'HEAD');
      await git(root, 'checkout', '-q', 'main');
      const name = 'cez/aaaaaaaa';
      await git(root, 'branch', name, 'topic');
      hook.command = (args) => args[0] === 'for-each-ref'
        ? Promise.resolve({ ok: false, stdout: `refs/heads/topic\0${tip}\0\n`, stderr: 'interrupted' })
        : undefined;
      const runs = owners([runRecord('aaaaaaaa-1', 'done', { baseBranch: tip })]);
      expect(await deleteBranches({ ...input(), runs }, [name])).toEqual({
        deleted: [], refused: [{ name, reason: 'its commits are not on main and only branches in this request keep them — delete it on its own, with confirmation' }],
      });
      expect(await git(root, 'rev-parse', name)).toBe(tip);
    });

    it('does not use symbolic or incomplete refs as retention witnesses', async () => {
      await git(root, 'checkout', '-q', '-b', 'topic');
      writeFileSync(join(root, 'topic.txt'), 'unmerged\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '-q', '-m', 'topic');
      const tip = await git(root, 'rev-parse', 'HEAD');
      await git(root, 'checkout', '-q', 'main');
      const name = 'cez/aaaaaaaa';
      await git(root, 'branch', name, 'topic');
      hook.command = (args) => args[0] === 'for-each-ref'
        ? Promise.resolve({ ok: true, stdout: [
          `refs/heads/${name}\0${tip}\0`,
          `refs/remotes/origin/HEAD\0${tip}\0refs/heads/${name}`,
          `\0${tip}\0`, 'refs/heads/missing-tip\0\0', '',
        ].join('\n'), stderr: '' })
        : undefined;
      const runs = owners([runRecord('aaaaaaaa-1', 'done', { baseBranch: tip })]);
      expect(await deleteBranches({ ...input(), runs }, [name])).toEqual({
        deleted: [], refused: [{ name, reason: 'its commits are not on main and only branches in this request keep them — delete it on its own, with confirmation' }],
      });
      expect(await git(root, 'rev-parse', name)).toBe(tip);
    });

    it('uses the next complete retention witness after a row with no tip', async () => {
      await git(root, 'checkout', '-q', '-b', 'topic');
      writeFileSync(join(root, 'topic.txt'), 'unmerged\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '-q', '-m', 'topic');
      const tip = await git(root, 'rev-parse', 'HEAD');
      await git(root, 'checkout', '-q', 'main');
      const name = 'cez/aaaaaaaa';
      await git(root, 'branch', name, 'topic');
      hook.command = (args) => args[0] === 'for-each-ref'
        ? Promise.resolve({ ok: true, stdout: `refs/heads/missing-tip\nrefs/heads/topic\0${tip}\n`, stderr: '' })
        : undefined;
      const runs = owners([runRecord('aaaaaaaa-1', 'done', { baseBranch: tip })]);
      expect(await deleteBranches({ ...input(), runs }, [name])).toEqual({ deleted: [name], refused: [] });
      expect(await git(root, 'rev-parse', 'topic')).toBe(tip);
    });

    it('returns empty fields for incomplete dropped-log rows', async () => {
      const name = 'cez/orphan';
      await git(root, 'checkout', '-q', '-b', name);
      writeFileSync(join(root, 'work.txt'), 'work\n');
      await git(root, 'add', '-A');
      await git(root, 'commit', '-q', '-m', 'work');
      const tip = await git(root, 'rev-parse', 'HEAD');
      await git(root, 'checkout', '-q', 'main');
      hook.command = (args) => args[0] === 'log'
        ? Promise.resolve({ ok: true, stdout: `${tip}\n`, stderr: '' })
        : undefined;
      expect(await deleteBranches(input(), [name], name)).toEqual({
        deleted: [name], refused: [], dropped: [{ sha: tip, subject: '' }],
      });
    });

  });
});

/** Controlled git output exercises formats and failures that a real repository seldom produces. */
describe('classification with controlled git output (hearsay-tools/cezarion#2292)', () => {
  let root: string;
  let shim: string;
  let realGit: string;
  let savedPath: string | undefined;
  let tip: string;
  let base: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'cez-classification-output-'));
    shim = join(root, 'bin');
    mkdirSync(shim);
    realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    await git(root, 'init', '-q', '-b', 'main');
    base = await commit(root, 'base.txt', 'base');
    tip = await taskBranch(root, 'cez/aaaaaaaa', 2);
    savedPath = process.env.PATH;
  });

  afterEach(() => {
    hook.gitResult = undefined;
    if (savedPath === undefined) delete process.env.PATH;
    else process.env.PATH = savedPath;
    rmSync(root, { recursive: true, force: true });
  });

  function output(rules: Array<{ prefix: string[]; stdout: string; code?: number }>) {
    writeFileSync(join(shim, 'responses.json'), JSON.stringify(rules));
    writeFileSync(join(shim, 'git'), `#!${process.execPath}
const fs = require('node:fs');
const cp = require('node:child_process');
const args = process.argv.slice(2);
const rules = JSON.parse(fs.readFileSync(${JSON.stringify(join(shim, 'responses.json'))}, 'utf8'));
const rule = rules.find((item) => item.prefix.every((arg, index) => args[index] === arg));
if (rule) {
  process.stdout.write(rule.stdout);
  process.exit(rule.code ?? 0);
}
const result = cp.spawnSync(${JSON.stringify(realGit)}, args, { stdio: 'inherit' });
process.exit(result.status ?? 1);
`);
    chmodSync(join(shim, 'git'), 0o755);
    process.env.PATH = `${shim}${delimiter}${savedPath ?? ''}`;
  }

  async function classify(configuredBase = 'main') {
    return classifyBranches({ root, configuredBase, currentBranch: 'main', runs: [],
      isActive: () => false, hasRemote: false, forge: fakeForge().forge,
    });
  }

  it('ignores failed head enumeration even when git emitted partial rows', async () => {
    output([{ prefix: ['for-each-ref', 'refs/heads', '--format=%(refname:lstrip=2)%00%(objectname)%00%(committerdate:iso-strict)%00%(symref)%00%(subject)'],
      stdout: `cez/aaaaaaaa\0${tip}\0date\0\0subject\n`, code: 1 }]);
    const { payload, tips } = await classify();
    expect(payload.branches).toEqual([]);
    expect(payload.counts).toEqual({ cleanup: 0, notLanded: 0 });
    expect([...tips]).toEqual([]);
    expect(payload.prStateKnown).toBe(true);
  });

  it('keeps complete head rows, joins subject fields, and drops rows missing a name or SHA', async () => {
    output([{ prefix: ['for-each-ref', 'refs/heads', '--format=%(refname:lstrip=2)%00%(objectname)%00%(committerdate:iso-strict)%00%(symref)%00%(subject)'],
      stdout: `\ncez/aaaaaaaa\0${tip}\0date\0\0first\0second\n\0${tip}\ncez/missing\ncez/nosha\0\n` }]);
    const { payload } = await classify();
    expect(payload.branches).toHaveLength(1);
    expect(payload.branches[0]).toMatchObject({ name: 'cez/aaaaaaaa', class: 'orphan', lastCommit: { sha: tip, at: 'date', subject: 'first\0second' } });
  });

  it('defaults absent head metadata without inventing a symbolic alias', async () => {
    output([{ prefix: ['for-each-ref', 'refs/heads', '--format=%(refname:lstrip=2)%00%(objectname)%00%(committerdate:iso-strict)%00%(symref)%00%(subject)'],
      stdout: `cez/aaaaaaaa\0${tip}\n` }]);
    const { payload } = await classify();
    expect(payload.branches).toHaveLength(1);
    expect(payload.branches[0]).toMatchObject({ name: 'cez/aaaaaaaa', class: 'orphan', lastCommit: { sha: tip, at: '', subject: '' } });
  });

  it('sorts unordered git rows by date and breaks equal dates by branch name', async () => {
    const names = ['cez/z', 'cez/new', 'cez/a', 'cez/old'];
    const dates = ['2025-01-02', '2025-02-01', '2025-01-02', '2025-01-01'];
    output([{ prefix: ['for-each-ref', 'refs/heads', '--format=%(refname:lstrip=2)%00%(objectname)%00%(committerdate:iso-strict)%00%(symref)%00%(subject)'],
      stdout: names.map((name, i) => `${name}\0${tip}\0${dates[i]}\0\0subject`).join('\n') }]);
    expect((await classify()).payload.branches.map((row) => row.name)).toEqual(['cez/new', 'cez/a', 'cez/z', 'cez/old']);
  });

  it('calls a branch at its fork point empty when it is on the base even without a retention lookup', async () => {
    await git(root, 'branch', 'cez/empty', base);
    output([{ prefix: ['for-each-ref', '--contains'], stdout: '', code: 1 }]);
    const result = await classifyBranches({ root, currentBranch: 'main', runs: owners([runRecord('empty', 'done', { branch: 'cez/empty', baseBranch: base })]),
      isActive: () => false, hasRemote: false, forge: fakeForge().forge,
    });
    expect(result.payload.branches.find((row) => row.name === 'cez/empty')?.class).toBe('empty');
  });

  it('leaves a merge without a matching second-parent ref unattributed', async () => {
    expect(await attributeLog(root, [{ hash: tip, subject: 'merge unrelated work', parents: [base, 'f'.repeat(40)], author: 'test', at: '', when: '' }], owners([runRecord('aaaaaaaa-1', 'done')]))).toEqual([null]);
  });

  it('uses a count fallback for failed or malformed batch counts', async () => {
    output([{ prefix: ['for-each-ref', 'refs/heads', `--format=%(refname:lstrip=2)%00%(ahead-behind:${base})`],
      stdout: `cez/aaaaaaaa\0${'0 0'}\n`, code: 1 }]);
    expect((await classify()).payload.branches.find((row) => row.name === 'cez/aaaaaaaa')?.ahead).toBe(2);
    output([{ prefix: ['for-each-ref', 'refs/heads', `--format=%(refname:lstrip=2)%00%(ahead-behind:${base})`],
      stdout: `cez/aaaaaaaa\0not-a-number 0\nmain\0\n` }]);
    const { payload } = await classify();
    expect(payload.branches.find((row) => row.name === 'cez/aaaaaaaa')).toMatchObject({ ahead: 2, class: 'orphan' });
  });

  it('counts all commits when there is no resolved base', async () => {
    const { payload, baseSha, baseFullRef } = await classify('missing');
    expect(baseSha).toBeNull();
    expect(baseFullRef).toBeNull();
    expect(payload.base).toBe('missing');
    expect(payload.branches.find((row) => row.name === 'cez/aaaaaaaa')).toMatchObject({ ahead: 3, class: 'orphan', diffStat: null });
  });

  it.each([{ stdout: '0\n', code: 1 }, { stdout: 'not-a-number\n', code: 0 }])('never calls unreadable counts merged (%j)', async (response) => {
    output([
      { prefix: ['for-each-ref', 'refs/heads', `--format=%(refname:lstrip=2)%00%(ahead-behind:${base})`], stdout: '', code: 1 },
      { prefix: ['rev-list', '--count'], ...response },
    ]);
    expect((await classify()).payload.branches.find((row) => row.name === 'cez/aaaaaaaa')).toMatchObject({ ahead: 0, class: 'orphan' });
  });
  it('refreshes diff stats when the configured global attribute file changes', async () => {
    const attributes = join(root, 'global-attributes');
    writeFileSync(attributes, '');
    await git(root, 'config', 'core.attributesFile', attributes);
    expect((await classify()).payload.branches.find((row) => row.name === 'cez/aaaaaaaa')?.diffStat).toEqual({ additions: 2, deletions: 0 });
    writeFileSync(attributes, '* -diff\n');
    expect((await classify()).payload.branches.find((row) => row.name === 'cez/aaaaaaaa')?.diffStat).toEqual({ additions: 0, deletions: 0 });
  });

  it('still computes a diff stat when the local attribute path cannot be read', async () => {
    hook.gitResult = (args) => args[0] === 'rev-parse' && args[1] === '--git-path'
      ? { ok: false, stdout: '', stderr: 'unavailable' } : undefined;
    expect((await classify()).payload.branches.find((row) => row.name === 'cez/aaaaaaaa')?.diffStat).toEqual({ additions: 2, deletions: 0 });
  });

  it('evicts the oldest diff stat once more than 5000 commit pairs are cached', async () => {
    const heads = Array.from({ length: 5001 }, (_, i) => ({ name: `cez/cache${i}`, sha: (i + 1).toString(16).padStart(40, '0') }));
    let selected = heads;
    let reads = 0;
    hook.gitResult = (args) => {
      if (args[0] === 'for-each-ref' && args[1] === 'refs/heads') {
        const stdout = args[2]?.includes('ahead-behind')
          ? selected.map((row) => `${row.name}\0${'1 0'}`).join('\n')
          : selected.map((row) => `${row.name}\0${row.sha}\0date\0\0work`).join('\n');
        return { ok: true, stdout, stderr: '' };
      }
      if (args[0] === 'diff') {
        reads++;
        return { ok: true, stdout: '1 file changed, 1 insertion(+)\n', stderr: '' };
      }
      return undefined;
    };
    const first = await classify();
    expect(first.payload.branches).toHaveLength(5001);
    expect(first.payload.branches.every((row) => row.diffStat?.additions === 1)).toBe(true);
    expect(reads).toBe(5001);
    selected = heads.slice(1, 2);
    expect((await classify()).payload.branches[0]?.diffStat).toEqual({ additions: 1, deletions: 0 });
    expect(reads).toBe(5001);
    selected = heads.slice(0, 1);
    expect((await classify()).payload.branches[0]?.diffStat).toEqual({ additions: 1, deletions: 0 });
    expect(reads).toBe(5002);
  });

});
