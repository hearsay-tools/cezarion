import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Home } from '../home/home.ts';
import { NPM_LAUNCH_PACKAGES } from '../home/identity.ts';
import { isForeignNpxExecStart, isNpxExecStart, ownedNpxPackage, refreshNpxCacheForRedeploy } from './npx-cache.ts';
import { ownsLaunchdPlist } from './platforms/macosx-launchd-files.ts';
import { squawkLaunchdPlist, resolveSquawkArgv } from './platforms/macosx-ngrok.ts';
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
      writeFileSync(join(cache, '_npx', String(index), 'package.json'), JSON.stringify({ dependencies: { [candidate]: '^0.17.0' } }));
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
  it.each([
    { dependencies: { foreign: '^1.0.0' } },
    { dependencies: { '@wjarka/cezarion': 'npm:foreign@1.0.0' } },
    { dependencies: { '@wjarka/cezarion': 'file:/foreign' } },
    { dependencies: { '@wjarka/cezarion': '^0.17.0', foreign: '^1.0.0' } },
    { dependencies: { '@wjarka/cezarion': '' } },
    { dependencies: null },
    null,
  ])('preserves unowned roots even when our scoped package is hoisted: %j', manifest => {
    const ctx = context();
    const cache = join(ctx.home.root, 'npm');
    const root = join(cache, '_npx/foreign');
    vi.stubEnv('npm_config_cache', cache);
    mkdirSync(join(root, 'node_modules/@wjarka/cezarion'), { recursive: true });
    writeFileSync(join(root, 'package.json'), JSON.stringify(manifest));
    refreshNpxCacheForRedeploy(ctx, '/usr/bin/npx --yes @wjarka/cezarion serve');
    expect(existsSync(root)).toBe(true);
  });
  it('preserves roots with missing or malformed request metadata', () => {
    const ctx = context();
    const cache = join(ctx.home.root, 'npm');
    const root = join(cache, '_npx/unknown');
    vi.stubEnv('npm_config_cache', cache);
    mkdirSync(join(root, 'node_modules/@wjarka/cezarion'), { recursive: true });
    refreshNpxCacheForRedeploy(ctx, '/usr/bin/npx --yes @wjarka/cezarion serve');
    expect(existsSync(root)).toBe(true);
    writeFileSync(join(root, 'package.json'), '{');
    refreshNpxCacheForRedeploy(ctx, '/usr/bin/npx --yes @wjarka/cezarion serve');
    expect(existsSync(root)).toBe(true);
  });
  it.each(['hsq', 'hsq@latest'])('rejects the unpublished unscoped name %s', pkg => {
    expect(isNpxExecStart(`/usr/bin/npx --yes ${pkg} serve`)).toBe(false);
    expect(isForeignNpxExecStart(`/usr/bin/npx --yes ${pkg} serve`)).toBe(true);
  });
  it('recognizes the scoped package run through -p and refreshes only its cache', () => {
    const ctx = context();
    const cache = join(ctx.home.root, 'npm');
    vi.stubEnv('npm_config_cache', cache);
    for (const [index, candidate] of ['@hearsay-tools/squawk', '@wjarka/cezarion'].entries()) {
      mkdirSync(join(cache, '_npx', String(index), 'node_modules', candidate), { recursive: true });
      writeFileSync(join(cache, '_npx', String(index), 'package.json'), JSON.stringify({ dependencies: { [candidate]: '^0.18.0' } }));
    }
    for (const command of ['/usr/bin/npx --yes -p @hearsay-tools/squawk hsq serve', '/usr/bin/npx -p @hearsay-tools/squawk@0.18.0 hsq serve',
      '/usr/bin/npx --package @hearsay-tools/squawk cez serve']) {
      expect(isNpxExecStart(command)).toBe(true);
    }
    for (const command of ['/usr/bin/npx --yes -p @hearsay-tools/squawk foreign serve', '/usr/bin/npx --yes -p foreign hsq serve', '/usr/bin/npx --yes -p @hearsay-tools/squawk']) {
      expect(isNpxExecStart(command)).toBe(false);
      expect(isForeignNpxExecStart(command)).toBe(true);
    }
    refreshNpxCacheForRedeploy(ctx, '/usr/bin/npx --yes -p @hearsay-tools/squawk hsq serve');
    expect(existsSync(join(cache, '_npx/0'))).toBe(false);
    expect(existsSync(join(cache, '_npx/1'))).toBe(true);
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

/** A plist as an install made before the rename wrote it: the old label. */
const legacyLabel = (xml: string) => xml.replaceAll('tools.hearsay.squawk.', 'ai.cezar.');

describe('launchd ownership and selected command generation', () => {
  it('accepts new and old package forms while rejecting unrelated launchers', () => {
    const ctx = context();
    const artifact = { kind: 'owned', type: 'launchd', name: 'ai.cezar.cockpit', path: '/tmp/cockpit.plist' } as const;
    for (const pkg of [...NPM_LAUNCH_PACKAGES, 'cez', 'cezar-cli', 'foreign-cezarion']) {
      const xml = legacyLabel(squawkLaunchdPlist('/repo', 4321, ['/usr/bin/npx', '--yes', pkg]));
      expect(ownsLaunchdPlist(ctx, artifact, xml)).toBe((NPM_LAUNCH_PACKAGES as readonly string[]).includes(pkg));
    }
    for (const [argv, owned] of [[['/usr/bin/npx', '--yes', '-p', '@hearsay-tools/squawk', 'hsq'], true],
      [['/usr/bin/npx', '--yes', '-p', '@hearsay-tools/squawk', 'foreign'], false], [['/usr/bin/npx', '--yes', '-p', 'foreign', 'hsq'], false],
      [['/usr/bin/npx', '--yes', 'hsq'], false]] as const) {
      expect(ownsLaunchdPlist(ctx, artifact, legacyLabel(squawkLaunchdPlist('/repo', 4321, [...argv])))).toBe(owned);
    }
    const entry = fileURLToPath(new URL('../../dist/hsq.js', import.meta.url));
    for (const script of [entry, '/usr/local/bin/hsq', '/usr/local/bin/cez', '/usr/local/bin/cezarion', '/foreign/dist/hsq.js', '/usr/local/bin/cezar-cli']) {
      const xml = legacyLabel(squawkLaunchdPlist('/repo', 4321, ['/usr/bin/node', script]));
      expect(ownsLaunchdPlist(ctx, artifact, xml)).toBe(!script.includes('/foreign/') && !script.endsWith('cezar-cli'));
    }
  });
  it('selects the service entry and package', async () => {
    const ctx = context();
    ctx.dryRun = true;
    const argv = await resolveSquawkArgv(ctx);
    expect(argv[1]).toMatch(/[\\/]dist[\\/]hsq\.js$/);
    const opts = { node: '/bin/node', pkgRoot: '/pkg', entry: join('/pkg/dist', 'index.js'), entryExists: true, npxPath: '/bin/npx' };
    const selected = serviceExecStart(opts);
    expect(selected).toBe(`/bin/node ${join('/pkg/dist', 'hsq.js')}`);
    const npx = serviceExecStart({ ...opts, pkgRoot: '/cache/_npx/abc/node_modules/cezarion' });
    expect(npx).toBe('/bin/npx --yes -p @hearsay-tools/squawk hsq');
    expect(ownedNpxPackage(`${npx} serve --no-open`)).toBe('@hearsay-tools/squawk');
    const unit = systemdUnit('/repo', 4321, 'user', selected);
    expect(unit).toContain(`ExecStart=${selected} serve --no-open --port 4321`);
    expect(unit).toContain('Environment=CEZ_REMOTE=1\nEnvironment=HSQ_REMOTE=1');
  });
});
