import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { blank } from './blank.ts';

/** The literal a dynamic `import(` at `start` names, or an error naming the call it cannot read. */
function dynamicSpecifier(source: string, start: number): string {
  const quote = source[start];
  const end = quote === "'" || quote === '"' || quote === '`' ? source.indexOf(quote, start + 1) : -1;
  const specifier = end < 0 ? undefined : source.slice(start + 1, end);
  // A literal is the whole argument: no `${…}` in a template, and nothing but `)` or the
  // options argument after it.
  if (specifier !== undefined && !specifier.includes('${') && /^\s*[),]/.test(source.slice(end + 1))) return specifier;
  const call = source.slice(source.lastIndexOf('import', start), source.indexOf(')', start) + 1);
  throw new Error(`a runtime import names no literal module, so its closure cannot be walked: ${call}`);
}

/**
 * Every module specifier `source` imports for its values; type-only imports are erased. A dynamic
 * `import()` whose specifier is not one literal throws: a closure pin that skipped it would fail
 * open.
 */
export function runtimeImports(source: string): string[] {
  const code = blank(source);
  const found: string[] = [];
  // `blank` empties strings and comments, so a match is code; the specifier is read from the source.
  for (const match of code.matchAll(/\b(?:import|export)\s+(type\s+)?(?:[^'"`;]*?\bfrom\s*)?(['"])|\bimport\s*\(\s*/g)) {
    if (match[1]) continue;
    const start = match.index + match[0].length;
    if (match[2]) found.push(source.slice(start, source.indexOf(source[start - 1]!, start)));
    else found.push(dynamicSpecifier(source, start));
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
