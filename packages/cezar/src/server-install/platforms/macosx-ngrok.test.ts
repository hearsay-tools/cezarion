import { Home } from '../../home/home.ts';
import { useTestHome } from '../../home/test-home.testkit.ts';
import { testHome } from '../../home/test-home.testkit.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { squawkLaunchdPlist, launchdPlist, macosxNgrok } from './macosx-ngrok.ts';
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
    useTestHome(home ? Home.sandbox(home) : undefined);
  });
  afterEach(() => {
    if (original === undefined) useTestHome(undefined);
    else useTestHome(original ? Home.sandbox(original) : undefined);
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

  it('squawkLaunchdPlist embeds the argv, port, workdir and env', () => {
    const p = squawkLaunchdPlist('/repo', 4321, ['/usr/local/bin/node', '/app/dist/index.js']);
    expect(p).toContain('<string>/usr/local/bin/node</string>');
    expect(p).toContain('<string>/app/dist/index.js</string>');
    expect(p).toContain('<string>serve</string>');
    expect(p).toContain('<string>--no-open</string>');
    expect(p).toContain('<string>4321</string>');
    expect(p).toContain('<string>/repo</string>');
    expect(p).toContain('<key>CEZ_REMOTE</key>');
    expect(p).toContain('<string>tools.hearsay.squawk.cockpit</string>');
  });

  it('dry-run install walks every step and server-uninstall reverses it', async () => {
    // Leave the reserved domain blank to exercise the ephemeral-URL path.
    const ui = { ...createAutoUi(), text: async (o: { message: string; placeholder?: string }) => (o.message.includes('Reserved') ? '' : o.placeholder ?? 'ops') };
    const run = { home: testHome(),
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
    const state = loadServerState(undefined, testHome());
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
    expect(loadServerState(undefined, testHome()).steps).toEqual({});
  });
});

describe('macosx-ngrok review fixes (PR #423)', () => {
  let home: string;
  const original = process.env.CEZ_HOME;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-fix-'));
    useTestHome(home ? Home.sandbox(home) : undefined);
  });
  afterEach(() => {
    if (original === undefined) useTestHome(undefined);
    else useTestHome(original ? Home.sandbox(original) : undefined);
    rmSync(home, { recursive: true, force: true });
  });

  function ngrokStepOf() {
    const s = macosxNgrok.steps({} as never).find((x) => x.id === 'ngrok');
    if (!s) throw new Error('no ngrok step');
    return s;
  }

  function ctxFor(runner: Runner, over: Record<string, unknown> = {}) {
    return {
      launchAgentsDir: () => join(home, 'Library', 'LaunchAgents'),
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
    await ngrokStepOf().run(ctxFor(runner));
    const p = join(home, 'Library', 'LaunchAgents', 'tools.hearsay.squawk.ngrok.plist');
    const mode = statSync(p).mode & 0o777;
    expect(mode).toBe(0o600);
    expect(readFileSync(p, 'utf8')).toContain('ops:longenough'); // creds live here → hence 0600
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
    await expect(ngrokStepOf().run(ctxFor(runner))).rejects.toThrow(/launchctl could not load/);
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
    await ngrokStepOf().undo(ctxFor(runner), null);
    expect(commands.some((c) => c[0] === 'bootout' && (c[1] ?? '').includes('tools.hearsay.squawk.ngrok'))).toBe(true);
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
    await ngrokStepOf().run(ctx);
    expect(domainValidate).toBeDefined();
    expect(domainValidate?.('https://cezar.ngrok.app')).toBeDefined();
    expect(domainValidate?.('cezar.ngrok.app')).toBeUndefined();
    expect(domainValidate?.('')).toBeUndefined(); // blank = ephemeral, allowed
  });
});

describe('macosx-ngrok redeploy npx-cache refresh (#32)', () => {
  let home: string;
  let cache: string;
  const originalCache = process.env.npm_config_cache;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-mac-npx-home-'));
    cache = mkdtempSync(join(tmpdir(), 'cez-mac-npx-cache-'));
    process.env.npm_config_cache = cache;
    mkdirSync(join(home, 'Library', 'LaunchAgents'), { recursive: true });
  });

  afterEach(() => {
    if (originalCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = originalCache;
    rmSync(home, { recursive: true, force: true });
    rmSync(cache, { recursive: true, force: true });
  });

  function writeCockpitPlist(argv: string[]): void {
    writeFileSync(
      join(home, 'Library', 'LaunchAgents', 'tools.hearsay.squawk.cockpit.plist'),
      squawkLaunchdPlist('/repo', 4321, argv),
    );
  }

  function plantSquawkCache(): string {
    const entry = join(cache, '_npx', 'aaaa', 'node_modules', 'cezarion');
    mkdirSync(entry, { recursive: true });
    writeFileSync(join(entry, 'x'), '');
    writeFileSync(join(cache, '_npx', 'aaaa', 'package.json'), JSON.stringify({ dependencies: { cezarion: '^0.17.0' } }));
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
    return { home: testHome(),
      launchAgentsDir: () => join(home, 'Library', 'LaunchAgents'),
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

  it('repairs an old plist once and recognizes it on the next install check', async () => {
    writeCockpitPlist(['/usr/bin/node', '/usr/local/bin/cezarion']);
    const path = join(home, 'Library', 'LaunchAgents', 'tools.hearsay.squawk.cockpit.plist');
    const current = readFileSync(path, 'utf8').replace(/      <key>HSQ_REMOTE<\/key>\n      <string>1<\/string>\n/, '');
    writeFileSync(path, current);
    const { interactive, calls } = recordingInteractive();
    const ctx = ctxFor(interactive);
    const step = macosxNgrok.steps(ctx).find(step => step.id === 'autostart')!;
    expect(await step.check(ctx)).toBe(false);
    await macosxNgrok.redeploy!(ctx);
    const repaired = readFileSync(path, 'utf8');
    expect(repaired).toContain('<key>HSQ_REMOTE</key>');
    expect(repaired.replace(/      <key>HSQ_REMOTE<\/key>\n      <string>1<\/string>\n/, '')).toBe(current);
    expect(await step.check(ctx)).toBe(true);
    expect(calls.filter(call => call.args[0] === 'bootstrap')).toHaveLength(1);
    await macosxNgrok.redeploy!(ctx);
    expect(readFileSync(path, 'utf8')).toBe(repaired);
    expect(calls.filter(call => call.args[0] === 'bootstrap')).toHaveLength(1);
  });

  it('loads the repaired plist on retry after bootstrap failed', async () => {
    writeCockpitPlist(['/usr/bin/node', '/usr/local/bin/cezarion']);
    const path = join(home, 'Library', 'LaunchAgents', 'tools.hearsay.squawk.cockpit.plist');
    writeFileSync(path, readFileSync(path, 'utf8').replace(/      <key>HSQ_REMOTE<\/key>\n      <string>1<\/string>\n/, ''));
    let loaded = true;
    let bootstraps = 0;
    const ctx = ctxFor(async (program, args) => {
      if (program === 'launchctl' && args[0] === 'bootstrap') {
        bootstraps++;
        loaded = bootstraps > 1;
        return loaded ? 0 : 1;
      }
      if (program === 'launchctl' && args[0] === 'kickstart' && args[2]?.endsWith('/tools.hearsay.squawk.cockpit')) {
        expect(loaded).toBe(true);
      }
      return 0;
    });
    const capture = ctx.runner.capture;
    ctx.runner.capture = async (program, args) => {
      if (program === 'launchctl' && args[0] === 'bootout') loaded = false;
      if (program === 'launchctl' && args[0] === 'print') return {code: loaded ? 0 : 1, stdout: '', stderr: ''};
      return capture(program, args);
    };
    await expect(macosxNgrok.redeploy!(ctx)).rejects.toThrow('could not load');
    const repaired = readFileSync(path, 'utf8');
    expect(repaired).toContain('<key>HSQ_REMOTE</key>');
    await macosxNgrok.redeploy!(ctx);
    expect(readFileSync(path, 'utf8')).toBe(repaired);
    expect(bootstraps).toBe(2);
    expect(loaded).toBe(true);
  });

  it('clears the cached cezarion build before kickstart when the agent is an npx launch', async () => {
    writeCockpitPlist(['/n/npx', '--yes', 'cezarion']);
    const cached = plantSquawkCache();
    const { interactive, calls } = recordingInteractive();

    await macosxNgrok.redeploy!(ctxFor(interactive));

    expect(existsSync(cached)).toBe(false);
    expect(kickstarted(calls)).toBe(true);
  });

  it('does not clear the npx cache for a checkout-launched agent', async () => {
    writeCockpitPlist(['/usr/bin/node', '/home/cezar/cezar/dist/index.js']);
    const cached = plantSquawkCache();
    const { interactive, calls } = recordingInteractive();

    await macosxNgrok.redeploy!(ctxFor(interactive));

    expect(existsSync(cached)).toBe(true);
    expect(kickstarted(calls)).toBe(true);
  });

  it('does not clear the npx cache for a global-bin agent', async () => {
    writeCockpitPlist(['/usr/bin/node', '/usr/local/bin/cezarion']);
    const cached = plantSquawkCache();
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
