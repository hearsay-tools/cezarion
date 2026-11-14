import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { defaultCliDeps, main, type CliDeps } from '../cli-dispatch.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { loadSubcommand, SUBCOMMAND_NAMES } from '../subcommands.ts';

/** `migrate-project` (hearsay-tools/cezarion#3089) is registered, advertised and runs. */

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

describe('migrate-project', () => {
  it('is registered, advertised and dispatched', async () => {
    expect(SUBCOMMAND_NAMES).toContain('migrate-project');
    const run = (async (argv, env) => {
      const runner = await loadSubcommand(argv[0], () => testHome());
      return runner ? runner(argv.slice(1), env) : undefined;
    }) satisfies CliDeps['runSubcommand'];
    const help = cli(['--help'], run);
    await main(help.deps as unknown as CliDeps);
    expect(help.output.join('\n')).toContain('migrate-project [--dry-run] move this project\'s state from .ai/cezar/ to .ai/squawk/, offline');
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const command = cli(['migrate-project', '--help'], run);
    await main(command.deps as unknown as CliDeps);
    expect(command.deps.process.exitCode).toBe(0);
    expect(log.mock.calls.join('\n')).toContain('migrate-project [--dry-run] [--repo <dir>]');
    log.mockRestore();
    expect(loaded.cli).toBe(true);
  });
});
