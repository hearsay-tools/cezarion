import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { NPM_LAUNCH_PACKAGES, npmPackageIdentity, npxCommand, productIdentity } from './identity.ts';

describe('shared product identity', () => {
  it('keeps the old identity for compatibility packages and old-app builds', () => {
    expect(productIdentity(false)).toEqual({
      rebrand: false, displayName: 'Cezarion', command: 'cez', npmPackage: '@wjarka/cezarion',
      npmAlias: 'cezarion', npmAliasDirectory: 'alias-cezarion', npx: 'npx cezarion', envPrefix: 'CEZ_', desktopAppId: 'tools.hearsay.cezarion',
      mobileAppId: 'tools.hearsay.cezarion.mobile', desktopExecutable: 'cezar-desktop',
    });
  });
  it('selects the new identity by default', () => {
    expect(productIdentity()).toEqual(productIdentity(true));
    expect(productIdentity(true)).toEqual({
      rebrand: true, displayName: 'Squawk', command: 'hsq', npmPackage: '@hearsay-tools/squawk',
      npmAlias: null, npmAliasDirectory: null, npx: 'npx -p @hearsay-tools/squawk hsq', envPrefix: 'HSQ_', desktopAppId: 'tools.hearsay.squawk',
      mobileAppId: 'tools.hearsay.squawk.mobile', desktopExecutable: 'squawk-desktop',
    });
  });
  it('runs the scoped package for a one-off command, because npm refuses the name hsq', () => {
    expect(npxCommand()).toBe('npx -p @hearsay-tools/squawk hsq');
    expect(npxCommand('1.2.3')).toBe('npx -p @hearsay-tools/squawk@1.2.3 hsq');
    expect(npxCommand()).toBe(productIdentity().npx);
    expect(NPM_LAUNCH_PACKAGES).toEqual(['@wjarka/cezarion', 'cezarion', '@hearsay-tools/squawk']);
    expect(npmPackageIdentity('hsq')).toBeUndefined();
  });
});

describe('native build identity command', () => {
  const script = fileURLToPath(new URL('../../scripts/product-identity.mjs', import.meta.url));
  it.each([[], ['--rebrand', 'on'], ['--rebrand', 'off']])('prints one JSON object for %j', (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const expected = args.length === 0 || args[1] === 'on';
    expect(JSON.parse(result.stdout)).toEqual(productIdentity(expected));
    expect(result.stdout.trim().split('\n')).toHaveLength(1);
  });
  it.each([['--bad'], ['--rebrand'], ['--rebrand', 'yes'], ['--rebrand', 'on', 'extra']])('rejects invalid arguments %j', (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('Usage:');
  });
});
