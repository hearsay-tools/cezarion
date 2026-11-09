import { readFileSync, readdirSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { runsOn, type ParityFamilyName } from '../core/parity-classes.testkit.ts';
import { registrationGroups } from '../core/registration-coverage.testkit.ts';
import { describeSessionContext, SESSION_CONTEXT_GROUPS } from './session-context-cells.testkit.ts';
import { useWorkerWaitFixture } from './worker-wait.testkit.ts';

/** Collect the real cell definitions without running fixtures or native processes. */
function collectionSuite(names: string[]) {
  return {
    describe: ((_name: string, ...args: unknown[]) => (args.at(-1) as () => void)()) as typeof describe,
    it: ((name: string) => { names.push(name); }) as typeof it,
    afterEach: (() => {}) as typeof afterEach,
    useWorkerWaitFixture: (() => {}) as typeof useWorkerWaitFixture,
  };
}

function registeredGroups(callee: string, catalog: string, known: string[]): string[] {
  const guard = 'context-completion-registration-parity.test.ts';
  return readdirSync(new URL('.', import.meta.url))
    .filter(file => file.endsWith('.ts') && file !== guard)
    .flatMap(file => registrationGroups(readFileSync(new URL(file, import.meta.url), 'utf8'), file, callee, catalog, known));
}

function expectCells(names: string[], rows: string[], family: ParityFamilyName) {
  const actual = names.map(name => name.split(' ').slice(0, 2).join(' ')).sort();
  const expected = RUNNER_IDS.flatMap(runner => rows.filter(row => runsOn(family, row, runner)).map(row => `${runner} ${row}`)).sort();
  expect(actual).toEqual(expected);
}

describe('session-context family registration', () => {
  it('registers every session-context runner and row exactly once', () => {
    const known = Object.keys(SESSION_CONTEXT_GROUPS) as Array<keyof typeof SESSION_CONTEXT_GROUPS>;
    const registered = registeredGroups('describeSessionContext', 'SESSION_CONTEXT_GROUPS', known);
    expect(registered.sort()).toEqual([...known].sort());
    const names: string[] = [];
    for (const group of registered) describeSessionContext(SESSION_CONTEXT_GROUPS[group as keyof typeof SESSION_CONTEXT_GROUPS], collectionSuite(names));
    expectCells(names, ['R120', 'R121', 'R122', 'R123', 'R124'], 'session-context');
  });
});
