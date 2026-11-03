import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { CI_FAILURE_GROUPS, ciFailureRowKey } from './ci-wait-failure-parity.testkit.ts';

it('registers every CI failure runner/outcome row exactly once', () => {
  const expected = RUNNER_IDS.flatMap(runner => { return [
    ...['fresh', 'continued'].map(mode => `${runner}:final:${mode}`),
    ...['passed', 'failed', 'restarted', 'source-retry'].map(outcome => `${runner}:nonfinal:${outcome}`),
    ...['CI acknowledgement', 'queued tail'].map(boundary => `${runner}:restart:${boundary}`),
  ]; });
  expect(Object.values(CI_FAILURE_GROUPS).flat().map(ciFailureRowKey).sort()).toEqual(expected.sort());
  const calls = readdirSync(new URL('.', import.meta.url)).filter(file => /^ci-wait-.*-parity\.test\.ts$/.test(file))
    .flatMap(file => { return [...readFileSync(new URL(file, import.meta.url), 'utf8').matchAll(/registerCiFailureGroup\('([^']+)'\)/g)].map(match => match[1]); });
  expect(calls.sort()).toEqual(Object.keys(CI_FAILURE_GROUPS).sort());
});
