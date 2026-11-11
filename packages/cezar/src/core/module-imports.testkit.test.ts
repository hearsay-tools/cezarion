import { describe, expect, it } from 'vitest';
import { runtimeImports } from './module-imports.testkit.ts';

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
