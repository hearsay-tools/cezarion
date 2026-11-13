import { describe, expect, it } from 'vitest';
import { exemptionReasonProblem } from './exemption-reason.testkit.ts';

describe('exemptionReasonProblem', () => {
  it.each([
    "Pi's RPC wire carries no tool approval request for Squawk to answer.",
    'Codex app-server sends an approval request only inside the turn it names, so none can arrive after that turn completed.',
    'The wire holds the turn open until every child returns, so no turn end parks on running children.',
  ])('accepts a wire limitation: %s', (reason) => {
    expect(exemptionReasonProblem(reason)).toBeUndefined();
  });

  it.each(['', '   '])('refuses an empty reason: "%s"', (reason) => {
    expect(exemptionReasonProblem(reason)).toBe('the reason is empty');
  });

  it.each([
    ['Not implemented yet.', 'Not implemented'],
    ['The cursor adapter is not yet implemented.', 'not yet implemented'],
    ['Unimplemented on this runner.', 'Unimplemented'],
    ['TODO: add the pi scenario.', 'TODO'],
    ['To-do after the next release.', 'To-do'],
    ['TBD', 'TBD'],
    ['The mock does not answer this scenario; we add it later.', 'later'],
    ['Skipped for now.', 'for now'],
    ['The runner does not yet send this frame.', 'yet'],
    ['Not supported yet.', 'yet'],
    ['The cockpit cannot read this fact from the wire yet.', 'yet'],
  ])('refuses a put-off reason: %s', (reason, wording) => {
    expect(exemptionReasonProblem(reason)).toBe(`"${wording}" says the work is put off; name what the wire cannot carry`);
  });
});
