import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  isPublishable,
  publicationManifests,
  releaseManifestDirs,
  RELEASE_MANIFEST_DIRS,
  releaseRunCommand,
  stampManifestSet,
  type ReleaseManifests,
} from './manifests.ts';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '../../../..');

const set = (): ReleaseManifests => ({
  contract: { name: '@scope/contract', version: '0.1.5' },
  apiClient: { name: '@scope/client', version: '0.1.5' },
  cezar: {
    name: '@scope/impl',
    version: '0.1.5',
    devDependencies: { '@scope/client': '^0.1.5' },
  },
  web: {
    name: '@scope/web',
    version: '0.1.5',
    private: true,
    dependencies: { '@scope/client': '^0.1.5', react: '^19.0.0' },
    devDependencies: { '@scope/impl': '^0.1.5' },
  },
  alias: { name: 'impl-cli', version: '0.1.5', dependencies: { '@scope/impl': '^0.1.5' } },
});

describe('RELEASE_MANIFEST_DIRS', () => {
  it('covers every npm workspace so a new workspace cannot escape the stamped set', () => {
    const root = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as {
      workspaces: string[];
    };
    expect(root.workspaces.length).toBeGreaterThan(0);
    const stamped = Object.values(RELEASE_MANIFEST_DIRS);
    for (const workspace of root.workspaces) {
      expect(stamped, `workspace ${workspace} is not in RELEASE_MANIFEST_DIRS`).toContain(workspace);
    }
  });
});

describe('stampManifestSet', () => {
  it('stamps the cockpit and re-pins its intra-release ranges', () => {
    const stamped = stampManifestSet(set(), '0.1.6', (v) => `^${v}`);

    expect(stamped.web.version).toBe('0.1.6');
    expect(stamped.web.private).toBe(true);
    expect(isPublishable(stamped.web)).toBe(false);
    expect(stamped.web.dependencies).toEqual({ '@scope/client': '^0.1.6', react: '^19.0.0' });
    expect(stamped.web.devDependencies).toEqual({ '@scope/impl': '^0.1.6' });
  });

  it('stamps every key in RELEASE_MANIFEST_DIRS', () => {
    const stamped = stampManifestSet(set(), '0.1.6', (v) => `^${v}`);
    for (const key of Object.keys(RELEASE_MANIFEST_DIRS) as (keyof ReleaseManifests)[]) {
      expect(stamped[key]!.version).toBe('0.1.6');
    }
  });
});


describe('release identities', () => {
  it.each([false, true])('selects the alias only with rebrand %s off, because npm refuses `hsq`', rebrand => {
    const dirs = releaseManifestDirs(rebrand);
    expect(dirs.alias).toBe(rebrand ? undefined : 'alias-cezarion');
    expect('alias' in dirs).toBe(!rebrand);
    expect(dirs.cezar).toBe('packages/cezar');
  });
  it('runs the alias, or the scoped package with its hsq binary when there is no alias', () => {
    const source = set();
    expect(releaseRunCommand(source, '0.1.6')).toBe('npx impl-cli@0.1.6');
    const { alias: _alias, ...noAlias } = publicationManifests(source, true);
    expect(releaseRunCommand(noAlias, 'nightly')).toBe('npx -p @hearsay-tools/squawk@nightly hsq');
  });
  it('preserves the complete switch-off publication bytes and source objects', () => {
    const source = set();
    expect(publicationManifests(source, false)).toBe(source);
    expect(JSON.stringify(publicationManifests(source, false))).toBe(JSON.stringify(source));
  });
  it('projects the published service name without changing workspace names or dependency keys', () => {
    const source = set();
    const published = publicationManifests(source, true);
    expect(published.cezar.name).toBe('@hearsay-tools/squawk');
    expect(source.cezar.name).toBe('@scope/impl');
    expect(published.web).toBe(source.web);
    expect(published.apiClient).toBe(source.apiClient);
    expect(published.cezar.devDependencies).toEqual(source.cezar.devDependencies);
  });
  it('stamps a set without an alias and adds none', () => {
    const { alias: _alias, ...source } = set();
    const stamped = stampManifestSet(source, '0.1.6', v => `^${v}`);
    expect('alias' in stamped).toBe(false);
    expect(stamped.web.devDependencies).toEqual({ '@scope/impl': '^0.1.6' });
  });
});
