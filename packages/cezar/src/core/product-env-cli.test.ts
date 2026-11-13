import { afterEach, expect, it, vi } from 'vitest';

const dispatch = vi.hoisted(() => ({
  projects: vi.fn(async (..._args: unknown[]) => 0),
}));
vi.mock('../subcommands.ts', () => ({runSubcommand: async () => undefined}));
vi.mock('../server/git.ts', async original => ({...await original<typeof import('../server/git.ts')>(), getRepoInfo: async () => null}));
vi.mock('../workspace/migrations.ts', () => ({runMigrations: async () => {}}));
vi.mock('../workspace/projects-cli.ts', () => ({runProjectsCommand: dispatch.projects}));

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.resetModules(); dispatch.projects.mockClear(); });

async function runCli(args: string[]) {
  const argv = process.argv;
  const exitCode = process.exitCode;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  process.argv = [process.execPath, 'cez', ...args];
  process.exitCode = undefined;
  try {
    await import('../index.ts');
    // bound: CLI dispatch settles by assigning its exit code; ten seconds only guards a hang.
    await vi.waitFor(() => expect(process.exitCode).toBeDefined(), {timeout: 10_000});
    return {exitCode: process.exitCode, errors: errors.mock.calls.map(([message]) => String(message))};
  } finally { process.argv = argv; process.exitCode = exitCode; }
}

it('retains the unknown-command exit while reading product settings at the CLI boundary', async () => {
  const result = await runCli(['not-a-command']);
  expect(result.exitCode).toBe(1);
  expect(result.errors).toContainEqual(expect.stringContaining('unknown command: not-a-command'));
  expect(dispatch.projects).not.toHaveBeenCalled();
});
