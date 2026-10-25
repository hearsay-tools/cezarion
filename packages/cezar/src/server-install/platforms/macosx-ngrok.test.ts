import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cezarLaunchdPlist, launchdPlist, macosxNgrok } from './macosx-ngrok.ts';
import { availablePlatformIds, getStrategy } from '../strategies.ts';
import { runInstall, runUninstall } from '../engine.ts';
import { loadServerState } from '../state.ts';
import { createAutoUi } from '../ui.ts';
import type { InstallContext, Runner, Ui } from '../types.ts';

const okRunner: Runner = { capture: async () => ({ code: 0, stdout: '', stderr: '' }), interactive: async () => 0 };

describe('macosx-ngrok', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  it('is registered alongside ubuntu-vps', () => {
    expect(getStrategy('macosx-ngrok')?.id).toBe('macosx-ngrok');
    expect(availablePlatformIds()).toEqual(['ubuntu-vps', 'macosx-ngrok']);
  });

  it('launchdPlist embeds the port, basic-auth and reserved domain', () => {
    const p = launchdPlist(4321, 'ops:hunter2', 'cezar.ngrok.app');
    expect(p).toContain('<string>http</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>ops:hunter2</string>');
    expect(p).toContain('<string>cezar.ngrok.app</string>');
    expect(p).toContain('<key>KeepAlive</key>');
  });

  it('cezarLaunchdPlist embeds the argv, port, workdir and env', () => {
    const p = cezarLaunchdPlist('/repo', 4321, ['/usr/local/bin/node', '/app/dist/index.js']);
    expect(p).toContain('<string>/usr/local/bin/node</string>');
    expect(p).toContain('<string>/app/dist/index.js</string>');
    expect(p).toContain('<string>serve</string>');
    expect(p).toContain('<string>--no-open</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>/repo</string>');
    expect(p).toContain('<key>CEZ_REMOTE</key>');
    expect(p).toContain('<string>ai.cezar.cockpit</string>');
  });

  it('dry-run install walks every step and server-uninstall reverses it', async () => {
    // Leave the reserved domain blank to exercise the ephemeral-URL path.
    const ui = { ...createAutoUi(), text: async (o: { message: string; placeholder?: string }) => (o.message.includes('Reserved') ? '' : o.placeholder ?? 'ops') };
    const run = {
      dryRun: true,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      ui,
      runner: okRunner,
    };
    const res = await runInstall(macosxNgrok, run);
    expect(res.status).toBe('complete');
    const state = loadServerState();
    expect(state.platform).toBe('macosx-ngrok');
    expect(state.steps.autostart?.status).toBe('done');
    expect(state.steps.ngrok?.status).toBe('done');
    expect(state.ephemeral).toBe(true); // no domain given → ephemeral URL
    const ngrokArtifacts = state.steps.ngrok?.created?.artifacts ?? [];
    expect(ngrokArtifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');
    expect(ngrokArtifacts.find((a) => a.type === 'ngrok-config')?.kind).toBe('shared');
    const autostartArtifacts = state.steps.autostart?.created?.artifacts ?? [];
    expect(autostartArtifacts.find((a) => a.type === 'launchd')?.kind).toBe('owned');

    const undone = await runUninstall(macosxNgrok, run);
    expect(undone.status).toBe('complete');
    expect(loadServerState().steps).toEqual({});
  });
});

describe('macosx-ngrok review fixes (PR #423)', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-fix-'));
    process.env.CEZ_HOME = home;
  });
  afterEach(() => {
    if (original === undefined) delete process.env.CEZ_HOME;
    else process.env.CEZ_HOME = original;
    rmSync(home, { recursive: true, force: true });
  });

  function ngrokStepOf() {
    const s = macosxNgrok.steps({} as never).find((x) => x.id === 'ngrok');
    if (!s) throw new Error('no ngrok step');
    return s;
  }

  function ctxFor(runner: Runner, over: Record<string, unknown> = {}) {
    return {
      state: { schema: 1, installed: false, primaryPort: 4321, steps: {} },
      ui: {
        ...createAutoUi(),
        password: async (o: { message: string }) => (o.message.includes('authtoken') ? 'SECRET-TOKEN' : 'longenough'),
        text: async (o: { message: string }) => (o.message.includes('domain') ? '' : 'ops'),
      },
      runner,
      save: async () => {},
      dryRun: false,
      assumeYes: true,
      reconfigure: new Set<string>(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      prefs: {},
      ...over,
    } as never;
  }

  it('never puts the authtoken in argv — it travels via NGROK_AUTHTOKEN env', async () => {
    const interactiveCalls: Array<{ args: string[]; env?: Record<string, string> | undefined }> = [];
    const runner: Runner = {
      capture: async (_p, args) => {
        // launchctl print reports loaded; command -v finds ngrok
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/opt/homebrew/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (_p, args, o) => {
        interactiveCalls.push({ args, env: (o as { env?: Record<string, string> } | undefined)?.env });
        return 0;
      },
    };
    await ngrokStepOf().run(ctxFor(runner));
    const tokenCall = interactiveCalls.find((c) => c.args.join(' ').includes('add-authtoken'));
    expect(tokenCall).toBeDefined();
    expect(tokenCall?.args.join(' ')).not.toContain('SECRET-TOKEN');
    expect(tokenCall?.args.join(' ')).toContain('$NGROK_AUTHTOKEN');
    expect(tokenCall?.env?.NGROK_AUTHTOKEN).toBe('SECRET-TOKEN');
  });

  it('writes the credential-bearing plist 0600', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    // point HOME-based plist path into the temp dir via a fake homedir? plistPath()
    // uses the real homedir — instead assert through the file the step wrote.
    const oldHome = process.env.HOME;
    process.env.HOME = home; // node's os.homedir() honors $HOME on posix
    try {
      await ngrokStepOf().run(ctxFor(runner));
      const p = join(home, 'Library', 'LaunchAgents', 'ai.cezar.ngrok.plist');
      const mode = statSync(p).mode & 0o777;
      expect(mode).toBe(0o600);
      expect(readFileSync(p, 'utf8')).toContain('ops:longenough'); // creds live here → hence 0600
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('a failed launchctl bootstrap fails the step instead of recording done', async () => {
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        if (args[0] === 'print') return { code: 113, stdout: '', stderr: '' }; // not loaded
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async (_p, args) => (args[0] === 'bootstrap' ? 5 : 0),
    };
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await expect(ngrokStepOf().run(ctxFor(runner))).rejects.toThrow(/launchctl could not load/);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('undo removes the agent from static label/path even with created:null', async () => {
    const commands: string[][] = [];
    const runner: Runner = {
      capture: async (_p, args) => {
        commands.push(args);
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await ngrokStepOf().undo(ctxFor(runner), null);
      expect(commands.some((c) => c[0] === 'bootout' && (c[1] ?? '').includes('ai.cezar.ngrok'))).toBe(true);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
  });

  it('rejects a scheme-carrying domain (bare hostname only)', async () => {
    let domainValidate: ((v: string) => string | undefined) | undefined;
    const runner: Runner = {
      capture: async (_p, args) => {
        if (args[0] === 'print' || args.join(' ').includes('command -v')) return { code: 0, stdout: '/usr/local/bin/ngrok', stderr: '' };
        return { code: 0, stdout: '', stderr: '' };
      },
      interactive: async () => 0,
    };
    const ctx = ctxFor(runner, {
      ui: {
        ...createAutoUi(),
        password: async () => 'longenough',
        text: async (o: { message: string; validate?: (v: string) => string | undefined }) => {
          if (o.message.includes('domain')) {
            domainValidate = o.validate;
            return '';
          }
          return 'ops';
        },
      },
    });
    const oldHome = process.env.HOME;
    process.env.HOME = home;
    try {
      await ngrokStepOf().run(ctx);
    } finally {
      if (oldHome === undefined) delete process.env.HOME;
      else process.env.HOME = oldHome;
    }
    expect(domainValidate).toBeDefined();
    expect(domainValidate?.('https://cezar.ngrok.app')).toBeDefined();
    expect(domainValidate?.('cezar.ngrok.app')).toBeUndefined();
    expect(domainValidate?.('')).toBeUndefined(); // blank = ephemeral, allowed
  });
});

describe('macosx-ngrok redeploy npx-cache refresh (#32)', () => {
  let home: string;
  let cache: string;
  const originalHome = process.env.HOME;
  const originalCache = process.env.npm_config_cache;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-npx-home-'));
    cache = mkdtempSync(join(tmpdir(), 'cez-mac-npx-cache-'));
    process.env.HOME = home;
    process.env.npm_config_cache = cache;
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  });

  afterEach(() => {
    if (originalHome === undefined) delete process.env.HOME;
    else process.env.HOME = originalHome;
    if (originalCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = originalCache;
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  function writeCockpitPlist(argv: string[]): void {
    writeFileSync(
      join(home, 'Library', 'LaunchAgents', 'ai.cezar.cockpit.plist'),
      cezarLaunchdPlist('/repo', 4321, argv),
    );
  }

  function plantCezarionCache(): string {
    const entry = join(cache, '_npx', 'aaaa', 'node_modules', 'cezarion');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'x'), '');
    return join(cache, '_npx', 'aaaa');
  }

  function recordingInteractive(): { interactive: Runner['interactive']; calls: Array<{ program: string; args: string[] }> } {
    const calls: Array<{ program: string; args: string[] }> = [];
    const interactive: Runner['interactive'] = async (program, args) => {
      calls.push({ program, args });
      return 0;
    };
    return { interactive, calls };
  }

  function ctxFor(interactive: Runner['interactive']): InstallContext {
    const runner: Runner = {
      capture: async (program) =>
        program === 'curl' ? { code: 0, stdout: 'public_url', stderr: '' } : { code: 0, stdout: '', stderr: '' },
      interactive,
    };
    return {
      state: { schema: 1, installed: true, primaryPort: 4321, steps: {} },
      ui: createAutoUi() as Ui,
      instance: 'default',
      runner,
      save: async () => {},
      dryRun: false,
      assumeYes: true,
      reconfigure: new Set(),
      repoRoot: '/repo',
      now: '2026-07-16T00:00:00.000Z',
      prefs: {},
    };
  }

  function kickstarted(calls: Array<{ program: string; args: string[] }>): boolean {
    return calls.some((call) => call.program === 'launchctl' && call.args[0] === 'kickstart');
  }

  it('clears the cached cezarion build before kickstart when the agent is an npx launch', async () => {
    writeCockpitPlist(['/n/npx', '--yes', 'cezarion']);
    const cached = plantCezarionCache();
    const { interactive, calls } = recordingInteractive();

    await macosxNgrok.redeploy!(ctxFor(interactive));

    expect(existsSync(cached)).toBe(false);
    expect(kickstarted(calls)).toBe(true);
  });

  it('does not clear the npx cache for a checkout-launched agent', async () => {
    writeCockpitPlist(['/usr/bin/node', '/home/cezar/cezar/dist/index.js']);
    const cached = plantCezarionCache();
    const { interactive, calls } = recordingInteractive();

    await macosxNgrok.redeploy!(ctxFor(interactive));

    expect(existsSync(cached)).toBe(true);
    expect(kickstarted(calls)).toBe(true);
  });

  it('does not clear the npx cache for a global-bin agent', async () => {
    writeCockpitPlist(['/usr/bin/node', '/usr/local/bin/cezarion']);
    const cached = plantCezarionCache();
    const { interactive, calls } = recordingInteractive();

    await macosxNgrok.redeploy!(ctxFor(interactive));

    expect(existsSync(cached)).toBe(true);
    expect(kickstarted(calls)).toBe(true);
  });

  it('aborts before kickstart when the npx cache cannot be read', async () => {
    writeCockpitPlist(['/n/npx', '--yes', 'cezarion']);
    writeFileSync(join(cache, '_npx'), 'not a directory');
    const { interactive, calls } = recordingInteractive();

    await expect(macosxNgrok.redeploy!(ctxFor(interactive))).rejects.toThrow(
      /cannot inspect the npx cache.*service was not restarted/,
    );
    expect(calls).toEqual([]);
  });
});
