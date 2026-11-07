import { mkdtempSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, afterAll, beforeAll, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';

// `serverCommand` (packages/cezar/src/index.ts) otherwise only runs through the
// CLI as a child process, which no coverage report can see. These cases drive
// the real `main()` in-process — argv swap + `vi.resetModules()`, the pattern
// of `src/home/runtime-cli.test.ts` — so the branches the complexity split
// (hearsay-tools/cezarion#2852) extracted are executed and measured. They only
// exercise existing behavior: dry runs, refusal paths and recorded state.

// A scripted prompt seam: while set, `createClackUi` returns a console-backed
// UI whose `text` answers once like the operator; the engine's own UI calls in
// the dry run that follows never prompt. Unset, `./ui.ts` is the real module.
const scriptedPrompt = vi.hoisted(() => ({ value: undefined as undefined | (() => Promise<string>) }));

function consoleUi(): Record<string, unknown> {
  const log = (m: unknown) => { console.log(String(m)); };
  return {
    intro: log,
    outro: log,
    note: (m: unknown) => log(m),
    message: log,
    info: log,
    success: log,
    warn: log,
    error: log,
    text: async () => {
      const next = scriptedPrompt.value;
      if (!next) return '';
      return await next();
    },
    select: async (opts: { initialValue?: unknown }) => opts.initialValue,
    confirm: async () => true,
    multiselect: async () => [] as string[],
    spinner: () => ({ start: () => {}, stop: () => {}, message: () => {} }),
    isCancel: () => false,
  };
}

vi.mock('./ui.ts', async (importActual) => {
  const actual = await importActual<typeof import('./ui.ts')>();
  return {
    ...actual,
    createClackUi: () => (scriptedPrompt.value ? consoleUi() : actual.createClackUi()),
  };
});

let serverHome: string;
let repoDir: string;

beforeAll(() => {
  serverHome = mkdtempSync(join(tmpdir(), 'cez-server-cli-home-'));
  repoDir = mkdtempSync(join(tmpdir(), 'cez-server-cli-repo-'));
  // Isolated from the worker's shared sandbox home: the cases below chain
  // through recorded state (install → deploy read-back → prompt → uninstall),
  // so leftovers from another file in the same worker must not leak in. The
  // selector writes the environment; the test never touches it directly.
  useTestHome(Home.sandbox(serverHome));
});

afterAll(() => {
  useTestHome(undefined);
  rmSync(serverHome, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
});

/** Run `cez <args>` through the real main(): swap argv, reset modules, import
 *  the entry (which runs main()), and restore argv/env/spies/exit code. */
async function runCli(args: string[]): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((m) => { logs.push(String(m)); });
  const error = vi.spyOn(console, 'error').mockImplementation((m) => { errors.push(String(m)); });
  const warn = vi.spyOn(console, 'warn').mockImplementation((m) => { logs.push(String(m)); });
  const argv = process.argv;
  const previousExitCode: number | undefined = typeof process.exitCode === 'number' ? process.exitCode : undefined;
  const previousDryRun = process.env.CEZ_DRY_RUN;
  let result: { logs: string[]; errors: string[]; exitCode: number | undefined };
  try {
    process.argv = [process.execPath, 'cez', ...args];
    process.env.CEZ_DRY_RUN = '1';
    vi.resetModules();
    await import('../index.ts');
    // main() is fire-and-forget at the entry, so the import resolves before the
    // command does. Every dispatched command ends by setting process.exitCode
    // (the error paths set 1, a completed run 0/1), so that is the completion
    // signal. bound: hang guard for a run that never settles.
    const deadline = Date.now() + 20_000;
    while (process.exitCode === undefined && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    if (process.exitCode === undefined) throw new Error('the CLI run never settled (no exit code within 20s)');
    result = {
      logs,
      errors,
      exitCode: typeof process.exitCode === 'number' ? process.exitCode : undefined,
    };
  } finally {
    process.argv = argv;
    if (previousDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = previousDryRun;
    process.exitCode = previousExitCode;
    log.mockRestore();
    error.mockRestore();
    warn.mockRestore();
  }
  return result;
}

function serverState(instance = 'default'): Record<string, unknown> {
  const path = instance === 'default'
    ? join(serverHome, 'server.json')
    : join(serverHome, 'server-instances', `${instance}.json`);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

afterEach(() => {
  scriptedPrompt.value = undefined;
  vi.resetModules();
});

it('refuses a server command with no --platform', async () => {
  const { errors, exitCode } = await runCli(['server-install', '--yes']);
  expect(errors.join('\n')).toContain('--platform is required. Valid platforms: ');
  expect(exitCode).toBe(1);
});

it('refuses an unknown platform', async () => {
  const { errors, exitCode } = await runCli(['server-install', '--platform', 'nope', '--yes']);
  expect(errors.join('\n')).toContain('unknown platform: nope (valid: ');
  expect(exitCode).toBe(1);
});

it('refuses --domain multi-instance off ubuntu-vps', async () => {
  const { errors, exitCode } = await runCli([
    'server-install', '--platform', 'macosx-ngrok', '--domain', 'shop.example.com', '--yes',
  ]);
  expect(errors.join('\n')).toContain('--domain (multi-instance) is only supported on ubuntu-vps, not macosx-ngrok.');
  expect(exitCode).toBe(1);
});

it('dry-run installs ubuntu-vps and records the state', async () => {
  const { logs, exitCode } = await runCli([
    'server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', repoDir,
  ]);
  const out = logs.join('\n');
  expect(out).toContain('cez server-install (ubuntu-vps) complete.');
  expect(out).toContain('Redeploy a new version any time with: cez server-deploy --platform ubuntu-vps');
  expect(exitCode).toBe(0);
  const state = serverState();
  expect(state['platform']).toBe('ubuntu-vps');
  expect(state['installed']).toBe(true);
  expect(state['externalProxy']).toBeUndefined();
});

it('dry-run deploys reading the platform from the record', async () => {
  const { logs, exitCode } = await runCli(['server-deploy', '--yes', '--repo', repoDir]);
  expect(logs.join('\n')).toContain('cez server-deploy (ubuntu-vps) complete');
  expect(exitCode).toBe(0);
  expect(serverState()['installed']).toBe(true);
});

it('offers a second instance on an installed host and records it under its slug', async () => {
  const stdin = process.stdin as unknown as { isTTY?: boolean };
  const hadTty = stdin.isTTY;
  stdin.isTTY = true;
  scriptedPrompt.value = async () => 'shop2.example.com';
  try {
    const { logs, exitCode } = await runCli(['server-install', '--platform', 'ubuntu-vps', '--repo', repoDir]);
    const out = logs.join('\n');
    expect(out).toContain('New instance "shop2-example-com" (shop2.example.com)');
    expect(out).toContain('cez server-install (ubuntu-vps, shop2.example.com) complete.');
    expect(out).toContain('cez server-deploy --platform ubuntu-vps --domain shop2.example.com');
    expect(exitCode).toBe(0);
    const state = serverState('shop2-example-com');
    expect(state['domain']).toBe('shop2.example.com');
    expect(state['installed']).toBe(true);
  } finally {
    if (hadTty === undefined) delete stdin.isTTY;
    else stdin.isTTY = hadTty;
  }
});

it('a failed second-instance prompt falls back to the default instance', async () => {
  const stdin = process.stdin as unknown as { isTTY?: boolean };
  const hadTty = stdin.isTTY;
  stdin.isTTY = true;
  scriptedPrompt.value = async () => {
    throw new Error('prompt failed');
  };
  try {
    const { logs, exitCode } = await runCli(['server-install', '--platform', 'ubuntu-vps', '--repo', repoDir]);
    const out = logs.join('\n');
    expect(out).not.toContain('New instance');
    expect(out).toContain('cez server-install (ubuntu-vps) complete.');
    expect(exitCode).toBe(0);
  } finally {
    if (hadTty === undefined) delete stdin.isTTY;
    else stdin.isTTY = hadTty;
  }
});

it('an explicit --port wins over the auto-picked loopback port', async () => {
  const { logs, exitCode } = await runCli([
    'server-install', '--platform', 'ubuntu-vps', '--domain', 'shop3.example.com', '--port', '4599', '--yes', '--repo', repoDir,
  ]);
  const out = logs.join('\n');
  expect(out).not.toContain('New instance');
  expect(out).toContain('cez server-install (ubuntu-vps, shop3.example.com) complete.');
  expect(exitCode).toBe(0);
  expect(serverState('shop3-example-com')['primaryPort']).toBe(4599);
});

it('dry-run uninstalls and reverses the recorded state', async () => {
  const { logs, exitCode } = await runCli([
    'server-uninstall', '--platform', 'ubuntu-vps', '--yes', '--repo', repoDir,
  ]);
  expect(logs.join('\n')).toContain('cez server-uninstall (ubuntu-vps) complete');
  expect(exitCode).toBe(0);
  const state = serverState();
  expect(state['installed']).toBe(false);
  expect(state['steps']).toEqual({});
});

it('leaves no stray server state file behind the cases created', () => {
  expect(existsSync(join(serverHome, 'server.json'))).toBe(true);
});
