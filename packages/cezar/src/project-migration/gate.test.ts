import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { defaultCliDeps, main, type CliDeps } from '../cli-dispatch.ts';
import { REBRAND_SWITCH } from '../home/switch.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { loadSubcommand, SUBCOMMAND_NAMES } from '../subcommands.ts';

/**
 * `migrate-project` follows the release switch (hearsay-tools/cezarion#3089): with
 * `REBRAND_SWITCH` false, as shipped, help and dispatch omit it and nothing loads the command
 * module; through the switch's test seam it is registered, advertised and runs.
 */

const loaded = vi.hoisted(() => ({ cli: false }));
vi.mock('./cli.ts', async (importOriginal) => {
  loaded.cli = true;
  return importOriginal();
});

function cli(args: string[], runSubcommand: CliDeps['runSubcommand'] = defaultCliDeps.runSubcommand) {
  const output: string[] = [];
  const deps = { ...defaultCliDeps, process: { argv: ['/bin/node', '/bin/cez', ...args], env: {}, cwd: () => tmpdir(), exitCode: undefined as number | undefined },
    console: { log: (line: string) => output.push(line), error: (line: string) => output.push(line) }, productEnv: () => undefined,
    resolveCliHome: () => testHome(), prepareOperatorHome: () => testHome(), runSubcommand,
    getRepoInfo: vi.fn().mockResolvedValue(null), runProjectsCommand: vi.fn(), readOwnVersion: () => '1.2.3',
    serveCommand: vi.fn(), serverCommand: vi.fn(), runCommand: vi.fn(), initCommand: vi.fn(), initWorkspace: vi.fn() };
  return { deps, output };
}

describe('migrate-project and the release switch', () => {
  it('stays hidden and unusable with the switch off, as shipped, and loads no command module', async () => {
    expect(REBRAND_SWITCH).toBe(false);
    expect(SUBCOMMAND_NAMES).not.toContain('migrate-project');
    expect(await loadSubcommand('migrate-project', () => testHome(), false)).toBeUndefined();
    const help = cli(['--help']);
    await main(help.deps as unknown as CliDeps, false);
    expect(help.output.join('\n')).not.toMatch(/migrate-project|\.ai\/squawk/);
    // The global parser meets the command's flag first: the same refusal as any unknown option.
    await expect(main(cli(['migrate-project', '--dry-run']).deps as unknown as CliDeps, false)).rejects.toThrow(/^Unknown option '--dry-run'/);
    const direct = cli(['migrate-project']);
    await main(direct.deps as unknown as CliDeps, false);
    expect(direct.deps.process.exitCode).toBe(1);
    const lines = direct.output.join('\n').split('\n');
    const unknown = lines.indexOf('unknown command: migrate-project');
    expect(unknown).toBeGreaterThanOrEqual(0);
    expect(lines.filter((_, index) => index !== unknown).join('\n')).not.toMatch(/migrate-project|\.ai\/squawk/);
    expect(loaded.cli).toBe(false);
  });

  it('is registered, advertised and dispatched with the switch on', async () => {
    const switched: CliDeps['runSubcommand'] = async (argv, env) => {
      const run = await loadSubcommand(argv[0], () => testHome(), true);
      return run ? run(argv.slice(1), env) : undefined;
    };
    const help = cli(['--help'], switched);
    await main(help.deps as unknown as CliDeps, true);
    expect(help.output.join('\n')).toContain('migrate-project [--dry-run] move this project\'s state from .ai/cezar/ to .ai/squawk/, offline');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const run = cli(['migrate-project', '--help'], switched);
    await main(run.deps as unknown as CliDeps, true);
    expect(run.deps.process.exitCode).toBe(0);
    expect(log.mock.calls.join('\n')).toContain('migrate-project [--dry-run] [--repo <dir>]');
    log.mockRestore();
    expect(loaded.cli).toBe(true);
  });
});

// These cases pin the shipped disabled gate; enabled cases use the explicit rebrand seam.
vi.mock('../home/switch.ts', () => ({ REBRAND_SWITCH: false }));
