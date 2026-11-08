import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { NPM_LAUNCH_PACKAGES } from '../home/identity.ts';
import { isForeignNpxExecStart, isNpxExecStart, ownedNpxPackage, refreshNpxCacheForRedeploy } from './npx-cache.ts';
import { ownsLaunchdPlist } from './platforms/macosx-launchd-files.ts';
import { cezarLaunchdPlist, resolveCezarArgv } from './platforms/macosx-ngrok.ts';
import { serviceExecStart, systemdUnit } from './platforms/ubuntu-vps.ts';
import { freshServerState, type InstallContext } from './types.ts';
import { createAutoUi } from './ui.ts';

const roots: string[] = [];
function context(): InstallContext {
  const root = mkdtempSync(join(tmpdir(), 'binary-install-'));
  roots.push(root);
  return {
    home: Home.sandbox(root), state: freshServerState(), instance: 'default', ui: createAutoUi(),
    save: vi.fn(async () => {}), dryRun: false, assumeYes: true, reconfigure: new Set(),
    repoRoot: '/repo', now: '2026-11-08T00:00:00.000Z', prefs: {},
    runner: { capture: vi.fn(async () => ({ code: 0, stdout: '/usr/bin/hsq', stderr: '' })), interactive: vi.fn(async () => 0) },
  };
}
afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })); });

describe('exact npm launch ownership', () => {
  it.each(NPM_LAUNCH_PACKAGES)('recognizes %s and refreshes only its matching cache', pkg => {
    const ctx = context();
    const cache = join(ctx.home.root, 'npm');
    vi.stubEnv('npm_config_cache', cache);
    for (const [index, candidate] of [...NPM_LAUNCH_PACKAGES, 'cez', 'cezar-cli'].entries()) {
      mkdirSync(join(cache, '_npx', String(index), 'node_modules', candidate), { recursive: true });
    }
    const command = `/usr/bin/npx --yes ${pkg} serve --no-open`;
    expect(isNpxExecStart(command)).toBe(true);
    expect(isForeignNpxExecStart(command)).toBe(false);
    expect(ownedNpxPackage(command.replace(pkg, `${pkg}@latest`))).toBe(pkg);
    expect(ownedNpxPackage(`ExecStart={ path=/usr/bin/npx ; argv[]=${command} ; ignore_errors=no ; }`)).toBe(pkg);
    refreshNpxCacheForRedeploy(ctx, command);
    for (const [index, candidate] of [...NPM_LAUNCH_PACKAGES, 'cez', 'cezar-cli'].entries()) {
      expect(existsSync(join(cache, '_npx', String(index)))).toBe(candidate !== pkg);
    }
  });
  it.each(['cez', 'cezar-cli', 'foreign-cezarion', 'cezarion-foreign', '@foreign/cezarion', '@hearsay-tools/squawk-foreign', 'cezarion@npm:cezar-cli', 'hsq@file:/foreign', 'hsq@'])('rejects foreign package %s', pkg => {
    const command = `/usr/bin/npx --yes ${pkg} serve --repo /srv/cezarion`;
    expect(isNpxExecStart(command)).toBe(false);
    expect(isForeignNpxExecStart(command)).toBe(true);
  });
  it.each(['/bin/node /cache/_npx/abc/cezarion/dist/index.js', '/bin/cezarion serve', '/bin/echo npx cezarion', ''])('does not treat %j as npx', command => {
    expect(isNpxExecStart(command)).toBe(false);
    expect(isForeignNpxExecStart(command)).toBe(false);
  });
});

describe('launchd ownership and selected command generation', () => {
  it('accepts new and old package forms while rejecting unrelated launchers', () => {
    const ctx = context();
    const artifact = { kind: 'owned', type: 'launchd', name: 'ai.cezar.cockpit', path: '/tmp/cockpit.plist' } as const;
    for (const pkg of [...NPM_LAUNCH_PACKAGES, 'cez', 'cezar-cli', 'foreign-cezarion']) {
      const xml = cezarLaunchdPlist('/repo', 4321, ['/usr/bin/npx', '--yes', pkg], false);
      expect(ownsLaunchdPlist(ctx, artifact, xml)).toBe((NPM_LAUNCH_PACKAGES as readonly string[]).includes(pkg));
    }
    const entry = fileURLToPath(new URL('../../dist/hsq.js', import.meta.url));
    for (const script of [entry, '/usr/local/bin/hsq', '/usr/local/bin/cez', '/usr/local/bin/cezarion', '/foreign/dist/hsq.js', '/usr/local/bin/cezar-cli']) {
      const xml = cezarLaunchdPlist('/repo', 4321, ['/usr/bin/node', script], false);
      expect(ownsLaunchdPlist(ctx, artifact, xml)).toBe(!script.includes('/foreign/') && !script.endsWith('cezar-cli'));
    }
  });
  it.each([false, true])('selects the service entry and alias (switch %s)', async rebrand => {
    const ctx = context();
    ctx.dryRun = true;
    const argv = await resolveCezarArgv(ctx, rebrand);
    expect(argv[1]).toMatch(rebrand ? /[\\/]dist[\\/]hsq\.js$/ : /[\\/]dist[\\/]index\.js$/);
    const opts = { node: '/bin/node', pkgRoot: '/pkg', entry: join('/pkg/dist', 'index.js'), entryExists: true, npxPath: '/bin/npx' };
    const selected = serviceExecStart(opts, rebrand);
    expect(selected).toBe(`/bin/node ${join('/pkg/dist', rebrand ? 'hsq.js' : 'index.js')}`);
    expect(serviceExecStart({ ...opts, pkgRoot: '/cache/_npx/abc/node_modules/cezarion' }, rebrand)).toBe(`/bin/npx --yes ${rebrand ? 'hsq' : 'cezarion'}`);
    const unit = systemdUnit('/repo', 4321, 'user', selected, undefined, rebrand);
    expect(unit).toContain(`ExecStart=${selected} serve --no-open --port 4321`);
    expect(unit).toContain('Environment=CEZ_REMOTE=1\nEnvironment=HSQ_REMOTE=1');
  });
});
