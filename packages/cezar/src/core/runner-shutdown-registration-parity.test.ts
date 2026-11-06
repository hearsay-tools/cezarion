import { registrationCollector, registrationCalls } from './split-registration.testkit.ts';
import { expect, it } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { SHUTDOWN_GROUPS, shutdownCells } from './runner-shutdown.testkit.ts';

it('registers every runner-shutdown row exactly once', () => {
  const names: string[] = [];
  const collect = registrationCollector(names);
  for (const rows of Object.values(SHUTDOWN_GROUPS)) for (const row of rows) shutdownCells[row.family](row.runner, collect);
  const actual = names.map(name => { const criterion = name.match(/^(\S+) (S\d+) /); return criterion ? `${criterion[1]}:${criterion[2]}` : name; });
  const expected = RUNNER_IDS.flatMap(runner => [
    ...['S22', 'S23', 'S24', 'S26', 'S27', 'S28', 'S30', 'S31', 'S33', 'S34'].map(row => `${runner}:${row}`),
    `${runner} an ignore-term stall exits through its own backstop without SIGKILL`,
    ...(runner === 'cursor' ? ['cursor input-closed stall exits nonzero and names its unsupported mock'] : []),
    `${runner} an ignore-term stall survives SIGTERM sent as soon as it publishes its pid`,
    ...(['claude', 'pi'].includes(runner) ? [`${runner} reaps a live child after stdout ends cleanly`] : []),
    ...(['claude', 'codex', 'pi'].includes(runner) ? [
      `${runner} keeps live EOF cleanup bounded with unavailable process evidence`,
      ...['unavailable', 'timeout'].map(evidence => `${runner} unknown automatic EOF cleanup fails but still reaps the live child (${evidence})`),
      ...['end', 'interrupt'].flatMap(intent => ['before EOF', 'during probe', 'after TERM'].map(when => `${runner} explicit ${intent} ${when} wins over unknown automatic cleanup`)),
      `${runner} interrupt during automatic cleanup keeps the earlier KILL deadline`,
    ] : []),
  ]);
  expect(actual.sort()).toEqual(expected.sort());
  const calls = registrationCalls(new URL('.', import.meta.url), 'runner-shutdown-', 'registerShutdownGroup');
  expect(calls.sort()).toEqual(Object.keys(SHUTDOWN_GROUPS).sort());
});
