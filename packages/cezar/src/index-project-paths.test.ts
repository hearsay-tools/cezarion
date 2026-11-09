import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUN_STATUS, makeRunRecord } from '@open-mercato/cezar-contract/test-factories.testkit';
import { testHome } from './home/test-home.testkit.ts';
import { main } from './cli-dispatch.ts';
import { serveCommand } from './serve-command.ts';
import { runHeadless } from './headless-run.ts';
import { RUNS_IMPORT_COMPLETE_KEY, RunDatabase } from './runs/run-database.ts';
import { encodeRunRow } from './runs/run-row.ts';
import { loadWorkflows } from './workflows/load.ts';
import { discoverSkills } from './skills.ts';

vi.mock('./cli-dispatch.ts', () => ({ defaultCliDeps: {}, main: vi.fn(async () => undefined) }));
vi.mock('./serve-command.ts', () => ({ defaultServeDeps: {}, serveCommand: vi.fn(async () => undefined) }));
vi.mock('./headless-run.ts', () => ({ defaultHeadlessDeps: {}, runHeadless: vi.fn(async () => undefined) }));
vi.mock('./runs/arm-repo-handle.ts', () => ({ armRepoHandle: vi.fn() }));
vi.mock('./task-cli/hint.ts', () => ({
  startCockpitHint: () => {
    return () => { return undefined; };
  },
}));
await import('./index.ts');
const cli = vi.mocked(main).mock.calls[0]![0];

describe('CLI project paths at real entry points', () => {
  let repo: string;
  beforeEach(() => { repo = mkdtempSync(join(tmpdir(), 'cli-project-paths-')); });
  afterEach(() => { vi.restoreAllMocks(); vi.mocked(serveCommand).mockReset(); vi.mocked(runHeadless).mockReset(); rmSync(repo, { recursive: true, force: true }); });
  function seedFallback() {
    const directory = join(repo, '.ai/squawk');
    mkdirSync(directory, { recursive: true });
    const record = makeRunRecord({ id: randomUUID(), task: 'fallback', title: 'fallback', workflow: 'quick-task',
      status: RUN_STATUS.done, createdAt: '2026-11-01T00:00:00Z', steps: [] });
    const db = RunDatabase.open(join(directory, 'runs.db'));
    db.transaction({ upserts: [encodeRunRow(record)], deletes: [], meta: { [RUNS_IMPORT_COMPLETE_KEY]: 'fixture' } });
    db.close();
    return record;
  }

  it('initializes examples under legacy and keeps authored files intact on repeated init', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mkdirSync(join(repo, '.ai/squawk/workflows'), { recursive: true });
    writeFileSync(join(repo, '.ai/squawk/workflows/custom.yaml'), 'fallback workflow');
    await cli.initCommand(repo);
    const example = join(repo, '.ai/cezar/workflows/fix-and-verify.yaml');
    expect(existsSync(example)).toBe(true);
    expect(existsSync(join(repo, '.ai/cezar/skills/project-conventions.md'))).toBe(true);
    writeFileSync(example, 'authored workflow');
    await cli.initCommand(repo);
    expect(readFileSync(example, 'utf8')).toBe('authored workflow');
    expect(readFileSync(join(repo, '.ai/squawk/workflows/custom.yaml'), 'utf8')).toBe('fallback workflow');
    expect(log).toHaveBeenCalled();
  });

  it('skips a starter whose name an authored .ai/squawk/ workflow or skill already uses', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    mkdirSync(join(repo, '.ai/squawk/workflows'), { recursive: true });
    mkdirSync(join(repo, '.ai/squawk/skills'), { recursive: true });
    writeFileSync(join(repo, '.ai/squawk/workflows/mine.yaml'), 'name: fix-and-verify\nskills: [implement]\n');
    writeFileSync(join(repo, '.ai/squawk/skills/conventions.md'), '---\nname: project-conventions\n---\n\n# Mine\n');
    await cli.initCommand(repo);
    expect(existsSync(join(repo, '.ai/cezar/workflows/fix-and-verify.yaml'))).toBe(false);
    expect(existsSync(join(repo, '.ai/cezar/skills/project-conventions.md'))).toBe(false);
    const { workflows } = await loadWorkflows(repo);
    expect(workflows.find(workflow => workflow.name === 'fix-and-verify')?.path).toBe(join(repo, '.ai/squawk/workflows/mine.yaml'));
    expect((await discoverSkills(repo, { builtin: [] }, testHome())).find(skill => skill.name === 'project-conventions')?.path)
      .toBe(join(repo, '.ai/squawk/skills/conventions.md'));
  });

  it('serves fallback history without creating an empty legacy runs database', async () => {
    const run = seedFallback();
    vi.mocked(serveCommand).mockImplementation(async (_home, root, _port, _open, _host, _restart, deps) => {
      const store = deps.openBootStore(root);
      try { expect(store.getRun(run.id)?.title).toBe('fallback'); }
      finally { store.close(); }
    });
    await cli.serveCommand(testHome(), repo, 4321, false, undefined, false);
    expect(existsSync(join(repo, '.ai/cezar/runs.db'))).toBe(false);
  });

  it('opens fallback history through the headless entry without shadowing it', async () => {
    const run = seedFallback();
    vi.mocked(runHeadless).mockImplementation(async (_home, root, _task, _workflow, _model, _access, deps) => {
      const store = deps.openStore(root, { repoHandleSignal: new AbortController().signal });
      try { expect(store.getRun(run.id)?.title).toBe('fallback'); }
      finally { store.close(); }
    });
    await cli.runCommand(testHome(), repo, 'task', undefined, undefined, { allowWorkers: true, allowMessaging: true });
    expect(existsSync(join(repo, '.ai/cezar/runs.db'))).toBe(false);
  });
});
