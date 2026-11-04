import { registrationCollector, registrationCalls } from '../core/split-registration.testkit.ts';
import { expect, it } from 'vitest';
import { RUNNER_IDS } from '../core/agent-runner.ts';
import { RESUME_DIAGNOSTICS_GROUPS, resumeDiagnosticsCells } from './resume-diagnostics.testkit.ts';

it('registers every resume-diagnostics row exactly once', () => {
  const names: string[] = [];
  const collect = registrationCollector(names);
  for (const rows of Object.values(RESUME_DIAGNOSTICS_GROUPS)) for (const row of rows) resumeDiagnosticsCells[row.family](row.runner, collect);
  const actual = names.map(name => { const match = name.match(/^(\S+) (R\d+)(?: .*saved (running|queued) continuation)?/)!; return `${match[1]}:${match[2]}${match[3] ? ':' + match[3] : ''}`; });
  const expected = RUNNER_IDS.flatMap(runner => ['R85', 'R87', 'R88', 'R89', 'R90', 'R91', 'R86:running', 'R86:queued'].map(row => `${runner}:${row}`));
  expect(actual.sort()).toEqual(expected.sort());
  const calls = registrationCalls(new URL('.', import.meta.url), 'resume-diagnostics-', 'registerResumeDiagnosticsGroup');
  expect(calls.sort()).toEqual(Object.keys(RESUME_DIAGNOSTICS_GROUPS).sort());
});
