import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { HARNESS_PARITY_GROUPS } from './harness-parity-cells.testkit.ts';
import {
  NO_SESSION_RUNNER, PARITY_FAMILIES, PARITY_FILES, SHARED_RUNNERS, deriveRunnerSet, parityRowId, parityRunners, turnPathValues,
  type ParityFamilyName,
} from './parity-classes.testkit.ts';
import { RUNNER_FACTS, type RunnerFacts } from './runner-facts.ts';
import { COMBINATION_ROWS } from '../lint/runner-fact-combination.ts';

const src = join(import.meta.dirname, '..');
const facts = (overrides: Partial<RunnerFacts['inputDelivery']> & { systemPromptOnResume?: RunnerFacts['systemPromptOnResume'] } = {}): RunnerFacts => {
  const { systemPromptOnResume = 'resent', ...delivery } = overrides;
  return {
    ...RUNNER_FACTS.codex, systemPromptOnResume,
    inputDelivery: { ...RUNNER_FACTS.codex.inputDelivery, ...delivery } as RunnerFacts['inputDelivery'],
  };
};

describe('the shared parity runner set (hearsay-tools/cezarion#2991)', () => {
  // Guard 1: a value no member shows fails here, and deriveRunnerSet then picks a runner that has it.
  it('shows every declared value of every turn-path fact', () => {
    const declared = turnPathValues(RUNNER_IDS, RUNNER_FACTS);
    const shown = turnPathValues(SHARED_RUNNERS, RUNNER_FACTS);
    for (const [fact, values] of Object.entries(declared)) expect([...shown[fact]!].sort(), fact).toEqual([...values].sort());
  });

  it('is the smallest such set, in RUNNER_IDS order, and the no-session runner is its first', () => {
    const declared = turnPathValues(RUNNER_IDS, RUNNER_FACTS);
    const subsets = (size: number, from = 0): string[][] => size === 0 ? [[]]
      : RUNNER_IDS.slice(from).flatMap((id, at) => subsets(size - 1, from + at + 1).map(rest => [id, ...rest]));
    for (let size = 1; size < SHARED_RUNNERS.length; size++) {
      for (const set of subsets(size)) {
        const shown = turnPathValues(set as typeof RUNNER_IDS[number][], RUNNER_FACTS);
        expect(Object.entries(declared).every(([fact, values]) => [...values].every(value => shown[fact]!.has(value))), set.join(',')).toBe(false);
      }
    }
    expect(SHARED_RUNNERS).toEqual(RUNNER_IDS.filter(id => SHARED_RUNNERS.includes(id)));
    expect(NO_SESSION_RUNNER).toBe(SHARED_RUNNERS[0]);
  });

  it('takes in a runner that declares a new value, and breaks ties by order', () => {
    const table = { a: facts(), b: facts({ humanInputAtTurnEnd: 'never-held' }), c: facts({ systemPromptOnResume: 'in-thread' }) };
    expect(deriveRunnerSet(['a', 'b', 'c'], table)).toEqual(['b', 'c']);
    const grown = { ...table, d: facts({ mode: 'boundary', humanInputAtTurnEnd: 'always-held', acknowledgement: 'model-work' }) };
    expect(deriveRunnerSet(['a', 'b', 'c', 'd'], grown)).toEqual(['b', 'c', 'd']);
    const tie = { a: facts({ consumption: 'unobservable' }), b: facts({ consumption: 'unobservable' }), c: facts() };
    expect(deriveRunnerSet(['a', 'b', 'c'], tie)).toEqual(['a', 'c']);
  });
});

describe('the parity classification table (hearsay-tools/cezarion#2991)', () => {
  const parityFiles = ['core', 'workflows', 'server'].flatMap(dir => readdirSync(join(src, dir))
    // A parity test file: `<family>-parity.test.ts`, a server `contract-parity.<area>.test.ts`, the harness closure
    // guard and the monitoring-turn files. A testkit's own unit test is not one.
    .filter(file => /-parity(?:\.[a-z]+|-closure)?\.test\.ts$/.test(file) && !file.endsWith('.testkit.test.ts')
      || (dir === 'workflows' && /^monitoring-turn-.*\.test\.ts$/.test(file)))
    .map(file => `${dir}/${file}`));

  // Guard 3: each family has one class (one table entry), and every parity test file belongs to one.
  it('places every parity test file in exactly one file pattern, and every family has a file', () => {
    expect(parityFiles.length).toBeGreaterThan(100);
    const unplaced = parityFiles.filter(file => PARITY_FILES.filter(([pattern]) => pattern.test(file)).length !== 1);
    expect(unplaced).toEqual([]);
    const placed = new Set(PARITY_FILES.filter(([pattern]) => parityFiles.some(file => pattern.test(file))).flatMap(([, families]) => families));
    expect(Object.keys(PARITY_FAMILIES).filter(family => !placed.has(family as ParityFamilyName))).toEqual([]);
  });

  it('names one family for each harness group', () => {
    const groups = Object.values(HARNESS_PARITY_GROUPS).flat();
    expect(Object.keys(PARITY_FAMILIES).filter(family => family.startsWith('harness:')).sort()).toEqual(groups.map(group => `harness:${group}`).sort());
  });

  it('lists every-runner rows only in shared families, each with a reason', () => {
    for (const [family, entry] of Object.entries(PARITY_FAMILIES) as Array<[string, { class: string; everyRunner?: Record<string, string> }]>) {
      if (entry.class !== 'shared') expect(entry.everyRunner, family).toBeUndefined();
      for (const [row, why] of Object.entries(entry.everyRunner ?? {})) {
        expect(parityRowId(`runner ${row} …`), `${family} ${row}`).toBe(row);
        expect(why.length, `${family} ${row}`).toBeGreaterThan(10);
      }
    }
  });

  it('runs the per-runner smoke rows R1 and U1 on every runner', () => {
    expect(parityRunners('harness:run', 'R1')).toEqual(RUNNER_IDS);
    expect(parityRunners('waits', 'U1')).toEqual(RUNNER_IDS);
  });

  it('runs a row any runner is exempt from, and a cell with no row id, on every runner', () => {
    expect(parityRunners('waits', 'U27')).toEqual(RUNNER_IDS);
    expect(parityRunners('workflow-autonomous', 'A9')).toEqual(RUNNER_IDS);
    expect(parityRunners('waits', undefined)).toEqual(RUNNER_IDS);
    expect(parityRunners('waits', 'U2')).toEqual(SHARED_RUNNERS);
    expect(parityRunners('server-contract', 'R1')).toEqual([NO_SESSION_RUNNER]);
  });

  // cez/runner-fact-combination lets a function combine two facts only beside a row on every runner.
  it('names, for each allowed fact combination, a row that runs on every runner', () => {
    for (const [site, row] of Object.entries(COMBINATION_ROWS)) {
      const [family, id] = row.split(' ') as [ParityFamilyName, string];
      expect(PARITY_FAMILIES[family], site).toBeDefined();
      expect(parityRunners(family, id), site).toEqual(RUNNER_IDS);
    }
  });
});
