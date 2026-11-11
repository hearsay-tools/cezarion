import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blank } from './blank.ts';

/** Every module specifier `source` imports for its values; type-only imports are erased. */
export function runtimeImports(source: string): string[] {
  const code = blank(source);
  const found: string[] = [];
  // `blank` empties strings and comments, so a match is code; the specifier is read from the source.
  for (const match of code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\bfrom\s*)?(['"])|\bimport\s*\(\s*(['"])/g)) {
    if (match[1]) continue;
    const start = match.index + match[0].length;
    found.push(source.slice(start, source.indexOf(source[start - 1]!, start)));
  }
  return found;
}

/** The relative modules `source` imports for their values; type-only imports are erased. */
export function relativeImports(source: string): string[] {
  return runtimeImports(source).filter(specifier => specifier.startsWith('./') || specifier.startsWith('../'));
}

/** Every module `entry` (an absolute `.ts` path) loads at runtime through relative imports, as absolute paths. */
export function importClosure(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (path: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    for (const specifier of relativeImports(readFileSync(path, 'utf8'))) {
      visit(join(dirname(path), specifier).replace(/\.js$/, '.ts'));
    }
  };
  visit(entry);
  return [...seen].sort();
}
