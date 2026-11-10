import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNS_DB_FILE, RunDatabase } from '../runs/run-database.ts';
import { gitMvCommands, handoffWorktreeLine, pathMapper, planProjectMigration, rewriteHandoffWorktreeLine } from './plan.ts';

/** The read-only planner and its path rules (hearsay-tools/cezarion#3088). */

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function scratch(): string {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-migration-plan-'));
  roots.push(root);
  return root;
}

function repository(): { root: string; source: string } {
  const root = scratch();
  execFileSync('git', ['init', '-q', root]);
  const source = join(root, '.ai/cezar');
  mkdirSync(source, { recursive: true });
  return { root, source };
}

describe('the path mapping', () => {
  it('follows moved items in the root form each path was stored in, and keeps tracked, claimed and outside paths', () => {
    const base = scratch();
    const realRoot = join(base, 'real');
    const source = join(realRoot, '.ai/cezar');
    const destination = join(realRoot, '.ai/squawk');
    mkdirSync(join(source, 'worktrees/a'), { recursive: true });
    mkdirSync(join(source, 'workflows'), { recursive: true });
    writeFileSync(join(source, 'workflows/flow.yaml'), '');
    writeFileSync(join(source, 'cockpit.lock'), '');
    symlinkSync(realRoot, join(base, 'alias'));
    const alias = join(base, 'alias');
    const map = pathMapper({ roots: [alias, realRoot], realRoot, source, destination, tracked: new Set(['.ai/cezar/workflows/flow.yaml']),
      moves: [{ from: join(source, 'worktrees'), to: join(destination, 'worktrees'), kind: 'directory' }] });
    expect(map(join(source, 'worktrees/a/file'))).toBe(join(destination, 'worktrees/a/file'));
    expect(map(join(alias, '.ai/cezar/worktrees/a'))).toBe(join(alias, '.ai/squawk/worktrees/a'));
    // A path to something already gone follows the directory, as its item would have.
    expect(map(join(source, 't/1234abcd/exit'))).toBe(join(destination, 't/1234abcd/exit'));
    expect(map(join(source, 'workflows/flow.yaml'))).toBeUndefined();
    expect(map(join(source, 'workflows'))).toBeUndefined();
    expect(map(join(source, 'cockpit.lock.reclaim'))).toBeUndefined();
    expect(map(source)).toBeUndefined();
    expect(map(join(realRoot, 'src/file.ts'))).toBeUndefined();
    expect(map(join(base, 'other/.ai/cezar/worktrees/a'))).toBeUndefined();
    expect(map(`${source}-other/worktrees/a`)).toBeUndefined();
  });

  it('quotes every git mv operand and creates each new parent first', () => {
    expect(gitMvCommands('/repo', [])).toEqual([]);
    expect(gitMvCommands("/re'po", [{ from: ".ai/cezar/workflows/it's `x` $(y).yaml", to: ".ai/squawk/workflows/it's `x` $(y).yaml" },
      { from: '.ai/cezar/context.yaml', to: '.ai/squawk/context.yaml' }])).toEqual([
      "cd -- '/re'\\''po'",
      "mkdir -p -- '.ai/squawk/workflows'",
      "mkdir -p -- '.ai/squawk'",
      "git mv -- '.ai/cezar/workflows/it'\\''s `x` $(y).yaml' '.ai/squawk/workflows/it'\\''s `x` $(y).yaml'",
      "git mv -- '.ai/cezar/context.yaml' '.ai/squawk/context.yaml'",
    ]);
  });

  it('edits only the seeded worktree line of a handoff, and only while it names the old path', () => {
    const text = '# Handoff — has **Worktree:** /old in its title\n\n**Task id:** x\n**Worktree:** /old\n\n## Goal\n\n**Worktree:** /old\n';
    expect(handoffWorktreeLine(text)).toBe('/old');
    expect(rewriteHandoffWorktreeLine(text, '/old', '/new')).toBe(text.replace('**Task id:** x\n**Worktree:** /old', '**Task id:** x\n**Worktree:** /new'));
    expect(rewriteHandoffWorktreeLine(text, '/elsewhere', '/new')).toBe(text);
    expect(handoffWorktreeLine('# Handoff\n\n## Goal\n\n**Worktree:** /old\n')).toBeUndefined();
    expect(rewriteHandoffWorktreeLine('# Handoff\n\n## Goal\n\n**Worktree:** /old\n', '/old', '/new')).toBe('# Handoff\n\n## Goal\n\n**Worktree:** /old\n');
  });
});

describe('the planner', () => {
  it('has nothing to do for a project without the legacy directory', async () => {
    const root = scratch();
    expect(await planProjectMigration(root)).toMatchObject({ moves: [], rewrites: [], blockers: [], conflicts: [] });
  });

  it('blocks on a journal, a redirected or replaced directory, a non-Git project and unreadable evidence', async () => {
    const plain = scratch();
    mkdirSync(join(plain, '.ai/cezar'), { recursive: true });
    expect((await planProjectMigration(plain)).blockers).toEqual([expect.stringContaining('Git cannot list the tracked files')]);

    const { root, source } = repository();
    writeFileSync(join(root, '.ai/squawk-migration.json'), '{}');
    mkdirSync(join(source, 'runs'));
    writeFileSync(join(source, 'runs/1.execution.json'), '{ not json');
    const blockers = (await planProjectMigration(root)).blockers;
    expect(blockers).toEqual([expect.stringContaining('unfinished project migration journal'), expect.stringContaining('1.execution.json')]);

    const linked = repository();
    rmSync(linked.source, { recursive: true });
    mkdirSync(join(linked.root, 'elsewhere'));
    symlinkSync(join(linked.root, 'elsewhere'), linked.source);
    expect((await planProjectMigration(linked.root)).blockers).toEqual([expect.stringContaining('is not a directory')]);

    const replaced = repository();
    writeFileSync(join(replaced.root, '.ai/squawk'), 'a file');
    expect((await planProjectMigration(replaced.root)).blockers).toEqual([expect.stringContaining('exists and is not a directory')]);
  });

  it('blocks on a run store this build has not opened, and on runs.json that was never imported', async () => {
    const old = repository();
    const db = new DatabaseSync(join(old.source, RUNS_DB_FILE));
    db.exec('PRAGMA user_version = 3');
    db.close();
    expect((await planProjectMigration(old.root)).blockers).toEqual([expect.stringContaining("not at this build's schema")]);

    const unimported = repository();
    RunDatabase.open(join(unimported.source, RUNS_DB_FILE)).close();
    writeFileSync(join(unimported.source, 'runs.json'), '[]');
    expect((await planProjectMigration(unimported.root)).blockers).toEqual([expect.stringContaining('has not been imported into')]);

    const legacyOnly = repository();
    writeFileSync(join(legacyOnly.source, 'runs.json'), '[]');
    expect((await planProjectMigration(legacyOnly.root)).blockers).toEqual([expect.stringContaining('has not been imported into a run store')]);
  });
});
