import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { parityRunners } from '../core/parity-classes.testkit.ts';
import { CI_FAILURE_GROUPS, ciFailureRowKey } from './ci-wait-failure-parity.testkit.ts';

it('registers every CI failure runner/outcome row exactly once', () => {
  const runnersOf = (row: string, keys: readonly string[]) => parityRunners('ci-wait-failure', row).flatMap(runner => keys.map(key => `${runner}:${key}`));
  const expected = [
    ...runnersOf('R72', ['final:fresh']), ...runnersOf('R73', ['final:continued']),
    ...runnersOf('R74', ['passed', 'failed', 'restarted'].map(outcome => `nonfinal:${outcome}`)), ...runnersOf('R76', ['nonfinal:source-retry']),
    ...runnersOf('R75', ['CI acknowledgement', 'queued tail'].map(boundary => `restart:${boundary}`)),
  ];
  expect(Object.values(CI_FAILURE_GROUPS).flat().map(ciFailureRowKey).sort()).toEqual(expected.sort());
  const calls = readdirSync(new URL('.', import.meta.url)).filter(file => /^ci-wait-.*-parity\.test\.ts$/.test(file))
    .flatMap(file => { return [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/registerCiFailureGroup\('([^']+)'\)/g)].map(match => match[1]); });
  expect(calls.sort()).toEqual(Object.keys(CI_FAILURE_GROUPS).sort());
});
