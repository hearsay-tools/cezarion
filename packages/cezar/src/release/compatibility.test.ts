import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { productIdentity } from '../home/identity.ts';
import { COMPATIBILITY_ENTRIES, compatibilityManifests, withCompatibilityPackages } from './compatibility.ts';

it('does not publish forwarders to a private runtime', () => {
  expect(compatibilityManifests({ name: productIdentity().npmPackage, version: '1.2.3', private: true })).toEqual({});
  expect(withCompatibilityPackages('/does/not/exist', { name: productIdentity().npmPackage, version: '1.2.3', private: true }, packages => packages)).toEqual({});
});
it.each([false, true])('cleans both pack trees after callback failure %s; preserves source bytes', fail => {
  const root = mkdtempSync(join(tmpdir(), 'compatibility-test-'));
  const runtime = { name: productIdentity(true).npmPackage, version: '1.2.3', engines: { node: '>=24.21.0' } };
  const paths: string[] = [];
  try {
    mkdirSync(join(root, 'web/dist/assets'), { recursive: true });
    writeFileSync(join(root, 'web/dist/index.html'), '<script src="/assets/app.js"></script>');
    writeFileSync(join(root, 'web/dist/assets/app.js'), 'real built asset');
    const run = () => withCompatibilityPackages(root, runtime, packages => {
      expect(Object.values(packages).map(p => p.manifest.name)).toEqual([productIdentity(false).npmPackage, productIdentity(false).npmAlias]);
      for (const { dir, manifest } of Object.values(packages)) {
        paths.push(dir);
        expect(manifest.dependencies).toEqual({ [runtime.name]: runtime.version,
          ...(manifest.name === productIdentity(false).npmAlias ? { [productIdentity(false).npmPackage]: runtime.version } : {}) });
        expect(manifest.bin).toMatchObject({ cezarion: 'dist/index.js', cez: 'dist/index.js' });
        expect(readFileSync(join(dir, 'web/dist/assets/app.js'), 'utf8')).toBe('real built asset');
        for (const entry of COMPATIBILITY_ENTRIES) expect(readFileSync(join(dir, entry), 'utf8')).toBe(`#!/usr/bin/env node\nimport ${JSON.stringify(runtime.name)};\n`);
      }
      if (fail) throw new Error('pack failed');
    });
    if (fail) expect(run).toThrow('pack failed'); else run();
    expect(paths.every(path => !existsSync(path))).toBe(true);
    expect(readFileSync(join(root, 'web/dist/assets/app.js'), 'utf8')).toBe('real built asset');
  } finally { rmSync(root, { recursive: true, force: true }); }
});
