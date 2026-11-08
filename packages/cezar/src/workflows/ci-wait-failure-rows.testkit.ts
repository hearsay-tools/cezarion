import type { RunnerId } from '../core/agent-runner.ts';
import { parityRunners } from '../core/parity-classes.testkit.ts';

/** The CI failure parity rows (hearsay-tools/cezarion#994): which runner and case each file group
 *  registers. Apart from the cells, so a guard can read it without the cells' module mocks. */
export type CiFailureRow =
  | { family: 'final'; runner: RunnerId; mode: 'fresh' | 'continued' }
  | { family: 'nonfinal'; runner: RunnerId; outcome: 'passed' | 'failed' | 'restarted' | 'source-retry' }
  | { family: 'restart'; runner: RunnerId; boundary: 'CI acknowledgement' | 'queued tail' };
function finalRow(mode: 'fresh' | 'continued'): string { return mode === 'fresh' ? 'R72' : 'R73'; }
function nonfinalRow(outcome: 'passed' | 'failed' | 'restarted' | 'source-retry'): string { return outcome === 'source-retry' ? 'R76' : 'R74'; }
const restartRows = (boundary: 'CI acknowledgement' | 'queued tail') =>
  parityRunners('ci-wait-failure', 'R75').map(runner => ({ family: 'restart', runner, boundary } as const));
export const CI_FAILURE_GROUPS = {
  'final-recovery': (['fresh', 'continued'] as const).flatMap(mode => parityRunners('ci-wait-failure', finalRow(mode)).map(runner => ({ family: 'final', runner, mode } as const))),
  'nonfinal-passed': parityRunners('ci-wait-failure', nonfinalRow('passed')).map(runner => ({ family: 'nonfinal', runner, outcome: 'passed' } as const)),
  'nonfinal-failed': parityRunners('ci-wait-failure', nonfinalRow('failed')).map(runner => ({ family: 'nonfinal', runner, outcome: 'failed' } as const)),
  'nonfinal-restarted': parityRunners('ci-wait-failure', nonfinalRow('restarted')).map(runner => ({ family: 'nonfinal', runner, outcome: 'restarted' } as const)),
  'nonfinal-source-retry': parityRunners('ci-wait-failure', nonfinalRow('source-retry')).map(runner => ({ family: 'nonfinal', runner, outcome: 'source-retry' } as const)),
  'restart-acknowledgement': restartRows('CI acknowledgement'),
  'restart-queued-tail': restartRows('queued tail'),
};
export type CiFailureGroup = keyof typeof CI_FAILURE_GROUPS;
/** The parity row id a CI failure cell registers. */
export function ciFailureRowId(row: CiFailureRow): string {
  return row.family === 'final' ? finalRow(row.mode) : row.family === 'nonfinal' ? nonfinalRow(row.outcome) : 'R75';
}
export function ciFailureRowKey(row: CiFailureRow): string {
  return [row.runner, row.family, row.family === 'final' ? row.mode : row.family === 'nonfinal' ? row.outcome : row.boundary].join(':');
}
