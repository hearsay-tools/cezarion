import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defaultCliDeps, main, type CliDeps } from '../cli-dispatch.ts';
import { createRunner } from '../core/runner-factory.ts';
import { Home } from '../home/home.ts';
import { REBRAND_SWITCH } from '../home/switch.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { CockpitOwnership } from '../server/cockpit-ownership.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
import { ProjectContexts } from '../server/project-context.ts';
import { createApp } from '../server/server.ts';
import { loadSubcommand, SUBCOMMAND_NAMES } from '../subcommands.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { projectMigrationErrorSchema } from '@open-mercato/cezar-contract/project-migration';
import { PROJECT_MIGRATION_SWITCH } from './switch.ts';

/**
 * The P5 gate of `migrate-project` (hearsay-tools/cezarion#3089): off in P4, independent of
 * `REBRAND_SWITCH`. Help, registration, dispatch and the cockpit's migration route answer only
 * behind it; with it off, nothing loads the command module and nothing is written.
 */

const loaded = vi.hoisted(() => ({ cli: false }));
vi.mock('./cli.ts', async (importOriginal) => {
  loaded.cli = true;
  return importOriginal();
});

const roots: string[] = [];
const owners: CockpitOwnership[] = [];
const disposers: Array<() => void> = [];
const savedHome = process.env.CEZ_HOME;

beforeEach(() => {
  const home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-migrate-gate-home-'));
  roots.push(home);
  useTestHome(Home.sandbox(home));
  clearProjectProbeCache();
});

afterEach(() => {
  for (const dispose of disposers.splice(0)) dispose();
  for (const owner of owners.splice(0)) owner.releaseAll();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
  vi.unstubAllEnvs();
});

function cli(args: string[], runSubcommand: CliDeps['runSubcommand'] = defaultCliDeps.runSubcommand) {
  const output: string[] = [];
  const deps = { ...defaultCliDeps, process: { argv: ['/bin/node', '/bin/cez', ...args], env: {}, cwd: () => tmpdir(), exitCode: undefined as number | undefined },
    console: { log: (line: string) => output.push(line), error: (line: string) => output.push(line) }, productEnv: () => undefined,
    resolveCliHome: () => testHome(), prepareOperatorHome: () => testHome(), runManagedCommand: vi.fn().mockResolvedValue(undefined), runSubcommand,
    getRepoInfo: vi.fn().mockResolvedValue(null), runProjectsCommand: vi.fn(), readOwnName: () => '@wjarka/cezarion', readOwnVersion: () => '1.2.3',
    serveCommand: vi.fn(), serverCommand: vi.fn(), runCommand: vi.fn(), initCommand: vi.fn(), initWorkspace: vi.fn() };
  return { deps, output };
}

describe('the P5 gate of migrate-project', () => {
  it('ships off, beside an off release switch', () => {
    expect(PROJECT_MIGRATION_SWITCH).toBe(false);
    expect(REBRAND_SWITCH).toBe(false);
    expect(SUBCOMMAND_NAMES).not.toContain('migrate-project');
  });

  it.each([false, true])('omits the command from help and dispatch with the release switch %s, and loads no command module', async (rebrand) => {
    expect(await loadSubcommand('migrate-project', () => testHome(), rebrand)).toBeUndefined();
    const help = cli(['--help']);
    await main(help.deps as unknown as CliDeps, rebrand);
    expect(help.output.join('\n')).not.toMatch(/migrate-project|\.ai\/squawk/);

    // The global parser meets the command's flag first: the same refusal as any unknown option.
    await expect(main(cli(['migrate-project', '--dry-run']).deps as unknown as CliDeps, rebrand)).rejects.toThrow(/^Unknown option '--dry-run'/);
    const direct = cli(['migrate-project']);
    await main(direct.deps as unknown as CliDeps, rebrand);
    expect(direct.deps.process.exitCode).toBe(1);
    const lines = direct.output.join('\n').split('\n');
    const unknown = lines.indexOf('unknown command: migrate-project');
    expect(unknown).toBeGreaterThanOrEqual(0);
    expect(lines.filter((_, index) => index !== unknown).join('\n')).not.toMatch(/migrate-project|\.ai\/squawk/);
    expect(loaded.cli).toBe(false);
  });

  it('registers, advertises and dispatches the command only through its own gate', async () => {
    const gated: CliDeps['runSubcommand'] = async (argv, env) => {
      const run = await loadSubcommand(argv[0], () => testHome(), false, true);
      return run ? run(argv.slice(1), env) : undefined;
    };
    const help = cli(['--help'], gated);
    await main(help.deps as unknown as CliDeps, false, true);
    expect(help.output.join('\n')).toContain('cez migrate-project [--dry-run]');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = cli(['migrate-project', '--help'], gated);
    await main(run.deps as unknown as CliDeps, false, true);
    expect(run.deps.process.exitCode).toBe(0);
    expect(log.mock.calls.join('\n')).toContain('Usage: cez migrate-project [--dry-run]');
    log.mockRestore();
    expect(loaded.cli).toBe(true);
  });
});

describe('the cockpit migration route', () => {
  async function cockpit(options: { projectMigration?: boolean } = {}) {
    const [boot, target] = ['boot', 'target'].map(() => {
      const root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-migrate-gate-'));
      roots.push(root);
      return root;
    });
    const [bootId, targetId] = await Promise.all([boot!, target!].map(async (root) => { return (await registerProject(root, undefined, testHome())).id!; }));
    const ownership = new CockpitOwnership();
    owners.push(ownership);
    const contexts = new ProjectContexts({ createRunner, home: testHome(), ownership,
      listProjects: async () => [{ id: bootId!, root: boot!, status: 'not-git' as const }, { id: targetId!, root: target!, status: 'not-git' as const }] });
    disposers.push(() => contexts.disposeAll());
    const ctx = await contexts.context(bootId!);
    const app = createApp({ home: testHome(), repoRoot: boot!, store: ctx.store, manager: ctx.manager, ownership, contexts, bootProjectId: bootId!,
      version: '0.0.0-test', ...options });
    const post = (id: string, dryRun = false) => apiRequest(app, `/api/v1/projects/${id}/migration`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ dryRun }) });
    return { boot: boot!, target: target!, bootId: bootId!, targetId: targetId!, post };
  }

  it('answers 404 before any work while the gate is off, and writes nothing', async () => {
    const { target, targetId, post } = await cockpit();
    const before = readdirSync(target);
    for (const dryRun of [false, true]) {
      const response = await post(targetId, dryRun);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Project migration is not available in this release' });
    }
    expect(readdirSync(target)).toEqual(before);
    expect(existsSync(join(target, '.ai'))).toBe(false);
  });

  it('behind the gate keeps the host-only rule, unknown ids and the boot project out', async () => {
    const { boot, targetId, bootId, post } = await cockpit({ projectMigration: true });
    expect((await post('no-such-project')).status).toBe(404);
    const refusal = await post(bootId);
    expect(refusal.status).toBe(409);
    expect(projectMigrationErrorSchema.parse(await refusal.json()).error).toBe(`This cockpit serves ${boot} as its boot project. Stop it, then run migrate-project again`);
    vi.stubEnv('CEZ_REMOTE', '1');
    expect((await post(targetId)).status).toBe(403);
    expect(existsSync(join(boot, '.ai/squawk'))).toBe(false);
  });
});
