import { afterEach, expect, it, vi } from 'vitest';
import { observationClock } from '../../core/observation-clock.testkit.ts';
import { unused } from '../fixture-no-runner.testkit.ts';
import { boundaryOrderFixture } from './boundary-order.testkit.ts';
import { clearIdleTimer } from './input-timers.ts';
import { TurnNudges } from './turn-nudges.ts';
import * as completion from './completion-gate.ts';
import { transitionTurnBoundary } from './turn-boundary.ts';

function fixture(autonomous = false) {
  const time = observationClock(() => /\bat (?:[^ (\n]+\.)?(?:armIdleTimer|armNoWaitNudgeReplyTimer) \(/.test(new Error().stack ?? ''));
  const f = boundaryOrderFixture(autonomous);
  type Args = ConstructorParameters<typeof TurnNudges>;
  const host = unused<Args[4]>('nudges', {
    active: f.active, workerExecutionStopped: () => false, executionBlockedByRootFinish: () => false,
    countAutomaticWakes: () => 0, hasQueuedAgentInputs: () => false,
    submitAgentInput: vi.fn(() => { f.log.push('submit'); return true; }),
    chargeAutomaticWake: () => { f.log.push('charge'); return 1; },
    armIdleTimer: (...args) => f.settler.armIdleTimer(...args),
    resumeParkedRun: () => { f.log.push('resume'); },
    openTurnEndHumanWait: (...args) => f.settler.openTurnEndHumanWait(...args),
    settledTurnOutcome: (_id, _entry, outcome) => { f.log.push('outcome'); return outcome; },
  });
  const nudges = new TurnNudges(f.context, f.humanWaits, f.line, unused<Args[3]>('completion gate'), host, 40, 'workers remain', 300_000);
  return { ...f, time, host, nudges };
}
function order(log: string[], expected: string[]): void {
  const selected = new Set(expected);
  expect(log.filter(item => selected.has(item))).toEqual(expected);
}
afterEach(() => vi.restoreAllMocks());

it('idle rearming clears idle then reply handles before resetting and arming the new idle bound', () => {
  const f = fixture();
  f.settler.armIdleTimer(f.run.id, f.state);
  f.nudges.armNoWaitNudgeReplyTimer(f.run.id, f.state);
  const idle = f.state.boundary.idleTimer;
  const reply = f.state.boundary.noWaitNudgeReplyTimer;
  const clear = clearTimeout;
  vi.spyOn(globalThis, 'clearTimeout').mockImplementation(handle => {
    if (handle === idle) { expect(f.state.boundary.idleTimer).toBe(idle); f.log.push('clear-idle'); }
    if (handle === reply) { expect(f.state.boundary.noWaitNudgeReplyTimer).toBe(reply); f.log.push('clear-reply'); }
    clear(handle);
  });
  f.log.length = 0;
  f.settler.armIdleTimer(f.run.id, f.state);
  order(f.log, ['clear-idle', 'boundary:idle-expired/cancel', 'clear-reply', 'boundary:reply-expired/cancel',
    'boundary:idle-expired/reset', 'boundary:idle-expired/armed']);
  expect(f.state.boundary.idleTimer).not.toBe(idle);
  expect(f.state.boundary.noWaitNudgeReplyTimer).toBeUndefined();
  expect(f.state.boundary.idleClosed).toBe(false);
  expect(f.time.pending).toBe(1);
  f.log.length = 0;
  f.time.fire(2);
  order(f.log, ['boundary:idle-expired/close', 'event:lifecycle', 'end']);
  expect(f.state.boundary.idleClosed).toBe(true);
});

it('a stale reply callback clears its handle before checking the current session and does not park', () => {
  const f = fixture();
  f.nudges.armNoWaitNudgeReplyTimer(f.run.id, f.state);
  f.state.liveSession.retireSession();
  f.log.length = 0;
  f.time.fire(0);
  expect(f.log).toEqual(['boundary:reply-expired/fired']);
  expect(f.state.boundary.noWaitNudgeReplyTimer).toBeUndefined();
  expect(f.store.getRun(f.run.id)?.status).toBe('running');
});

it('a no-wait nudge resets content before submit and arms its reply bound before charge and note', () => {
  const f = fixture();
  f.settler.armIdleTimer(f.run.id, f.state);
  f.log.length = 0;
  expect(f.nudges.sendTurnEndNudge(f.run.id, f.state, 'step', 'continue')).toBe(true);
  order(f.log, ['boundary:turn-end/reset-content', 'submit', 'boundary:input-submitted/nudge-delivered',
    'boundary:idle-expired/cancel', 'boundary:reply-expired/armed', 'charge', 'event:note']);
  expect(f.state.boundary.noWaitNudged).toBe(f.wire);
  expect(f.state.boundary.idleTimer).toBeUndefined();
  expect(f.time.pending).toBe(1);
  clearIdleTimer(f.state);
});

it('a refused autonomous nudge retains its boundary before the idle bound and spends no budget', () => {
  const f = fixture(true);
  vi.mocked(f.host.submitAgentInput).mockImplementation(() => { f.log.push('submit'); return false; });
  expect(f.nudges.tryAutonomousNudge(f.run.id, f.state, 'step')).toBe(false);
  order(f.log, ['boundary:input-ready/clear-nudge', 'submit', 'boundary:input-ready/retain-nudge',
    'boundary:idle-expired/reset', 'boundary:idle-expired/armed']);
  expect(f.log).not.toContain('charge');
  expect(f.log).not.toContain('release');
  expect(f.state.boundary.autonomousNudgePending).toBe(f.wire);
});

// An accepted autonomous nudge starts a turn, so neither the idle bound nor the no-wait reply bound
// can close or park the run while that turn runs.
it('a delivered autonomous nudge cancels the idle bound and arms no other bound before charge and note', () => {
  const f = fixture(true);
  f.settler.armIdleTimer(f.run.id, f.state);
  f.log.length = 0;
  expect(f.nudges.tryAutonomousNudge(f.run.id, f.state, 'step')).toBe(true);
  order(f.log, ['boundary:input-ready/clear-nudge', 'boundary:idle-expired/cancel', 'submit', 'charge', 'event:note']);
  expect(f.log).not.toContain('boundary:idle-expired/armed');
  expect(f.log).not.toContain('boundary:reply-expired/armed');
  expect(f.state.boundary.idleTimer).toBeUndefined();
  expect(f.state.boundary.noWaitNudgeReplyTimer).toBeUndefined();
  expect(f.time.pending).toBe(0);
});

it('late parent content clears the reply bound before resuming and then clears the parked fact', () => {
  const f = fixture();
  transitionTurnBoundary(f.state, { kind: 'reply-expired', phase: 'park', session: f.wire });
  vi.spyOn(f.line, 'isParked').mockReturnValue(true);
  f.nudges.armNoWaitNudgeReplyTimer(f.run.id, f.state);
  f.log.length = 0;
  f.nudges.noteNoWaitNudgeContent(f.run.id, f.state, { type: 'text' });
  order(f.log, ['boundary:reply-content/received', 'boundary:reply-expired/cancel', 'resume', 'boundary:reply-content/resumed']);
  expect(f.state.boundary.noWaitNudgeParked).toBeUndefined();
  expect(f.time.pending).toBe(0);
});

it('child content leaves the reply bound and parked fact untouched', () => {
  const f = fixture();
  f.nudges.armNoWaitNudgeReplyTimer(f.run.id, f.state);
  const timer = f.state.boundary.noWaitNudgeReplyTimer;
  f.log.length = 0;
  f.nudges.noteNoWaitNudgeContent(f.run.id, f.state, { type: 'item.completed', item: { parentItemId: 'child' } });
  expect(f.log).toEqual([]);
  expect(f.state.boundary.noWaitNudgeReplyTimer).toBe(timer);
  expect(f.time.pending).toBe(1);
  clearIdleTimer(f.state);
});

it('completion refusal records delivery before refusal and reply reset and timer arming', () => {
  const f = fixture();
  const gate = vi.spyOn(completion, 'completionRefusal').mockImplementation(() => {
    f.log.push('refusal-gate'); expect(f.state.boundary.completionNudged).toBe(f.wire);
    return { code: 'requests_unanswered', workers: [], message: 'answer request', liveWorkerIds: [] };
  });
  f.settler.armIdleTimer(f.run.id, f.state); f.log.length = 0;
  f.nudges.awaitCompletionNudgeReply(f.run.id, f.state, f.wire);
  order(f.log, ['boundary:completion-refusal/nudge-delivered', 'refusal-gate', 'boundary:completion-refusal/record',
    'boundary:completion-refusal/reset-content', 'boundary:idle-expired/cancel', 'boundary:reply-expired/armed']);
  expect(f.state.boundary.incomingRequestRefused).toBe(true);
  expect(f.state.boundary.noWaitNudgeSawContent).toBe(false);
  gate.mockRestore();
});
