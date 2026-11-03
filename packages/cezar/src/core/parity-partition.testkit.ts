import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

type Cell = { name: string; body: () => void | Promise<void>; timeout: number | undefined };
export type ParityPart = string;
export type ParityCollector = (name: string) => void;

/** Stable cell identity, including the autonomous constructor variants. */
export function parityCellKey(name: string): string {
  const pair = /^(\w+) ([A-Z]\d+)\b/.exec(name);
  if (!pair) return name;
  const mode = /\((fresh|continuation)\)$/.exec(name);
  return `${pair[1]} ${pair[2]}${mode ? ` ${mode[1]}` : ''}`;
}

/** Collect before opening a suite: a part must not register empty describes. */
export function partitionParity(part: ParityPart, parts: Readonly<Record<string, readonly string[]>>, collect?: ParityCollector) {
  let cells: Cell[] = [];
  return {
    it(name: string, body: () => void | Promise<void>, timeout?: number): void {
      if (part === 'all' || parts[part]?.includes(parityCellKey(name))) cells.push({ name, body, timeout });
    },
    describe(name: string, body: () => void): void {
      cells = [];
      body();
      const selected = cells;
      if (collect) selected.forEach(cell => collect(cell.name));
      else if (selected.length) describe(name, () => {
        for (const cell of selected) it(cell.name, cell.body, cell.timeout);
      });
    },
  };
}

/** Read the actual entrypoints, then compare their registrations with the unsplit suite. */
export function checkParityRegistration(
  family: string,
  register: (part: ParityPart, collect?: ParityCollector) => void,
  pairs: readonly string[],
  count: number,
): void {
  const expected: string[] = [];
  register('all', name => expected.push(name));
  expect(expected).toHaveLength(count);
  const registeredPairs = expected.flatMap(name => {
    const pair = /^(\w+) ([A-Z]\d+)\b/.exec(name);
    return pair ? [`${pair[1]} ${pair[2]}`] : [];
  });
  expect([...new Set(registeredPairs)].sort()).toEqual([...pairs].sort());
  const actual: string[] = [];
  const entryImport = `import { ${register.name} } from './${family}.testkit.ts';`;
  const files = readdirSync(new URL('.', import.meta.url)).filter(file =>
    file.endsWith('.test.ts') && !file.endsWith('-registration.test.ts') &&
    readFileSync(new URL(file, import.meta.url), 'utf8').includes(entryImport));
  expect(files.length).toBeGreaterThan(1);
  for (const file of files) {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    expect(source, file).toContain(`import { ${register.name} } from './${family}.testkit.ts';`);
    const calls = [...source.matchAll(/^(describe\w+Parity)\('([^']+)'\);$/gm)];
    expect(calls, file).toHaveLength(1);
    expect(calls[0]![1], file).toBe(register.name);
    register(calls[0]![2]!, name => actual.push(name));
  }
  expect(new Set(expected).size).toBe(expected.length);
  expect(actual.sort()).toEqual(expected.sort());
}
