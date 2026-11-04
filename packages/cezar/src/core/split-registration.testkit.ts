import { readFileSync, readdirSync } from 'node:fs';
import type { it } from 'vitest';

/** Collect registration names without executing native-process test bodies. */
export function registrationCollector(names: string[]): typeof it {
  return Object.assign((name: string) => { names.push(name); }, {
    skipIf: () => (name: string) => { names.push(name); },
    each: (rows: readonly string[]) => (name: string) => {
      for (const row of rows) names.push(name.replace('%s', row));
    },
  }) as unknown as typeof it;
}

/** Read thin files too: a correct partition must be invoked once, not merely declared. */
export function registrationCalls(directory: URL, prefix: string, registration: string): string[] {
  const pattern = new RegExp(`${registration}\\('([^']+)'\\)`, 'g');
  return readdirSync(directory).filter(file => file.startsWith(prefix) && file.endsWith('.test.ts'))
    .flatMap(file => [...readFileSync(new URL(file, directory), 'utf8').matchAll(pattern)].map(match => match[1]!));
}
