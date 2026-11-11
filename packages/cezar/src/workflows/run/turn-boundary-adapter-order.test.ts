import { seedWaits } from '../../runs/run-store.testkit.ts';
import type { RunLine } from './run-line.ts';
import { afterEach, expect, it, vi } from 'vitest';
import { makeHumanWait, makeTimerWait, WAIT_SOURCE } from '@open-mercato/cezar-contract/test-factories.testkit';
import { unused } from '../fixture-no-runner.testkit.ts';
import { boundaryOrderFixture } from './boundary-order.testkit.ts';
import { MemoryGuard } from './memory-guard.ts';
import { SubagentWaits } from './subagent-waits.ts';
import { WakeAdmission } from './wake-admission.ts';
import { RunFinish } from './run-finish.ts';
import { handlePermissionResolved } from './session-events.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';
import * as completion from './completion-gate.ts';

afterEach(() => vi.restoreAllMocks());

it('memory pause writes cause and lifecycle before disabling autonomy and closing the session', async () => {
  const f = boundaryOrderFixture(true);
  const guard = new MemoryGuard(f.context, { active: f.active });
  await guard.enforceMemoryLimit({ [f.run.id]: { cpuPct: 0, rssBytes: 2 * 1024 * 1024, procCount: 1 } });
  expect(f.log).toEqual(['event:note', 'event:lifecycle', 'boundary:mode-disabled/disable', 'end']);
  expect(f.state.boundary.autonomous).toBe(false);
});

it('last native child clears its held park before the release adapter runs', () => {
  const f = boundaryOrderFixture();
  const subagents = new SubagentWaits(f.context, unused<ConstructorParameters<typeof SubagentWaits>[1]>('subagent host', {
    active: f.active, isParked: () => true,
    releaseHeldPark: () => { f.log.push('release-held'); expect(f.state.boundary.heldForSubagents).toBeUndefined(); },
  }));
  transitionTurnBoundary(f.state, { kind: 'wait-wake-admitted', phase: 'hold-children', session: f.wire, held: true });
  f.log.length = 0;
  subagents.trackEvent(f.run.id, f.state, { type: 'item.completed', item: { kind: 'tool', id: 'child', name: 'Task', title: 'Task', toolKind: 'other', status: 'completed', background: true } });
  expect(f.log).toEqual(['boundary:subagents-changed/release', 'release-held']);
});

it('wait park records the child hold before durable park then pool admission wake and release', () => {
  const f = boundaryOrderFixture();
  seedWaits(f.store, f.run.id, { waits: [makeTimerWait()] });
  type Host = ConstructorParameters<typeof WakeAdmission>[1];
  const admission = new WakeAdmission(f.context, unused<Host>('wake host', {
    line: f.line, move: (...args) => { f.log.push('move'); return f.store.move(...args); },
    queueWaitWake: () => f.log.push('wake'), releaseSlot: () => f.log.push('release'),
  }), 40, 3);
  expect(admission.parkOnWaits(f.run.id, f.state)).toBe(true);
  expect(f.log).toEqual(['boundary:wait-wake-admitted/hold-children', 'move', 'line-park', 'join', 'wake', 'release']);
});

it('an existing human question refreshes its fact before surfacing and routing the alias', () => {
  const f = boundaryOrderFixture();
  f.store.appendEvent(f.run.id, { type: 'ask.requested', requestId: 'question', questions: [{ header: 'Choice', question: 'Next?' }] });
  const wait = makeHumanWait({ source: WAIT_SOURCE.agent, askSeq: undefined }); seedWaits(f.store, f.run.id, { waits: [wait] });
  const mark = f.humanWaits.markHumanWaitSurfaced.bind(f.humanWaits);
  vi.spyOn(f.humanWaits, 'markHumanWaitSurfaced').mockImplementation((...args) => { f.log.push('surface'); mark(...args); });
  f.log.length = 0; f.humanWaits.surfaceHumanWait(f.run.id, f.state, wait);
  expect(f.log).toEqual(['boundary:human-wait-opened/refresh-question', 'surface', 'route']);
  expect(f.state.boundary.pendingHumanAsk).toBe(true);
});

it('permission resolution commits the flag before refreshing the question then resumes and flushes', () => {
  const f = boundaryOrderFixture();
  const update = f.store.updateRun.bind(f.store);
  vi.spyOn(f.store, 'updateRun').mockImplementation((...args) => { f.log.push('permission-commit'); return update(...args); });
  handlePermissionResolved(f.context, unused<import('./session-events.ts').SessionHelperHost>('permission host', {
    resumeParkedRun: () => { f.log.push('resume'); expect(f.state.boundary.pendingHumanAsk).toBe(false); },
    flushAgentInputs: () => { f.log.push('input-flush'); return false; },
  }), f.run.id, f.state, new Set());
  expect(f.log).toEqual(['permission-commit', 'boundary:human-wait-opened/refresh-question', 'resume', 'input-flush']);
});

function finishFixture() {
  const f = boundaryOrderFixture();
  f.state.liveSession.beginCiGeneration('generation');
  type Args = ConstructorParameters<typeof RunFinish>;
  const finish = new RunFinish(f.context, unused<Args[1]>('done gate', { active: f.active }),
    unused<Args[2]>('settlement'), f.settler, unused<Args[4]>('nudges'), f.line,
    unused<Args[6]>('done host', { executionBlockedByRootFinish: () => { f.log.push('root-gate'); return false; },
      hasUnansweredHumanAsk: () => { f.log.push('question-gate'); return false; } }));
  vi.spyOn(completion, 'completionRefusal').mockImplementation(() => { f.log.push('completion-gate'); return undefined; });
  return { ...f, finish };
}
it('done admission keeps gates before boundary request and preserves its synchronous return', () => {
  const f = finishFixture();
  expect(f.finish.acceptDone(f.run.id, 'generation', { summary: 'Complete' })).toMatchObject({ ok: true, completes: 'task' });
  expect(f.log).toEqual(['root-gate', 'question-gate', 'completion-gate', 'boundary:done-request/request']);
  expect(f.state.boundary.doneRequested).toEqual({ session: f.wire, summary: 'Complete' });
});
it('stale done stops before gates and a pending question stops before completion refusal', () => {
  const f = finishFixture();
  expect(f.finish.acceptDone(f.run.id, 'stale', {})).toMatchObject({ ok: false, code: 'generation_mismatch' });
  expect(f.log).toEqual([]);
  transitionTurnBoundary(f.state, { kind: 'human-wait-opened', phase: 'prepare', session: f.wire });
  f.log.length = 0;
  expect(f.finish.acceptDone(f.run.id, 'generation', {})).toMatchObject({ ok: false, code: 'human_question_pending' });
  expect(f.log).toEqual(['root-gate']); expect(f.state.boundary.doneRequested).toBeUndefined();
});


it.each([true, false])('empty wake retirement parks only at a turn boundary (%s)', atBoundary => {
  const f = boundaryOrderFixture();
  f.store.move(f.run.id, 'park');
  if (atBoundary) transitionTurnBoundary(f.state, { kind: 'turn-end', phase: 'ui-completed', session: f.wire });
  type Host = ConstructorParameters<typeof WakeAdmission>[1];
  const admission = new WakeAdmission(f.context, unused<Host>('retirement host', {
    active: f.active,
    line: unused<RunLine>('retirement line', {
      removeWake: () => { f.log.push('remove'); return true; },
      retireAdmission: () => { f.log.push('retire'); return true; },
      park: () => { f.log.push('park'); },
    }),
    retries: unused<Host['retries']>('retirement retries', { stopRetry: () => { f.log.push('stop-retry'); } }),
  }), 40, 3);
  vi.spyOn(admission, 'owesWake').mockReturnValue(true);
  f.log.length = 0;
  admission.retireEmptyWake(f.run.id);
  expect(f.log).toEqual([]);
  vi.mocked(admission.owesWake).mockReturnValue(false);
  admission.retireEmptyWake(f.run.id);
  expect(f.log).toEqual(atBoundary ? ['remove', 'retire', 'park', 'stop-retry'] : ['remove', 'retire', 'stop-retry']);
});
