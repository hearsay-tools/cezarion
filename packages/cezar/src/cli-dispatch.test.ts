import { productName } from './home/display.ts';
import { REBRAND_SWITCH } from './home/switch.ts';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { defaultCliDeps, main, type CliDeps } from './cli-dispatch.ts';
import { testHome } from './home/test-home.testkit.ts';
import type { Home } from './home/home.ts';

function fixture(args: string[] = []) {
  const home = testHome();
  const processStub = { argv: ['/bin/node', '/bin/cez', ...args], env: {}, cwd: vi.fn(() => '/work'), exitCode: undefined as number | undefined };
  const deps = {
    ...defaultCliDeps,
    process: processStub,
    console: { log: vi.fn(), error: vi.fn() },
    parseArgs: vi.fn(defaultCliDeps.parseArgs),
    productEnv: vi.fn(() => undefined as string | undefined),
    operatorHomeEntry: vi.fn(defaultCliDeps.operatorHomeEntry),
    resolveCliHome: vi.fn(() => home),
    prepareOperatorHome: vi.fn(() => home),
    runSubcommand: vi.fn().mockResolvedValue(undefined),
    getRepoInfo: vi.fn().mockResolvedValue(null),
    runProjectsCommand: vi.fn().mockResolvedValue(0),
    readOwnVersion: vi.fn(() => '1.2.3'),
    serveCommand: vi.fn().mockResolvedValue(undefined),
    serverCommand: vi.fn().mockResolvedValue(undefined),
    runCommand: vi.fn().mockResolvedValue(undefined),
    initCommand: vi.fn(),
    initWorkspace: vi.fn().mockResolvedValue('boot-id'),
  };
  const run = () => main(deps as unknown as CliDeps);
  return { home, processStub, deps, run };
}

describe('main dispatch', () => {
  it.each(['install', 'update', 'versions', 'use', 'link', 'unlink'])('treats the removed managed command %s as unknown without preparing Home', async (command) => {
    const f = fixture([command]);
    await f.run();
    expect(f.deps.console.error).toHaveBeenCalledWith(`unknown command: ${command}\n`);
    expect(f.processStub.exitCode).toBe(1);
    expect(f.deps.prepareOperatorHome).not.toHaveBeenCalled();
  });

  it('dispatches task subcommands before global flags without resolving Home', async () => {
    const f = fixture(['message', '--own-flag']);
    f.deps.runSubcommand.mockResolvedValue(0);
    await f.run();
    expect(f.processStub.exitCode).toBe(0);
    expect(f.deps.runSubcommand).toHaveBeenCalledWith(['message', '--own-flag'], f.processStub.env, expect.any(Function));
    expect(f.deps.parseArgs).not.toHaveBeenCalled();
    expect(f.deps.prepareOperatorHome).not.toHaveBeenCalled();
  });

  it('shares one lazy Home factory across task and ordinary dispatch', async () => {
    const f = fixture();
    f.deps.runSubcommand.mockImplementation(async (_args: string[], _env: unknown, home: () => Home) => {
      expect(home()).toBe(f.home);
      return undefined;
    });
    await f.run();
    expect(f.deps.resolveCliHome).toHaveBeenCalledExactlyOnceWith();
    expect(f.deps.prepareOperatorHome).toHaveBeenCalledExactlyOnceWith(f.home, undefined);
    expect(f.deps.serveCommand).toHaveBeenCalledWith(f.home, '/work', 4321, true, undefined, false);
  });

  it.each(['--help', '-h'])('prints help for %s before repo access or Home preparation', async (flag) => {
    const f = fixture([flag]);
    await f.run();
    const help = f.deps.console.log.mock.calls[0]![0];
    expect(help).toContain(`${productName('cezar')} — local cockpit for AI agent tasks in your repo\n\nUsage:`);
    expect(help).toContain('  cez run "<task>"          run a task headless in the terminal');
    expect(help).toContain('      --no-workers');
    expect(help).toContain('      --no-messaging');
    expect(f.deps.getRepoInfo).not.toHaveBeenCalled();
    expect(f.deps.resolveCliHome).not.toHaveBeenCalled();
    expect(f.deps.prepareOperatorHome).not.toHaveBeenCalled();
    expect(f.processStub.exitCode).toBeUndefined();
  });

  it('uses the current directory and shipped serve defaults without a positional command', async () => {
    const f = fixture();
    await f.run();
    expect(f.deps.getRepoInfo).toHaveBeenCalledWith('/work');
    expect(f.deps.prepareOperatorHome).toHaveBeenCalledWith(f.home, 'serve');
    expect(f.deps.serveCommand).toHaveBeenCalledExactlyOnceWith(f.home, '/work', 4321, true, undefined, false);
    expect(f.processStub.exitCode).toBeUndefined();
  });

  it('resolves the repo root before forwarding serve port, browser, bind, and restart flags', async () => {
    const f = fixture(['--port', '5678', '--repo', '/requested/nested', '--no-open', '--bind-host', '::1', '--restart-exact', 'serve']);
    f.deps.getRepoInfo.mockResolvedValue({ root: '/requested' });
    await f.run();
    expect(f.deps.getRepoInfo).toHaveBeenCalledWith('/requested/nested');
    expect(f.deps.getRepoInfo).toHaveBeenCalledBefore(f.deps.serveCommand);
    expect(f.deps.prepareOperatorHome).toHaveBeenCalledWith(f.home, 'serve');
    expect(f.deps.serveCommand).toHaveBeenCalledWith(f.home, '/requested', 5678, false, '::1', true);
  });

  it('joins and trims run positionals while forwarding workflow, model, and denied access', async () => {
    const f = fixture(['run', '  first', 'second  ', '--workflow', 'checks', '--model', 'chosen-model', '--no-workers', '--no-messaging']);
    await f.run();
    expect(f.deps.runCommand).toHaveBeenCalledExactlyOnceWith(f.home, '/work', 'first second', 'checks', 'chosen-model', { allowWorkers: false, allowMessaging: false });
    expect(f.deps.serveCommand).not.toHaveBeenCalled();
  });

  it('forwards an empty task and default access to runCommand for its own usage handling', async () => {
    const f = fixture(['run']);
    await f.run();
    expect(f.deps.runCommand).toHaveBeenCalledWith(f.home, '/work', '', undefined, undefined, { allowWorkers: true, allowMessaging: true });
    // A usage error is not a writer entry: preparation must not create the home.
    expect(f.deps.prepareOperatorHome).toHaveBeenCalledExactlyOnceWith(f.home, 'run-usage');
  });

  it('prepares Home before scaffolding init', async () => {
    const f = fixture(['init']);
    await f.run();
    expect(f.deps.prepareOperatorHome).toHaveBeenCalledWith(f.home, 'init');
    expect(f.deps.prepareOperatorHome).toHaveBeenCalledBefore(f.deps.initCommand);
    expect(f.deps.initCommand).toHaveBeenCalledExactlyOnceWith('/work');
  });

  it.each([{ args: [] }, { args: ['list'] }])('registers the boot project for a single-project listing: $args', async ({ args: projectArgs }) => {
    const f = fixture(['projects', ...projectArgs]);
    f.deps.productEnv.mockReturnValue('1');
    f.deps.runProjectsCommand.mockResolvedValue(3);
    await f.run();
    expect(f.deps.productEnv).toHaveBeenCalledWith('SINGLE_PROJECT');
    expect(f.deps.initWorkspace).toHaveBeenCalledWith('/work', f.home);
    expect(f.deps.initWorkspace).toHaveBeenCalledBefore(f.deps.runProjectsCommand);
    expect(f.deps.runProjectsCommand).toHaveBeenCalledWith(projectArgs, { defaultRoot: '/work', bootProjectId: 'boot-id', home: f.home });
    expect(f.processStub.exitCode).toBe(3);
  });

  it.each([
    { mode: undefined, args: [] },
    { mode: '1', args: ['add', '/other'] },
    { mode: '1', args: ['remove', 'project-id'] },
  ])('leaves registration to normal guards for projects $args in mode $mode', async ({ mode, args }) => {
    const f = fixture(['projects', ...args]);
    f.deps.productEnv.mockReturnValue(mode);
    await f.run();
    expect(f.deps.initWorkspace).not.toHaveBeenCalled();
    expect(f.deps.runProjectsCommand).toHaveBeenCalledWith(args, { defaultRoot: '/work', bootProjectId: undefined, home: f.home });
  });

  it('forwards all server-install flags and distinguishes an omitted port from its default', async () => {
    const f = fixture(['server-install', '--platform', 'ubuntu-vps', '--yes', '--domain', 'shop.example.com', '--reconfigure', 'tools,service', '--reinstall', '--external-proxy', '--bind-host', '172.17.0.1']);
    await f.run();
    expect(f.deps.serverCommand).toHaveBeenCalledWith('install', f.home, '/work', 'ubuntu-vps', {
      yes: true, domain: 'shop.example.com', reconfigure: 'tools,service', reinstall: true,
      port: undefined, externalProxy: true, bindHost: '172.17.0.1',
    });
  });

  it.each([
    { args: ['-p', '5678'], port: 5678 },
    { args: ['--port', '5678'], port: 5678 },
    { args: ['--port=5678'], port: 5678 },
    // node:util preserves the equals sign in a short option's value; keep the shipped Number conversion.
    { args: ['-p=5678'], port: NaN },
  ])('treats $args as an explicit server-install port', async ({ args, port }) => {
    const f = fixture(['server-install', ...args]);
    await f.run();
    expect(f.deps.serverCommand).toHaveBeenCalledWith('install', f.home, '/work', undefined, {
      yes: false, reconfigure: undefined, reinstall: false, domain: undefined,
      port, externalProxy: false, bindHost: undefined,
    });
  });

  it.each(['deploy', 'uninstall'])('forwards server-%s flags without install-only options', async (mode) => {
    const f = fixture([`server-${mode}`, '--platform', 'ubuntu-vps', '--domain', 'shop.example.com', '--yes', '--port', '5678', '--external-proxy']);
    await f.run();
    expect(f.deps.serverCommand).toHaveBeenCalledWith(mode, f.home, '/work', 'ubuntu-vps', { yes: true, domain: 'shop.example.com' });
  });

  it('prints the same help and exits 1 for an unknown command without preparing Home', async () => {
    const unknown = fixture(['nonsense']);
    const help = fixture(['--help']);
    await unknown.run();
    await help.run();
    expect(unknown.deps.console.error.mock.calls).toEqual([
      ...(REBRAND_SWITCH ? [["[cez] 'cez' is deprecated; use 'hsq' instead."]] : []),
      ['unknown command: nonsense\n'],
    ]);
    expect(unknown.deps.console.log.mock.calls).toEqual(help.deps.console.log.mock.calls);
    expect(unknown.processStub.exitCode).toBe(1);
    expect(unknown.deps.prepareOperatorHome).not.toHaveBeenCalled();
  });

  it('keeps parse errors rejecting after the subcommand dispatcher declines them', async () => {
    const f = fixture(['--unknown-option']);
    await expect(f.run()).rejects.toThrow('Unknown option');
    expect(f.deps.runSubcommand).toHaveBeenCalledBefore(f.deps.parseArgs);
    expect(f.deps.resolveCliHome).not.toHaveBeenCalled();
  });
});

describe('binary help and notices', () => {
  it.each([false, true])('uses legacy help and one gated notice for an npm target entry (switch %s)', async rebrand => {
    const f = fixture(['--help']);
    f.processStub.argv[1] = String.raw`C:\npm\node_modules\@wjarka\cezarion\dist\index.js`;
    await main(f.deps as unknown as CliDeps, rebrand);
    expect(f.deps.console.log.mock.calls[0]![0]).toContain('  cez run "<task>"');
    expect(f.deps.console.error.mock.calls).toEqual(rebrand ? [["[cez] 'cez' is deprecated; use 'hsq' instead."]] : []);
  });
  it('keeps legacy help spelling and paths with the additive version option', async () => {
    const expected = readFileSync(new URL('./home/fixtures/cli-help-legacy.txt', import.meta.url), 'utf8');
    for (const name of ['cez', 'cezarion']) {
      const f = fixture(['--help']);
      f.processStub.argv[1] = `/pkg/dist/${name}.js`;
      await main(f.deps as unknown as CliDeps, false);
      expect(f.deps.console.log).toHaveBeenCalledWith(expected);
      expect(f.deps.console.error).not.toHaveBeenCalled();
    }
  });

  it.each([false, true])('keeps JSON subcommands separate from old-name notices (switch %s)', async rebrand => {
    for (const name of ['cez', 'cezarion', 'hsq']) {
      const f = fixture(['automation', 'schema']);
      f.processStub.argv[1] = `/pkg/dist/${name}.js`;
      f.deps.runSubcommand.mockResolvedValue(0);
      await main(f.deps as unknown as CliDeps, rebrand);
      expect(f.deps.console.error.mock.calls).toEqual(rebrand && name !== 'hsq'
        ? [[`[${name}] '${name}' is deprecated; use 'hsq' instead.`]] : []);
      expect(f.deps.console.log).not.toHaveBeenCalled();
      expect(f.deps.runSubcommand).toHaveBeenCalled();
      expect(f.deps.resolveCliHome).not.toHaveBeenCalled();
    }
  });
  it.each([false, true])('uses the allowed help identity (switch %s)', async rebrand => {
    for (const name of ['cez', 'cezarion', 'hsq']) {
      const f = fixture(['--help']);
      f.processStub.argv[1] = `/pkg/dist/${name}.js`;
      await main(f.deps as unknown as CliDeps, rebrand);
      const expected = rebrand || name === 'hsq' ? name : 'cez';
      const help = f.deps.console.log.mock.calls[0]![0] as string;
      expect(help).toContain(`  ${expected} run "<task>"`);
      expect(help.includes(`  ${expected} migrate [--dry-run]`)).toBe(rebrand);
      expect(help).toContain(`${rebrand ? 'Squawk' : 'cezar'} — local cockpit`);
      expect(help).toContain(`host ${rebrand ? 'Squawk' : 'cezar'} on a server`);
      expect(help).toContain(`resume ${rebrand ? 'Squawk' : 'Cezar'} workers`);
      expect(help).toContain(`scaffold .ai/${rebrand ? 'squawk' : 'cezar'}/`);
      expect(help).toContain(`"skillsRepos" in .ai/${rebrand ? 'squawk' : 'cezar'}/config.json`);
      expect(help).toContain(`workflows in .ai/${rebrand ? 'squawk' : 'cezar'}/workflows/.`);
      expect(help.includes('A project also reads .ai/cezar/')).toBe(rebrand);
      expect(help).not.toContain(' versions | use ');
    }
  });
});


describe.each([false, true])('CLI metadata (switch %s)', rebrand => {
  it.each(['cez', 'cezarion', 'hsq'])('prints only the package version on stdout for %s', async name => {
    for (const flag of ['--version', '-v']) {
      const f = fixture([flag]);
      f.processStub.argv[1] = `/bin/${name}`;
      await main(f.deps as unknown as CliDeps, rebrand);
      expect(f.deps.console.log.mock.calls).toEqual([['1.2.3']]);
      expect(f.processStub.exitCode ?? 0).toBe(0);
      expect(f.deps.console.error).toHaveBeenCalledTimes(rebrand && name !== 'hsq' ? 1 : 0);
      expect(f.deps.resolveCliHome).not.toHaveBeenCalled();
      expect(f.deps.getRepoInfo).not.toHaveBeenCalled();
    }
  });

  it('prints help when home resolution fails', async () => {
    const f = fixture(['--help']);
    f.processStub.argv[1] = '/bin/hsq';
    f.deps.resolveCliHome.mockImplementation(() => { throw new Error('No home directory'); });
    await main(f.deps as unknown as CliDeps, rebrand);
    expect(f.deps.console.log.mock.calls[0]?.[0]).toContain('Usage:');
    expect(f.deps.console.log.mock.calls[0]?.[0]).toContain(
      `manage the desktop installation under ${rebrand ? 'the data folder' : '~/.cezar/versions'}`,
    );
    expect(f.processStub.exitCode ?? 0).toBe(0);
    expect(f.deps.prepareOperatorHome).not.toHaveBeenCalled();
    expect(f.deps.console.error).not.toHaveBeenCalled();
  });

  it('shows the resolved versions path only after the switch', async () => {
    const f = fixture(['--help']);
    f.processStub.argv[1] = '/bin/hsq';
    await main(f.deps as unknown as CliDeps, rebrand);
    expect(f.deps.console.log.mock.calls[0]?.[0]).toContain(
      `manage the desktop installation under ${rebrand ? f.home.versions : '~/.cezar/versions'}`,
    );
    expect(f.deps.prepareOperatorHome).not.toHaveBeenCalled();
  });
});
