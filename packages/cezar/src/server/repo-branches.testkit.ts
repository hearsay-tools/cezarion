/** Git fixtures, run records and a fake forge for the branch classifier and sweep tests. */
import { execFile } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { branchOwnerOf, type RunRecord, type RunStatus } from '../runs/store.ts';
import type { BranchForge, ForgePr } from './repo-branches.ts';

const exec = promisify(execFile);
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

/** Records as the branch owners `RunStore.listBranchOwners` would list. */
export const owners = (runs: readonly RunRecord[]) => runs.flatMap((run) => branchOwnerOf(run) ?? []);

export async function git(cwd: string, ...args: string[]): Promise<string> {
  return (await exec('git', [...GIT_ID, ...args], { cwd })).stdout.trim();
}

export async function commit(cwd: string, file: string, message: string): Promise<string> {
  writeFileSync(join(cwd, file), `${message}\n`);
  await git(cwd, 'add', '-A');
  await git(cwd, 'commit', '-q', '-m', message);
  return git(cwd, 'rev-parse', 'HEAD');
}

/** A task branch forked from `from` with `commits` commits of its own; leaves `main` checked out. */
export async function taskBranch(cwd: string, name: string, commits: number, from = 'main'): Promise<string> {
  await git(cwd, 'checkout', '-q', '-b', name, from);
  for (let i = 0; i < commits; i++) await commit(cwd, `${name.replace('/', '-')}-${i}.txt`, `${name} work ${i}`);
  const tip = await git(cwd, 'rev-parse', 'HEAD');
  await git(cwd, 'checkout', '-q', 'main');
  return tip;
}

export function runRecord(id: string, status: RunStatus, extra: Partial<RunRecord> = {}): RunRecord {
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

/** A forge that answers from fixed tables and records what it was asked. `incomplete` heads come
 *  back named incomplete, without their PRs. */
export function fakeForge(opts: { states?: Record<number, ForgePr['state']>; prs?: ForgePr[]; available?: boolean; incomplete?: string[] } = {}) {
  const calls = { prStates: 0, prsForHeads: 0, heads: [] as string[] };
  const forge: BranchForge = {
    async prStates(_root, numbers) {
      calls.prStates++;
      if (opts.available === false) return { available: false, states: {} };
      return { available: true, states: Object.fromEntries(numbers.flatMap((n) => (opts.states?.[n] ? [[n, opts.states[n]]] : []))) };
    },
    async prsForHeads(_root, heads) {
      calls.prsForHeads++;
      calls.heads.push(...heads);
      if (opts.available === false) return { available: false, prs: [], incomplete: new Set(heads) };
      const incomplete = new Set(heads.filter((head) => opts.incomplete?.includes(head)));
      return { available: true, prs: (opts.prs ?? []).filter((pr) => heads.includes(pr.headRefName) && !incomplete.has(pr.headRefName)), incomplete };
    },
  };
  return { forge, calls };
}

/** A PR merged into `base` at `tip`; `onMain` is the commit the merge put on the base. */
export function mergedPr(number: number, branch: string, tip: string, onMain: string, base = 'main'): ForgePr {
  return {
    number,
    url: `https://github.com/acme/demo/pull/${number}`,
    headRefName: branch,
    baseRefName: base,
    headRefOid: tip,
    mergeCommitOid: onMain,
    state: 'merged',
  };
}

/** A bare `origin` for `root`, with `main` pushed and `origin/HEAD` naming `origin/main`, as a clone
 *  leaves it. */
export async function addOrigin(root: string, origin: string): Promise<void> {
  await git(origin, 'init', '-q', '--bare', '-b', 'main');
  await git(root, 'remote', 'add', 'origin', origin);
  await git(root, 'push', '-q', '-u', 'origin', 'main');
  await git(root, 'symbolic-ref', 'refs/remotes/origin/HEAD', 'refs/remotes/origin/main');
}
