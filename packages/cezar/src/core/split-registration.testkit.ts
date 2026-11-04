import { readFileSync, readdirSync } from 'node:fs';
import type { it } from 'vitest';
import { registrationStrings } from './registration-coverage.testkit.ts';

/** Collect registration names without executing native-process test bodies. */
export function registrationCollector(names: string[]): typeof it {
  return Object.assign((name: string) => { names.push(name); }, {
    skipIf: () => {
      return (name: string) => { names.push(name); };
    },
    each: (rows: readonly string[]) => (name: string) => {
      for (const row of rows) names.push(name.replace('%s', row));
    },
  }) as unknown as typeof it;
}

/** Read thin files too: a correct partition must be invoked once, not merely declared. */
export function registrationCalls(directory: URL, prefix: string, registration: string): string[] {
  return readdirSync(directory).filter(file => file.startsWith(prefix) && file.endsWith('.test.ts')
    && !file.endsWith('-registration.test.ts') && !file.endsWith('-registration-parity.test.ts'))
    .flatMap(file => registrationStrings(readFileSync(new URL(file, directory), 'utf8'), file, registration, `./${prefix.replace(/-$/, '')}.testkit.ts`));
}
