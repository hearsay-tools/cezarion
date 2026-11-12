import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runtimeImports } from './lint/import-closure.testkit.ts';

/**
 * Every Squawk test file loads `vitest.setup.ts`, so Squeal reruns every test when a module the
 * setup loads at runtime changes (hearsay-tools/cezarion#3241). The setup's closure stays on
 * leaf modules: a new runtime import anywhere in it fails here, and widening the list is a
 * decision about every test's rerun set. TypeScript erases type-only imports, so they are not
 * followed.
 */
const repo = join(import.meta.dirname, '../../..');
const CONTRACT = '@open-mercato/cezar-contract';

const LOCAL_MODULES = [
  'packages/cezar/src/home/test-home-selector.testkit.ts',
  'packages/cezar/src/runs/run-exits.ts',
  'packages/cezar/src/test-outbound-guard.testkit.ts',
  'packages/cezar/vitest.setup.ts',
  'packages/contract/src/usage-limit-hold.ts',
  'scripts/check-workspace-resolution.mjs',
  'scripts/test-home-setup.mjs',
  'scripts/test-install-marker.mjs',
  'scripts/test-sandbox.mjs',
];
const PACKAGES = ['node:crypto', 'node:fs', 'node:module', 'node:net', 'node:os', 'node:path', 'node:url', 'vitest'];

/** The repository file a specifier names, or undefined for a package the walk does not enter. */
function resolveLocal(from: string, specifier: string): string | undefined {
  if (specifier.startsWith('./') || specifier.startsWith('../')) return join(dirname(from), specifier).replace(/\.js$/, '.ts');
  if (specifier === CONTRACT) return join(repo, 'packages/contract/src/index.ts');
  if (specifier.startsWith(`${CONTRACT}/`)) return join(repo, 'packages/contract/src', `${specifier.slice(CONTRACT.length + 1)}.ts`);
  return undefined;
}

function setupClosure(): { modules: string[]; packages: string[] } {
  const modules = new Set<string>();
  const packages = new Set<string>();
  const visit = (path: string): void => {
    if (modules.has(path)) return;
    modules.add(path);
    for (const specifier of runtimeImports(readFileSync(path, 'utf8'), path)) {
      const local = resolveLocal(path, specifier);
      if (local) visit(local);
      else packages.add(specifier);
    }
  };
  visit(join(repo, 'packages/cezar/vitest.setup.ts'));
  return { modules: [...modules].map(path => relative(repo, path)).sort(), packages: [...packages].sort() };
}

describe('the vitest setup file', () => {
  it('loads only its pinned leaf modules at runtime', () => {
    expect(setupClosure()).toEqual({ modules: LOCAL_MODULES, packages: PACKAGES });
  });
});
