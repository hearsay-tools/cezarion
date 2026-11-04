import { readFileSync, readdirSync } from 'node:fs';
import type { it } from 'vitest';
import { parse } from '@babel/parser';

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
  return readdirSync(directory).filter(file => file.startsWith(prefix) && file.endsWith('.test.ts'))
    .flatMap(file => {
      const { program } = parse(readFileSync(new URL(file, directory), 'utf8'), { sourceType: 'module', plugins: ['typescript'] });
      return program.body.flatMap(statement => {
        if (statement.type !== 'ExpressionStatement' || statement.expression.type !== 'CallExpression') return [];
        const call = statement.expression;
        if (call.callee.type !== 'Identifier' || call.callee.name !== registration) return [];
        const argument = call.arguments[0];
        return argument?.type === 'StringLiteral' ? [argument.value] : [];
      });
    });
}
