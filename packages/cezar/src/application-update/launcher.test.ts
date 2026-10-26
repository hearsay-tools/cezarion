import { readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { blank } from '../test-wait-discipline.testkit.ts';
import { HELPER_MODULES } from './launcher.ts';

/**
 * The launcher copies the restart helper out of the package npm is about to replace, so the copy
 * runs only with the modules `HELPER_MODULES` names (hearsay-tools/cezarion#1815). A module the
 * helper starts to import, and the list misses, fails only when an update runs: this test reads
 * the helper's relative imports, and theirs, and compares them with the list.
 */
const here = import.meta.dirname;

/** The relative modules `source` imports for their values; type-only imports are erased. */
function relativeImports(source: string): string[] {
  const code = blank(source);
  const found: string[] = [];
  // `blank` empties strings and comments, so a match is code; the specifier is read from the source.
  for (const match of code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\bfrom\s*)?(['"])|\bimport\s*\(\s*(['"])/g)) {
    if (match[1]) continue;
    const start = match.index + match[0].length;
    const specifier = source.slice(start, source.indexOf(source[start - 1]!, start));
    if (specifier.startsWith('./') || specifier.startsWith('../')) found.push(specifier);
  }
  return found;
}

/** Every module `entry` loads through relative imports, as paths from this directory in `dist`. */
function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    const built = relative(here, path).replace(/\.ts$/, '.js');
    if (seen.has(built)) return;
    seen.add(built);
    for (const specifier of relativeImports(readFileSync(path, 'utf8'))) {
      visit(join(dirname(path), specifier).replace(/\.js$/, '.ts'));
    }
  };
  visit(join(here, entry));
  return [...seen].sort();
}

describe('the restart helper copy', () => {
  it('copies every module the helper imports, and nothing else', () => {
    expect([...HELPER_MODULES].sort()).toEqual(importClosure('helper.ts'));
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
