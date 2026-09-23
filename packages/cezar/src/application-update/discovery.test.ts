import { mkdtempSync, mkdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { discoverInstallation } from './discovery.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(kind: 'global' | 'npx', outer = '@wjarka/cezarion', request = outer) {
  const root = mkdtempSync(join(tmpdir(), 'cez-update-discover-')); roots.push(root);
  const prefix = join(root, 'prefix');
  const cache = join(root, 'cache');
  const installRoot = kind === 'global' ? prefix : join(cache, '_npx', 'abcdef');
  const modules = join(installRoot, kind === 'global' ? 'lib/node_modules' : 'node_modules');
  const outerPath = join(modules, outer);
  const scoped = outer === 'cezarion' ? join(outerPath, 'node_modules/@wjarka/cezarion') : outerPath;
  mkdirSync(join(scoped, 'dist'), { recursive: true });
  writeFileSync(join(scoped, 'package.json'), JSON.stringify({ name: '@wjarka/cezarion', version: '1.0.0', bin: { cez: 'dist/index.js' } }));
  writeFileSync(join(scoped, 'dist/index.js'), '');
  if (outer === 'cezarion') {
    writeFileSync(join(outerPath, 'package.json'), JSON.stringify({ name: 'cezarion', version: '1.0.0', dependencies: { '@wjarka/cezarion': '^1.0.0' }, bin: { cezarion: 'bin.js' } }));
    writeFileSync(join(outerPath, 'bin.js'), '');
  }
  if (kind === 'npx') {
    writeFileSync(join(installRoot, 'package.json'), JSON.stringify({ _npx: { packages: [request] }, dependencies: { [outer]: '1.0.0' } }));
  }
  const launchEntry = join(outerPath, outer === 'cezarion' ? 'bin.js' : 'dist/index.js');
  return { root, prefix, cache, packageRoot: realpathSync(scoped), launchEntry, installRoot, outerPath };
}

describe('npm installation discovery', () => {
  it('recognizes verified global and ordinary npx installations', () => {
    const global = fixture('global');
    expect(discoverInstallation(global).kind).toBe('global');
    const npx = fixture('npx', 'cezarion', 'cezarion');
    expect(discoverInstallation(npx)).toMatchObject({ kind: 'npx', outerPackage: 'cezarion', request: 'cezarion' });
  });

  it('recognizes npm-hoisted scoped dependency for the published default alias', () => {
    const npx = fixture('npx', 'cezarion', 'cezarion');
    const hoisted = join(npx.installRoot, 'node_modules/@wjarka/cezarion');
    mkdirSync(join(npx.installRoot, 'node_modules/@wjarka'), { recursive: true });
    // npm commonly hoists this dependency beside the alias package.
    const nested = npx.packageRoot;
    renameSync(nested, hoisted);
    expect(discoverInstallation({ ...npx, packageRoot: hoisted })).toMatchObject({ kind: 'npx', outerPackage: 'cezarion' });
  });

  it('refuses pinned or mixed npx request metadata', () => {
    const pinned = fixture('npx', 'cezarion', 'cezarion@1.0.0');
    expect(discoverInstallation(pinned).kind).toBe('unsupported');
    const mixed = fixture('npx', 'cezarion', 'cezarion');
    writeFileSync(join(mixed.installRoot, 'package.json'), JSON.stringify({ _npx: { packages: ['cezarion', 'other'] } }));
    expect(discoverInstallation(mixed).kind).toBe('unsupported');
  });

  it('refuses linked global package roots and unrecognized source layouts', () => {
    const linked = fixture('global');
    const source = join(linked.root, 'source'); mkdirSync(source);
    rmSync(linked.packageRoot, { recursive: true }); symlinkSync(source, linked.packageRoot, 'dir');
    expect(discoverInstallation({ ...linked, packageRoot: source }).kind).toBe('unsupported');
    expect(discoverInstallation({ ...linked, packageRoot: join(linked.root, 'checkout') }).kind).toBe('unsupported');
  });

  it('refuses a package manifest with the wrong scoped identity', () => {
    const global = fixture('global');
    writeFileSync(join(global.packageRoot, 'package.json'), JSON.stringify({ name: '@other/tool', version: '1.0.0' }));
    expect(discoverInstallation(global)).toMatchObject({ kind: 'unsupported' });
  });

  it('refuses a launch entry outside the matched installation', () => {
    const npx = fixture('npx');
    expect(discoverInstallation({ ...npx, launchEntry: join(npx.root, 'other.js') }).kind).toBe('unsupported');
  });

  it('keeps the original npm bin link as the restart entry', () => {
    const npx = fixture('npx', 'cezarion', 'cezarion');
    const link = join(npx.installRoot, 'node_modules/.bin/cezarion');
    mkdirSync(join(npx.installRoot, 'node_modules/.bin'), { recursive: true });
    symlinkSync('../cezarion/bin.js', link);
    expect(discoverInstallation({ ...npx, launchEntry: link })).toMatchObject({ kind: 'npx', launchEntry: link });
  });
});
