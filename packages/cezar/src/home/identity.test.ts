import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { productIdentity } from './identity.ts';
import { REBRAND_SWITCH } from './switch.ts';

describe('shared product identity', () => {
  it('keeps the shipped identity with the switch off', () => {
    expect(productIdentity(false)).toEqual({
      rebrand: false, displayName: 'Cezarion', command: 'cez', npmPackage: '@wjarka/cezarion',
      npmAlias: 'cezarion', envPrefix: 'CEZ_', desktopAppId: 'tools.hearsay.cezarion',
      mobileAppId: 'tools.hearsay.cezarion.mobile', desktopExecutable: 'cezar-desktop',
    });
  });
  it('selects the new identity with the switch on', () => {
    expect(productIdentity(true)).toEqual({
      rebrand: true, displayName: 'Squawk', command: 'hsq', npmPackage: '@hearsay-tools/squawk',
      npmAlias: 'hsq', envPrefix: 'HSQ_', desktopAppId: 'tools.hearsay.squawk',
      mobileAppId: 'tools.hearsay.squawk.mobile', desktopExecutable: 'squawk-desktop',
    });
  });
  it('uses the release switch by default', () => {
    expect(productIdentity()).toEqual(productIdentity(REBRAND_SWITCH));
  });
});

describe('native build identity command', () => {
  const script = fileURLToPath(new URL('../../scripts/product-identity.mjs', import.meta.url));
  it.each([[], ['--rebrand', 'on'], ['--rebrand', 'off']])('prints one JSON object for %j', (...args) => {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    expect(result.status, result.stderr).toBe(0);
    const expected = args.length === 0 ? REBRAND_SWITCH : args[1] === 'on';
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
