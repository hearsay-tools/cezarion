import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS, type RunnerId } from './agent-runner.ts';
import { runsOn, type ParityFamilyName } from './parity-classes.testkit.ts';
import { registrationStrings } from './registration-coverage.testkit.ts';

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

/** Whether a `<runner> <row> …` cell runs on its runner under the family's class (hearsay-tools/cezarion#2991). */
function familyRuns(family: ParityFamilyName | undefined, name: string): boolean {
  const pair = /^(\w+) ([A-Z]\d+)\b/.exec(name);
  if (!family || !pair || !(RUNNER_IDS as readonly string[]).includes(pair[1]!)) return true;
  return runsOn(family, pair[2], pair[1] as RunnerId);
}

/** Collect before opening a suite: a part must not register empty describes. A `family` drops each
 *  cell whose row does not run on its runner, before the part is chosen. */
export function partitionParity(part: ParityPart, parts: Readonly<Record<string, readonly string[]>>, collect?: ParityCollector, family?: ParityFamilyName) {
  let cells: Cell[] = [];
  return {
    it(name: string, body: () => void | Promise<void>, timeout?: number): void {
      if (!familyRuns(family, name)) return;
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
  directory = new URL('.', import.meta.url),
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
  const entries = readdirSync(directory).filter(file => file.endsWith('.test.ts') && !file.endsWith('-registration-parity.test.ts'))
    .map(file => {
      const source = readFileSync(new URL(file, directory), 'utf8');
      let imported = false;
      const calls = registrationStrings(source, file, register.name, `./${family}.testkit.ts`, () => { imported = true; });
      return { file, source, calls, imported };
    })
    .filter(entry => entry.imported || entry.calls.length > 0);
  expect(entries.length, family).toBeGreaterThan(1);
  for (const { file, source, calls } of entries) {
    expect(calls, file).toHaveLength(1);
    const names: string[] = [];
    register(calls[0]!, name => names.push(name));
    if (!names.length) throw new Error(`${file}: empty ${register.name} registration: ${source}`);
    actual.push(...names);
  }
  expect(new Set(expected).size).toBe(expected.length);
  expect(actual.sort()).toEqual(expected.sort());
}
