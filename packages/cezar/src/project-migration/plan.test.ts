import { execFileSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, statSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, describe, expect, it } from 'vitest';
import { makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RUNS_DB_FILE, RunDatabase } from '../runs/run-database.ts';
import { seedRuns } from '../runs/run-store.testkit.ts';
import { gitMvCommands, gitReportedPath, handoffWorktreeLine, pathMapper, planProjectMigration, redirectedComponent, rewriteHandoffWorktreeLine } from './plan.ts';

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

  it('edits only the seeded worktree line of a handoff, with LF or CRLF, and never prose', () => {
    const seeded = '# Handoff — has **Worktree:** /old in its title\n\n**Task id:** x\n**Workflow:** w\n**Branch:** b\n**Worktree:** /old\n\n## Goal\n\n**Worktree:** /old\n';
    expect(handoffWorktreeLine(seeded)).toBe('/old');
    expect(rewriteHandoffWorktreeLine(seeded, '/old', '/new')).toBe(seeded.replace('**Branch:** b\n**Worktree:** /old', '**Branch:** b\n**Worktree:** /new'));
    expect(rewriteHandoffWorktreeLine(seeded, '/elsewhere', '/new')).toBe(seeded);
    const crlf = seeded.replace('**Branch:** b\n', '').replaceAll('\n', '\r\n');
    expect(handoffWorktreeLine(crlf)).toBe('/old');
    expect(rewriteHandoffWorktreeLine(crlf, '/old', '/new')).toBe(crlf.replace('**Workflow:** w\r\n**Worktree:** /old\r\n', '**Workflow:** w\r\n**Worktree:** /new\r\n'));
    // No seeded worktree line (a task without a worktree): the same text in prose, before or after Goal, stays.
    for (const prose of ['# Handoff — t\r\n\r\n**Task id:** x\r\n**Workflow:** w\r\n\r\n## Goal\r\n\r\n**Worktree:** /old\r\n',
      '# Handoff — t\n\n**Task id:** x\n**Workflow:** w\n\n**Worktree:** /old\n## Goal\n', '# Notes\n**Worktree:** /old\n']) {
      expect(handoffWorktreeLine(prose)).toBeUndefined();
      expect(rewriteHandoffWorktreeLine(prose, '/old', '/new')).toBe(prose);
    }
  });
});

describe('paths Git reports and paths a move passes through', () => {
  it('reads Git for Windows forward slashes in the native form', () => {
    expect(gitReportedPath('C:/repo/.ai/cezar/worktrees/a', win32)).toBe('C:\\repo\\.ai\\cezar\\worktrees\\a');
    expect(gitReportedPath('/repo/.ai/cezar/worktrees/a')).toBe('/repo/.ai/cezar/worktrees/a');
  });

  it('finds the first component that is not a real directory', () => {
    const base = scratch();
    mkdirSync(join(base, 'a/b'), { recursive: true });
    mkdirSync(join(base, 'outside'));
    symlinkSync(join(base, 'outside'), join(base, 'a/link'));
    writeFileSync(join(base, 'a/file'), '');
    expect(redirectedComponent(base, join(base, 'a/b/missing/deeper'))).toBeUndefined();
    expect(redirectedComponent(base, join(base, 'a/link/x'))).toBe(join(base, 'a/link'));
    expect(redirectedComponent(base, join(base, 'a/file/x'))).toBe(join(base, 'a/file'));
    expect(redirectedComponent(join(base, 'a'), join(base, 'outside'))).toBe(join(base, 'outside'));
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
  it('refuses a destination directory under a tracked parent that is a symlink or a file', async () => {
    const { root, source } = repository();
    mkdirSync(join(source, 'workflows'));
    writeFileSync(join(source, 'workflows/flow.yaml'), 'tracked');
    execFileSync('git', ['add', '-f', '.ai/cezar/workflows/flow.yaml'], { cwd: root });
    writeFileSync(join(source, 'workflows/local.yaml'), 'untracked');
    const outside = join(scratch(), 'outside');
    mkdirSync(outside);
    mkdirSync(join(root, '.ai/squawk'));
    symlinkSync(outside, join(root, '.ai/squawk/workflows'));
    const plan = await planProjectMigration(root);
    expect(plan.conflicts).toEqual([{ path: join(root, '.ai/squawk/workflows'), reason: expect.stringContaining('nothing may move through it') }]);
    expect(plan.moves.map(move => move.from)).not.toContain(join(source, 'workflows/local.yaml'));

    const moved = repository();
    rmSync(join(moved.root, '.ai'), { recursive: true });
    mkdirSync(join(moved.root, 'elsewhere/cezar'), { recursive: true });
    symlinkSync(join(moved.root, 'elsewhere'), join(moved.root, '.ai'));
    expect((await planProjectMigration(moved.root)).blockers).toEqual([expect.stringContaining('is not a directory of this project')]);
  });

  it('reads a run store whose writer left a WAL file from a private copy, and leaves both files as they were', async () => {
    const { root, source } = repository();
    const staging = scratch();
    const first = join(source, 'worktrees/a');
    seedRuns(staging, [makeRunRecord({ id: 'r1', worktreePath: first })]);
    const writer = new DatabaseSync(join(staging, RUNS_DB_FILE));
    writer.exec('PRAGMA wal_autocheckpoint = 0');
    const second = join(source, 'worktrees/b');
    writer.prepare("UPDATE runs SET worktree_path = ?, data = json_set(data, '$.worktreePath', ?), summary = json_set(summary, '$.worktreePath', ?)").run(second, second, second);
    // A crashed writer: the database and its WAL, no shared-memory file.
    for (const name of [RUNS_DB_FILE, `${RUNS_DB_FILE}-wal`]) copyFileSync(join(staging, name), join(source, name));
    writer.close();
    const files = () => Object.fromEntries(readdirSync(source).map(name => [name, readFileSync(join(source, name)).toString('base64')]));
    const before = files();
    const plan = await planProjectMigration(root);
    expect(files()).toEqual(before);
    expect(existsSync(join(source, `${RUNS_DB_FILE}-shm`))).toBe(false);
    expect(plan.blockers).toEqual([]);
    expect(plan.rewrites.filter(rewrite => rewrite.kind === 'run-row').map(rewrite => rewrite.from)).toEqual([second, second, second]);
  });
  it('blocks when Git tracks the run store or run evidence, before any write', async () => {
    for (const path of ['runs.db', 'runs/1.handoff.md']) {
      const { root, source } = repository();
      mkdirSync(join(source, 'runs'), { recursive: true });
      if (path === 'runs.db') RunDatabase.open(join(source, RUNS_DB_FILE)).close();
      else writeFileSync(join(source, path), '# Handoff');
      execFileSync('git', ['add', '-f', `.ai/cezar/${path}`], { cwd: root });
      const plan = await planProjectMigration(root);
      expect(plan.blockers).toEqual([expect.stringContaining(`Git tracks run state the migration must move: .ai/cezar/${path}`)]);
      expect(plan.moves).toEqual([]);
    }
  });
  it('refuses to merge into an existing destination directory broader than its source', async () => {
    const { root, source } = repository();
    mkdirSync(join(source, 'runs'), { mode: 0o700 });
    chmodSync(join(source, 'runs'), 0o700);
    writeFileSync(join(source, 'runs/1.handoff.md'), '# Handoff');
    mkdirSync(join(root, '.ai/squawk/runs'), { recursive: true });
    chmodSync(join(root, '.ai/squawk/runs'), 0o755);
    chmodSync(join(root, '.ai/squawk'), statSync(source).mode & 0o777);
    const plan = await planProjectMigration(root);
    expect(plan.conflicts).toEqual([{ path: join(root, '.ai/squawk/runs'), reason: expect.stringContaining('has mode 755, broader than 700') }]);
    expect(plan.moves.map(move => move.from)).not.toContain(join(source, 'runs/1.handoff.md'));
    chmodSync(source, 0o700);
    chmodSync(join(root, '.ai/squawk'), 0o750);
    expect((await planProjectMigration(root)).conflicts.map(conflict => conflict.path)).toContain(join(root, '.ai/squawk'));
  });
});
