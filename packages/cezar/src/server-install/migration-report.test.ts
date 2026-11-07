import { describe, expect, it } from 'vitest';
import { applyMigrationReport } from './migration-report.ts';
import { STEP_STATUSES, freshServerState, type PlatformMigrationReport, type StepArtifact } from './types.ts';

const from: StepArtifact = { kind: 'owned', type: 'launchd', name: 'old', path: '/old' };
const to: StepArtifact = { ...from, name: 'new', path: '/new' };
const report: PlatformMigrationReport = { moved: [{ stepId: 'autostart', from, to }], leftAloneForeign: [], errors: [] };

describe('applyMigrationReport', () => {
  it('replaces the old artifact and keeps shared resources, status and input state', () => {
    const state = freshServerState();
    const shared: StepArtifact = { kind: 'shared', type: 'package', name: 'ngrok' };
    state.steps.autostart = { status: STEP_STATUSES[3], created: { artifacts: [shared, from] } };
    const original = structuredClone(state);
    const next = applyMigrationReport(state, report);
    expect(next.steps.autostart).toEqual({ status: STEP_STATUSES[3], created: { artifacts: [shared, to] } });
    expect(state).toEqual(original);
    expect(applyMigrationReport(next, report)).toEqual(next);
  });

  it('appends to created:null when the caller proved ownership from the launcher', () => {
    const state = freshServerState();
    state.steps.autostart = { status: STEP_STATUSES[1], created: null };
    expect(applyMigrationReport(state, report).steps.autostart).toEqual({ status: STEP_STATUSES[1], created: { artifacts: [to] } });
    expect(state.steps.autostart.created).toBeNull();
  });

  it('rejects unknown steps without mutating the input', () => {
    const state = freshServerState();
    expect(() => applyMigrationReport(state, report)).toThrow('Unknown migration step');
    expect(state.steps).toEqual({});
  });
});
