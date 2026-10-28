import { mkdtempSync, mkdirSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { linuxDeviceNumber, pinnedAliasIdentity } from './linux-alias-identity.ts';

it.runIf(process.platform === 'linux')('pins fixture objects and refuses redirects, nondirectories and outside paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'cez-alias-ident-'));
  try {
    mkdirSync(join(root, 'dir'));
    writeFileSync(join(root, 'dir', 'file'), 'fixture');
    symlinkSync('dir', join(root, 'link'));
    expect(pinnedAliasIdentity(root, join(root, 'dir', 'file')).ino).toBeGreaterThan(0n);
    const identity = statSync(root, { bigint: true });
    expect(pinnedAliasIdentity(root, join(root, 'dir', 'file'), `${identity.dev}:${identity.ino}`).ino).toBeGreaterThan(0n);
    expect(() => pinnedAliasIdentity(root, join(root, 'dir', 'file'), `${identity.dev}:${identity.ino + 1n}`)).toThrow('identity changed');
    expect(() => pinnedAliasIdentity(root, join(root, 'link', 'file'))).toThrow();
    expect(() => pinnedAliasIdentity(root, join(root, 'dir', 'file', 'child'))).toThrow();
    expect(() => pinnedAliasIdentity(root, join(root, '..', 'outside'))).toThrow();
    expect(linuxDeviceNumber(0x801n)).toBe('8:1');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
