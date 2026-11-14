import { readFileSync, readdirSync } from 'node:fs';
import { expect, it } from 'vitest';
import { MONITORING_PARTITIONS, expectedMonitoringCells, monitoringCells, monitoringTurnFiles } from './monitoring-turn-partitions.testkit.ts';

it('registers every monitoring runner/mode/criterion exactly once across semantic files', () => {
  const files = readdirSync(new URL('.', import.meta.url)).filter(file => /^monitoring-turn-.*\.test\.ts$/.test(file) && file !== 'monitoring-turn-coverage.test.ts');
  expect(files.sort()).toEqual([...monitoringTurnFiles].sort());
  const registrations = monitoringTurnFiles.flatMap(file => {
    const source = readFileSync(new URL(file, import.meta.url), 'utf8');
    return [...source.matchAll(/registerMonitoringPartition\('([^']+)'\)/g)].map(match => match[1]!);
  });
  expect([...registrations].sort()).toEqual(Object.keys(MONITORING_PARTITIONS).sort());
  const cells = monitoringCells(registrations.map(name => MONITORING_PARTITIONS[name as keyof typeof MONITORING_PARTITIONS]));
  expect([...cells].sort()).toEqual([...expectedMonitoringCells].sort());
  expect(cells).toHaveLength(21);
});
