import { readFileSync, readdirSync } from 'node:fs';
import { expect } from 'vitest';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';

/** Check the row partition and the thin files that register it independently. */
export function expectWaitRowCoverage(groups: Record<string, readonly RunnerId[]>, families: readonly string[], prefix: string, helper: string) {
  const expected = RUNNER_IDS.flatMap(runner => families.map(family => `${runner}:${family}`));
  expect(Object.entries(groups).flatMap(([family, runners]) => runners.map(runner => `${runner}:${family}`)).sort()).toEqual(expected.sort());
  const calls = readdirSync(new URL('.', import.meta.url)).filter(file => file.startsWith(prefix) && file.endsWith('-parity.test.ts'))
    .map(file => readFileSync(new URL(file, import.meta.url), 'utf8'))
    .filter(source => source.includes(`from './${helper}'`))
    .flatMap(source => [...source.matchAll(/registerGroup\('([^']+)'\)/g)].map(match => match[1]));
  expect(calls.sort()).toEqual(Object.keys(groups).sort());
}
