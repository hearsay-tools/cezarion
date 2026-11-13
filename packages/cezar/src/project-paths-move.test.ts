import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import { noticeLegacyProject, projectMoveMarked, projectPaths } from './project-paths.ts';
import { moveProjectWhenIdle } from './project-migration/auto.ts';
import { initCommand } from './project-commands.ts';
import { CockpitOwnership } from './server/cockpit-ownership.ts';
import { seedRuns } from './runs/run-store.testkit.ts';
import { RunStore } from './runs/store.ts';

describe('project reads of an unmoved project', () => {
  it('reads both trees, writes legacy, and prints one notice', () => {
    const repo = mkdtempSync(join(tmpdir(), 'project-switch-'));
    mkdirSync(join(repo, '.ai/cezar'), { recursive: true });
    const paths = projectPaths(repo);
    const old = makeRunRecord({ status: RUN_STATUS.done, title: 'legacy' });
    const fallback = makeRunRecord({ status: RUN_STATUS.done, title: 'fallback' });
    seedRuns(paths.write, [old]);
    seedRuns(paths.reads[1]!, [fallback]);
    const warnings: string[] = [];
    let store: RunStore | undefined;
    try {
      noticeLegacyProject(repo, { warn: line => warnings.push(line) });
      noticeLegacyProject(repo, { warn: line => warnings.push(line) });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/^\[hsq\]/);
      store = RunStore.open(paths.write, { keepLive: true });
      expect(new Set(store.listRunIds())).toEqual(new Set([old.id, fallback.id]));
      const run = store.createRun({ title: 'new', task: 'new', workflow: 'quick-task', steps: [] });
      store.flush();
      expect(store.sourceDataDir(run.id)).toBe(paths.write);
      expect(existsSync(join(repo, '.ai/squawk-migration.json'))).toBe(false);
    } finally { store?.close(); rmSync(repo, { recursive: true, force: true }); }
  });
});

it('starts a fresh project in squawk without creating legacy state', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'fresh-project-switch-'));
  try {
    execFileSync('git', ['init', '-q', repo]);
    expect(projectPaths(repo).write).toBe(join(repo, '.ai/squawk'));
    await initCommand(repo);
    expect(existsSync(join(repo, '.ai/squawk/workflows/fix-and-verify.yaml'))).toBe(true);
    expect(existsSync(join(repo, '.ai/cezar'))).toBe(false);
    expect(projectMoveMarked(repo)).toBe(true);
    mkdirSync(join(repo, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repo, '.ai/cezar/runs.json'), '[]');
    expect(projectPaths(repo).write).toBe(join(repo, '.ai/squawk'));
  } finally { rmSync(repo, { recursive: true, force: true }) }
});

it('prepares a fresh cockpit project once before its first ownership claim', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'fresh-cockpit-switch-'));
  try {
    execFileSync('git', ['init', '-q', repo]);
    expect(await moveProjectWhenIdle(repo, { homes: [] })).toEqual({ status: 'nothing' });
    expect(projectMoveMarked(repo)).toBe(true);
    const ownership = new CockpitOwnership();
    try {
      await ownership.acquire(projectPaths(repo).write);
      expect(existsSync(join(repo, '.ai/squawk/cockpit.lock'))).toBe(true);
    } finally { ownership.releaseAll(); }
    expect(projectPaths(repo).write).toBe(join(repo, '.ai/squawk'));
    expect(existsSync(join(repo, '.ai/cezar'))).toBe(false);
    expect(await moveProjectWhenIdle(repo, { homes: [] })).toEqual({ status: 'nothing' });
  } finally { rmSync(repo, { recursive: true, force: true }) }
});

it('prints one notice when the automatic move must wait', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'busy-project-switch-'));
  const warnings: string[] = [];
  const warn = vi.spyOn(console, 'warn').mockImplementation(line => { warnings.push(String(line)); });
  try {
    execFileSync('git', ['init', '-q', repo]);
    mkdirSync(join(repo, '.ai/cezar'), { recursive: true });
    writeFileSync(join(repo, '.ai/cezar/runs.json'), JSON.stringify([makeRunRecord({ status: RUN_STATUS.running, title: 'busy task' })]));
    expect((await moveProjectWhenIdle(repo, { homes: [] })).status).toBe('blocked');
    noticeLegacyProject(repo);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/^\[hsq\] Project /);
    expect(warnings[0]).toContain('has not been imported into a run store');
  } finally { warn.mockRestore(); rmSync(repo, { recursive: true, force: true }) }
});

it('moves past a live task: a running task alone never blocks the automatic move', async () => {
  const repo = mkdtempSync(join(tmpdir(), 'live-task-switch-'));
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  try {
    execFileSync('git', ['init', '-q', repo]);
    seedRuns(join(repo, '.ai/cezar'), [makeRunRecord({ status: RUN_STATUS.running, title: 'busy task' })]);
    expect((await moveProjectWhenIdle(repo, { homes: [] })).status).toBe('moved');
    expect(projectPaths(repo).write).toBe(join(repo, '.ai/squawk'));
  } finally { warn.mockRestore(); rmSync(repo, { recursive: true, force: true }) }
});

it.each(['symlink', 'dangling symlink', 'file'])('keeps a fresh project on legacy paths when squawk is a %s', async kind => {
  const repo = mkdtempSync(join(tmpdir(), 'unsafe-fresh-project-'));
  const outside = mkdtempSync(join(tmpdir(), 'outside-fresh-project-'));
  try {
    execFileSync('git', ['init', '-q', repo]);
    mkdirSync(join(repo, '.ai'));
    const destination = join(repo, '.ai/squawk');
    if (kind === 'file') writeFileSync(destination, 'keep');
    else symlinkSync(kind === 'symlink' ? outside : join(outside, 'missing'), destination, 'dir');
    expect(projectPaths(repo).write).toBe(join(repo, '.ai/cezar'));
    await initCommand(repo);
    await moveProjectWhenIdle(repo, { homes: [] });
    expect(projectMoveMarked(repo)).toBe(false);
    expect(projectPaths(repo).write).toBe(join(repo, '.ai/cezar'));
    expect(existsSync(join(repo, '.ai/cezar/workflows/fix-and-verify.yaml'))).toBe(true);
    expect(existsSync(join(outside, 'workflows'))).toBe(false);
    expect(existsSync(join(outside, 'skills'))).toBe(false);
  } finally {
    rmSync(repo, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
