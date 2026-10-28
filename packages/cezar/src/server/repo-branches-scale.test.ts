import { execFileSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { RunRecord } from '../runs/store.ts';
import { branchOwnerOf } from '../runs/store.ts';
import { classifyBranches, readRepoBranchCounts, readRepoBranches, type BranchForge, type ClassifyInput } from './repo-branches.ts';

/**
 * hearsay-tools/cezarion#2029: a repository with 1,000+ task branches must never get one `git`
 * process per branch at once. A `git` shim on PATH records how many shims are alive when each
 * starts, so the peak is measured outside the module under test. Each shim lingers a little, as a
 * git on a large repository would, so processes that run together are seen together.
 */

const BRANCHES = 1_200;
const GIT_CONCURRENCY_CAP = 6;
const GIT_ID = ['-c', 'user.name=test', '-c', 'user.email=test@local'];

let dir: string;
let repo: string;
let shim: string;
let realGit: string;
let savedPath: string | undefined;
let runs: RunRecord[];

const noForge: BranchForge = {
  async prStates() { return { available: true, states: {} }; },
  async listPrs() { return { available: true, prs: [] }; },
};

function sh(cwd: string, args: string[], input?: string): string {
  return execFileSync(realGit, [...GIT_ID, ...args], { cwd, encoding: 'utf8', ...(input === undefined ? {} : { input }) }).trim();
}

/** Each shim run as `<alive count> <first git argument>`, oldest first. */
function shimLog(): Array<{ alive: number; command: string }> {
  let text = '';
  try { text = readFileSync(join(shim, 'log'), 'utf8'); } catch { return []; }
  return text.split('\n').filter(Boolean).map((line) => {
    const [alive = '0', command = ''] = line.split(' ');
    return { alive: Number(alive), command };
  });
}

function input(): ClassifyInput {
  return {
    root: repo,
    runs: runs.flatMap((run) => branchOwnerOf(run) ?? []),
    isActive: () => false,
    currentBranch: 'main',
    hasRemote: false,
    forge: noForge,
  };
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'cez-branch-scale-'));
  repo = join(dir, 'repo');
  shim = join(dir, 'shim');
  mkdirSync(repo);
  mkdirSync(join(shim, 'live'), { recursive: true });
  realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  sh(repo, ['init', '-q', '-b', 'main']);
  writeFileSync(join(repo, 'a.txt'), 'base\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-q', '-m', 'base']);
  const base = sh(repo, ['rev-parse', 'HEAD']);
  // One commit off main that every task branch carries: each branch is one commit ahead, so it is
  // not landed and its diff stat is computed.
  writeFileSync(join(repo, 'b.txt'), 'work\n');
  sh(repo, ['add', '-A']);
  sh(repo, ['commit', '-q', '-m', 'work']);
  const work = sh(repo, ['rev-parse', 'HEAD']);
  sh(repo, ['reset', '-q', '--hard', base]);
  const names = Array.from({ length: BRANCHES }, (_, i) => `cez/${String(i).padStart(8, '0')}`);
  // A creation entry at the base, then a commit entry at the tip — what a task's own work leaves.
  sh(repo, ['update-ref', '--create-reflog', '-m', 'branch: Created from main', '--stdin'], names.map((n) => `create refs/heads/${n} ${base}\n`).join(''));
  sh(repo, ['update-ref', '--create-reflog', '-m', 'commit: work', '--stdin'], names.map((n) => `update refs/heads/${n} ${work} ${base}\n`).join(''));
  // Every branch but the last ten has a finished run; those ten are orphans.
  runs = names.slice(0, BRANCHES - 10).map((name, i) => {
    const run = {
      id: `${name.slice(4)}-0000-4000-8000-${String(i).padStart(12, '0')}`,
      title: `task ${i}`,
      workflow: 'quick-task',
      task: 't',
      status: 'done',
      steps: [],
      createdAt: '2026-09-01T00:00:00.000Z',
      archived: false,
      branch: name,
    };
    return run as unknown as RunRecord;
  });
  writeFileSync(join(shim, 'git'), [
    '#!/bin/sh',
    `m="${shim}/live/$$"`,
    ': > "$m"',
    `n=$(ls "${shim}/live" | wc -l)`,
    `echo "$n $1" >> "${shim}/log"`,
    `"${realGit}" "$@"`,
    's=$?',
    // A git on a large repository takes far longer than one on this fixture: without the pause,
    // each process ends before the next starts, and an unbounded fan-out reads as a small peak.
    'sleep 0.05',
    'rm -f "$m"',
    'exit $s',
    '',
  ].join('\n'));
  chmodSync(join(shim, 'git'), 0o755);
  savedPath = process.env.PATH;
  process.env.PATH = `${shim}${delimiter}${savedPath ?? ''}`;
});

afterEach(() => {
  rmSync(join(shim, 'log'), { force: true });
});

afterAll(() => {
  process.env.PATH = savedPath;
  rmSync(dir, { recursive: true, force: true });
});

describe('branch scan on a large repository (hearsay-tools/cezarion#2029)', () => {
  // bound: 1,200 shell-wrapped git spawns on a loaded host; the default 5 s is too tight.
  it('classifies 1,200 branches with at most the cap of git processes alive at once', { timeout: 120_000 }, async () => {
    const { payload } = await classifyBranches(input());
    expect(payload.counts.notLanded).toBe(BRANCHES);
    expect(payload.branches.filter((b) => b.class === 'not-landed')).toHaveLength(BRANCHES - 10);
    expect(payload.branches.filter((b) => b.class === 'orphan')).toHaveLength(10);
    expect(payload.branches.every((b) => b.class === 'active' || b.diffStat?.additions === 1)).toBe(true);
    const log = shimLog();
    expect(log.length).toBeGreaterThan(0);
    expect(Math.max(...log.map((row) => row.alive))).toBeLessThanOrEqual(GIT_CONCURRENCY_CAP);
    // Fork points come from a few bulk reflog reads, not one per branch.
    expect(log.filter((row) => row.command === 'log').length).toBeLessThanOrEqual(Math.ceil(BRANCHES / 256));
  });

  // bound: see above.
  it('counts without a diff stat per branch, in a handful of git processes', { timeout: 120_000 }, async () => {
    const counts = await readRepoBranchCounts(input());
    expect(counts.counts).toEqual({ notLanded: BRANCHES, cleanup: 0 });
    expect(counts.allBranches).toBe(BRANCHES + 1); // and main
    const log = shimLog();
    expect(log.filter((row) => row.command === 'diff')).toEqual([]);
    expect(log.length).toBeLessThan(30);
  });

  // bound: see above.
  it('reuses each diff stat while its base and tip stay, and shares one scan between concurrent requests', { timeout: 120_000 }, async () => {
    const [a, b] = await Promise.all([readRepoBranches(input()), readRepoBranches(input())]);
    expect(b).toBe(a);
    rmSync(join(shim, 'log'), { force: true });
    // A run field change busts the classification, but the diff stats stay cached.
    runs = runs.map((run, i) => (i === 0 ? { ...run, title: 'renamed' } : run));
    const again = await readRepoBranches(input());
    expect(again.branches.find((row) => row.runId === runs[0]?.id)?.title).toBe('renamed');
    expect(shimLog().filter((row) => row.command === 'diff')).toEqual([]);
  });
});
