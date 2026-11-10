import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { afterEach, afterAll, beforeEach, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';

// These cases run the real `cez server-install` / `server-deploy` /
// `server-uninstall` dispatch in-process — argv swap + `vi.resetModules()`, the
// pattern of `src/home/runtime-cli.test.ts` — covering the refusals
// (missing/unknown platform, `--domain` off ubuntu-vps), the dry-run state
// records for install/deploy/uninstall, the named-instance port pick, and the
// second-instance prompt's answer and failure fallbacks. Every case builds its
// own sandbox and needs no other case.

// No case may run a real host command: the process-spawning seam
// (`node:child_process`) is mocked at the module boundary. The login-shell
// PATH probe answers with the current (setup-hidden) PATH; every probe and
// runner spawn resolves as command-not-found, so tool detection, git repo
// discovery and any accidental binary call stay inside the sandbox.
vi.mock('node:child_process', async (importActual) => {
  const actual = await importActual<typeof import('node:child_process')>();
  const notFound = (program: string): Error =>
    Object.assign(new Error(`spawn ${program} ENOENT`), { code: 127, errno: -2, path: program });
  const fakeChild = (): EventEmitter => {
    const child = new EventEmitter() as EventEmitter & {
      stdout: EventEmitter; stderr: EventEmitter; stdin: EventEmitter & { end: () => void };
      pid: number; kill: () => boolean;
    };
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter() as EventEmitter & { end: () => void };
    child.stdin.end = () => {};
    child.pid = 1;
    child.kill = () => true;
    queueMicrotask(() => {
      child.emit('close', 127);
    });
    return child;
  };
  const fakeSpawn = (): EventEmitter => {
    return fakeChild();
  };
  const fakeExecFile = (file: string, _args: string[], optsOrCb?: unknown, maybeCb?: unknown): EventEmitter => {
    const done = typeof optsOrCb === 'function' ? optsOrCb : maybeCb;
    queueMicrotask(() => {
      (done as (err: Error, stdout: string, stderr: string) => void)(notFound(file), '', '');
    });
    return fakeChild();
  };
  const fakeExecFileSync = (file: string, args: string[]): string => {
    if (file === 'bash' && args[0] === '-lc') return process.env.PATH ?? '';
    throw notFound(file);
  };
  return {
    ...actual,
    spawn: fakeSpawn as unknown as typeof actual.spawn,
    execFile: fakeExecFile as unknown as typeof actual.execFile,
    execFileSync: fakeExecFileSync as unknown as typeof actual.execFileSync,
  };
});

// A scripted prompt seam: while set, `createClackUi` returns a console-backed
// UI whose `text` answers once like the operator; the engine's own dry-run UI
// calls never prompt. Unset, `./ui.ts` is the real module.
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

beforeEach(() => {
  serverHome = mkdtempSync(join(tmpdir(), 'cez-server-cli-home-'));
  repoDir = mkdtempSync(join(tmpdir(), 'cez-server-cli-repo-'));
  // Each case gets a fresh sandbox home so recorded state cannot leak between
  // cases (they run under --sequence.shuffle too). The selector writes the
  // environment; the test never touches it directly.
  useTestHome(Home.sandbox(serverHome));
});

afterEach(() => {
  useTestHome(undefined);
  rmSync(serverHome, { recursive: true, force: true });
  rmSync(repoDir, { recursive: true, force: true });
  scriptedPrompt.value = undefined;
  vi.resetModules();
});

afterAll(() => {
  useTestHome(undefined);
});

/** Run `cez <args>` through the real main(): swap argv, reset modules, import
 *  the entry (which runs main()), and restore argv/env/PATH/spies/exit code. */
async function runCli(args: string[]): Promise<{ logs: string[]; errors: string[]; exitCode: number | undefined }> {
  const logs: string[] = [];
  const errors: string[] = [];
  const log = vi.spyOn(console, 'log').mockImplementation((m) => { logs.push(String(m)); });
  const error = vi.spyOn(console, 'error').mockImplementation((m) => { errors.push(String(m)); });
  const warn = vi.spyOn(console, 'warn').mockImplementation((m) => { logs.push(String(m)); });
  const argv = process.argv;
  const previousPath = process.env.PATH;
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
    process.env.PATH = previousPath;
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
  const path = Home.sandbox(serverHome).serverState(instance);
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

/** A completed dry-run install of the default instance, for the cases whose
 *  behavior builds on a recorded install. */
async function dryRunInstallDefault(): Promise<void> {
  const { exitCode } = await runCli(['server-install', '--platform', 'ubuntu-vps', '--yes', '--repo', repoDir]);
  expect(exitCode).toBe(0);
}

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
  await dryRunInstallDefault();
  const { logs, exitCode } = await runCli(['server-deploy', '--yes', '--repo', repoDir]);
  expect(logs.join('\n')).toContain('cez server-deploy (ubuntu-vps) complete');
  expect(exitCode).toBe(0);
  expect(serverState()['installed']).toBe(true);
});

it('offers a second instance on an installed host and records it under its slug', async () => {
  await dryRunInstallDefault();
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
  await dryRunInstallDefault();
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

it('dry-run uninstalls and reverses the recorded state, leaving the record file', async () => {
  await dryRunInstallDefault();
  const { logs, exitCode } = await runCli([
    'server-uninstall', '--platform', 'ubuntu-vps', '--yes', '--repo', repoDir,
  ]);
  expect(logs.join('\n')).toContain('cez server-uninstall (ubuntu-vps) complete');
  expect(exitCode).toBe(0);
  const state = serverState();
  expect(state['installed']).toBe(false);
  expect(state['steps']).toEqual({});
});
