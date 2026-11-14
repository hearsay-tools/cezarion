import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { productIdentity } from '../home/identity.ts';
import type { ManifestLike } from './manifests.ts';

/** Shared shim bytes for packing and trusted archive validation. */
export function compatibilityEntry(): string {
  return `#!/usr/bin/env node\nimport ${JSON.stringify(productIdentity(true).npmPackage)};\n`;
}

/** Every recorded entry survives promotion, including the original single-bin alias. */
export const COMPATIBILITY_ENTRIES = ['dist/index.js', 'dist/hsq.js', 'dist/cez.js', 'dist/cezarion.js',
  'bin.js', 'cezarion.js', 'cez.js', 'hsq.js'] as const;

/** Matching old-name releases retain deterministic updates during the deprecation window. */
export function compatibilityManifests(runtime: ManifestLike): Record<string, ManifestLike> {
  if (runtime.private === true) return {};
  const old = productIdentity(false), active = productIdentity(true);
  const shared = {
    version: runtime.version, type: 'module', license: runtime.license,
    repository: runtime.repository, homepage: runtime.homepage, bugs: runtime.bugs,
    engines: runtime.engines, gitHead: runtime.gitHead,
    dependencies: { [active.npmPackage]: runtime.version },
    bin: { cezarion: 'dist/index.js', cez: 'dist/index.js', hsq: 'dist/hsq.js' },
    exports: { '.': './dist/index.js', './app-type': './dist/server/app-type.js', './package.json': './package.json' },
    files: ['dist', 'web/dist', 'bin.js', 'cezarion.js', 'cez.js', 'hsq.js'],
  };
  return {
    legacyScoped: { ...shared, name: old.npmPackage },
    // Shipped alias updaters validate the old scoped dependency. Keep the direct
    // runtime edge too, so the new updater retains its canonical runtime paths.
    legacyAlias: { ...shared, name: old.npmAlias,
      dependencies: { [active.npmPackage]: runtime.version, [old.npmPackage]: runtime.version } },
  };
}

/** Disposable pack trees only. The dispatcher owns the notice; these imports add none. */
export function withCompatibilityPackages<T>(source: string, runtime: ManifestLike,
  action: (packages: Record<string, { dir: string; manifest: ManifestLike }>) => T): T {
  const manifests = compatibilityManifests(runtime);
  if (!Object.keys(manifests).length) return action({});
  const root = mkdtempSync(join(tmpdir(), 'release-compatibility-'));
  try {
    const packages = Object.fromEntries(Object.entries(manifests).map(([key, manifest]) => {
      const dir = join(root, key);
      mkdirSync(join(dir, 'dist'), { recursive: true });
      // Both old scoped validators and managed installs require the real built cockpit.
      cpSync(join(source, 'web/dist'), join(dir, 'web/dist'), { recursive: true });
      for (const entry of COMPATIBILITY_ENTRIES) {
        writeFileSync(join(dir, entry), compatibilityEntry(), { mode: 0o755 });
      }
      mkdirSync(join(dir, 'dist/server'), { recursive: true });
      const appType = `${JSON.stringify(`${productIdentity(true).npmPackage}/app-type`)};\n`;
      writeFileSync(join(dir, 'dist/server/app-type.js'), `export * from ${appType}`);
      writeFileSync(join(dir, 'dist/server/app-type.d.ts'), `export type * from ${appType}`);
      writeFileSync(join(dir, 'package.json'), `${JSON.stringify(manifest, null, 2)}\n`);
      return [key, { dir, manifest }];
    }));
    return action(packages);
  } finally { rmSync(root, { recursive: true, force: true }); }
}
