import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importClosure, relativeImports } from '../lint/import-closure.testkit.ts';
import { HELPER_MODULES } from './launcher.ts';

/**
 * The launcher copies the restart helper out of the package npm is about to replace, so the copy
 * runs only with the modules `HELPER_MODULES` names (hearsay-tools/cezarion#1815). A module the
 * helper starts to import, and the list misses, fails only when an update runs: this test reads
 * the helper's relative imports, and theirs, and compares them with the list.
 */
const here = import.meta.dirname;

/** Every module `entry` loads through relative value imports, as paths from this directory in `dist`. */
function helperClosure(entry: string): string[] {
  return importClosure(join(here, entry)).map(path => relative(here, path).replace(/\.ts$/, '.js')).sort();
}

describe('the restart helper copy', () => {
  it('copies every module the helper imports, and nothing else', () => {
    expect([...HELPER_MODULES].sort()).toEqual(helperClosure('helper.ts'));
  });

  it('reads value imports and leaves type-only ones out', () => {
    const source = [
      "import { a } from './a.js';",
      "import type { B } from './b.js';",
      "export { c } from '../c.js';",
      "export type { D } from './d.js';",
      "import './side-effect.js';",
      "const e = await import('./e.js');",
      "import { f } from 'node:fs';",
      "// import { g } from './g.js';",
    ].join('\n');
    expect(relativeImports(source)).toEqual(['./a.js', '../c.js', './side-effect.js', './e.js']);
  });
});
