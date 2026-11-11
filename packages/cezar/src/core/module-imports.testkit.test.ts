import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { runtimeImports, siblingImports } from './module-imports.testkit.ts';

const CELLS = /^kit-[a-z]+\.testkit\.ts$/;

/** A file `dir/part.test.ts` with the given source; returns its URL. */
function partFile(source: string): URL {
  const root = mkdtempSync(join(tmpdir(), 'module-imports-'));
  onTestFinished(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'dir'));
  writeFileSync(join(root, 'dir', 'part.test.ts'), source);
  return pathToFileURL(join(root, 'dir', 'part.test.ts'));
}

describe('runtimeImports', () => {
  it('lists named, side-effect, double-quoted, namespace and default imports', () => {
    const source = [
      `import { a } from './a.ts';`,
      `import './side-effect.ts';`,
      `import b from "./double.ts";`,
      `import * as c from './namespace.ts';`,
    ].join('\n');
    expect(runtimeImports(source)).toEqual(['./a.ts', './side-effect.ts', './double.ts', './namespace.ts']);
  });

  it('lists re-exports and literal dynamic imports', () => {
    const source = [
      `export { a } from './reexport.ts';`,
      `export * from './star.ts';`,
      `const later = () => import('./lazy.ts');`,
    ].join('\n');
    expect(runtimeImports(source)).toEqual(['./reexport.ts', './star.ts', './lazy.ts']);
  });

  it('leaves out type-only imports and exports', () => {
    const source = [
      `import type { A } from './type.ts';`,
      `import { type B } from './inline-type.ts';`,
      `export type { C } from './type-export.ts';`,
      `import { type D, e } from './mixed.ts';`,
      `import type F = require('./type-equals.ts');`,
      `import g = require('./equals.ts');`,
    ].join('\n');
    expect(runtimeImports(source)).toEqual(['./mixed.ts', './equals.ts']);
  });

  it('fails closed on a load whose target it cannot read', () => {
    expect(() => runtimeImports(`const name = './x.ts'; await import(name);`, 'dynamic.ts')).toThrow('dynamic.ts');
    expect(() => runtimeImports(`const x = require('./x.ts');`, 'require.ts')).toThrow('require.ts');
  });
});

describe('siblingImports', () => {
  it('resolves every relative form to the module it loads', () => {
    const file = partFile([
      `import { a } from './kit-own.testkit.ts';`,
      `import '././kit-registry.testkit.ts';`,
      `import "../dir/kit-other.testkit.ts";`,
      `import { b } from './unrelated.ts';`,
      `import { c } from '../elsewhere/kit-far.testkit.ts';`,
      `import { d } from 'some-package';`,
    ].join('\n'));
    expect(siblingImports(file, CELLS)).toEqual(['kit-own.testkit.ts', 'kit-registry.testkit.ts', 'kit-other.testkit.ts']);
  });

  it('fails closed on a load it cannot pin to one module', () => {
    expect(() => siblingImports(partFile(`import './kit-own.testkit.ts?raw';`), CELLS)).toThrow('query or a hash');
    expect(() => siblingImports(partFile(`import './kit-own.testkit.js';`), CELLS)).toThrow('another extension');
  });
});
