import { describe, expect, it } from 'vitest';
import type { RunRecord } from './runs.ts';
import {
  asksQuestion,
  askErrorCodeSchema,
  cezarAskAnswerSchema,
  cezarAskRequestSchema,
  cezarCancelWaitAnswerSchema,
  cezarDoneAnswerSchema,
  cezarDoneRequestSchema,
  cezarCancelWaitRequestSchema,
  cezarWaitAnswerSchema,
  cezarWaitRequestSchema,
  computeWaitingOn,
  PROCESS_TIMEOUT_DEFAULT_SECONDS,
  processWaitEntrySchema,
  hasWorkerDeadline,
  LAST_WAITS_LIMIT,
  resolveWaitingOn,
  TIMER_MAX_SECONDS,
  TIMER_MIN_SECONDS,
  WAIT_LIMIT,
  waitErrorCodeSchema,
  waitingOnSchema,
  waitSchema,
  completionWaitView,
  completionWaitEntry,
  workerCompletionWaitProjection,
  requestsToPeers,
  withRootLedger,
  workerWaitView,
  workerWaitEntrySchema,
  workerWaitEntryToLegacy,
  openWaitSchema,
  peerWaitEntrySchema,
  peerWaitView,
  waitViaSchema,
  type PrWaitEntry,
  type DeadlinedWorkerWaitEntry,
  type HumanWaitEntry,
  type ProcessWaitEntry,
  type TimerWaitEntry,
  type WorkerWaitEntry,
} from './waits.ts';
import { peerWaitViewSchema, workerCompletionWaitSchema, workerInspectionSchema, workerWaitSchema } from './delegation.ts';
import { makeRunRecord, RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from './test-factories.testkit.ts';
import { toRunSummary } from './runs.ts';
import { deriveAttention } from './attention.ts';

/**
 * The wait list (spec 2026-10-17-unified-waits, phase 1: hearsay-tools/cezarion#1233). The
 * schemas are the stored and model-facing shapes; `computeWaitingOn` is the one function that
 * names the run's top open wait, so its order is pinned here rather than in each reader.
 */

const CI_ID = '11111111-1111-4111-8111-111111111111';
const TIMER_ID = '22222222-2222-4222-8222-222222222222';
const HEAD = 'a'.repeat(40);

function openCi(over: Partial<PrWaitEntry> = {}): PrWaitEntry {
  return {
    kind: 'pr',
    id: CI_ID,
    source: 'agent',
    via: 'cezar_wait',
    registeredAt: '2026-10-17T15:10:00.000Z',
    deadline: '2026-10-17T15:40:00.000Z',
    phase: 'open',
    turnId: 'turn-1',
    prUrl: 'https://github.com/o/r/pull/12',
    repository: 'o/r',
    prNumber: 12,
    headSha: HEAD,
    generation: 'gen-1',
    timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true,
    ...over,
  };
}

function openTimer(over: Partial<TimerWaitEntry> = {}): TimerWaitEntry {
  return {
    kind: 'timer',
    id: TIMER_ID,
    source: 'agent',
    via: 'cezar_wait',
    registeredAt: '2026-10-17T15:00:00.000Z',
    deadline: '2026-10-17T15:05:00.000Z',
    phase: 'open',
    turnId: 'turn-1',
    seconds: 300,
    ...over,
  };
}

const PROCESS_ID = '77777777-7777-4777-8777-777777777777';

function openProcess(over: Partial<ProcessWaitEntry> = {}): ProcessWaitEntry {
  return {
    kind: 'process',
    id: PROCESS_ID,
    source: 'agent',
    via: 'cezar_wait',
    registeredAt: '2026-10-17T15:00:00.000Z',
    deadline: '2026-10-17T15:30:00.000Z',
    phase: 'open',
    turnId: 'turn-1',
    timeoutSeconds: 1800,
    pid: 4242,
    ...over,
  };
}

const HUMAN_ID = '66666666-6666-4666-8666-666666666666';
const CARD = [{ header: 'Library', question: 'Which test library?', options: [{ label: 'Vitest' }, { label: 'Node test' }] }];

function openHuman(over: Partial<HumanWaitEntry> = {}): HumanWaitEntry {
  return {
    kind: 'human',
    id: HUMAN_ID,
    source: 'agent',
    via: 'cezar_ask',
    registeredAt: '2026-10-17T15:20:00.000Z',
    phase: 'open',
    turnId: 'turn-1',
    ...over,
  };
}

/** An old row's completion wait in `delegation.wait`: never read since hearsay-tools/cezarion#1301. */
function parkedRootWait(): RunRecord['delegation'] {
  return {
    role: 'root', permissions: [], receipts: [],
    wait: {
      id: '33333333-3333-4333-8333-333333333333',
      workerIds: ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'],
      deadline: '2026-10-17T16:00:00.000Z', phase: 'parked', outcomes: [],
    },
  } as unknown as RunRecord['delegation'];
}

/** Cezar's completion wait on two workers: a list entry with no deadline (hearsay-tools/cezarion#1301). */
function completionWaits(over: Record<string, unknown> = {}): WorkerWaitEntry[] {
  return [workerWaitEntrySchema.parse({
    kind: 'worker', id: '33333333-3333-4333-8333-333333333333', source: 'cezar', via: 'completion', registeredAt: '2026-10-17T15:00:00.000Z',
    phase: 'open', turnId: 'turn-1', mode: 'all', revisions: [], outcomes: [],
    workerIds: ['44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555'], ...over,
  })];
}

describe('limits', () => {
  it('names the phase 1 bounds', () => {
    expect([WAIT_LIMIT, LAST_WAITS_LIMIT, TIMER_MIN_SECONDS, TIMER_MAX_SECONDS]).toEqual([16, 16, 60, 7200]);
  });
});

describe('waitSchema', () => {
  it('parses a ci and a timer entry and refuses unknown keys', () => {
    expect(waitSchema.parse(openCi())).toEqual(openCi());
    expect(waitSchema.parse(openTimer({ note: 'check the deploy' }))).toEqual(openTimer({ note: 'check the deploy' }));
    expect(waitSchema.safeParse({ ...openCi(), stray: true }).success).toBe(false);
    expect(waitSchema.safeParse({ ...openTimer(), prUrl: 'https://github.com/o/r/pull/1' }).success).toBe(false);
  });

  it('bounds timer seconds and the note', () => {
    expect(waitSchema.safeParse(openTimer({ seconds: 59 })).success).toBe(false);
    expect(waitSchema.safeParse(openTimer({ seconds: 7201 })).success).toBe(false);
    expect(waitSchema.safeParse(openTimer({ note: 'x'.repeat(513) })).success).toBe(false);
    expect(waitSchema.safeParse(openTimer({ note: 'x'.repeat(512) })).success).toBe(true);
  });

  it('accepts every phase and alias origin, and nothing else', () => {
    for (const phase of ['open', 'resolved', 'delivered', 'cancelled'] as const) {
      expect(waitSchema.safeParse(openCi({ phase })).success).toBe(true);
    }
    expect(waitSchema.safeParse({ ...openCi(), phase: 'withdrawn' }).success).toBe(false);
    for (const via of ['cezar_wait', 'cezar_wait_for_ci', 'monitoring-line', 'schedule-wakeup'] as const) {
      expect(waitSchema.safeParse(openTimer({ via })).success).toBe(true);
    }
    // hearsay-tools/cezarion#1234: the user's question names the tool that asked it, or its alias.
    for (const via of ['cezar_ask', 'ask-line', 'native-ask', 'no-wait', 'budget'] as const) {
      expect(waitSchema.safeParse(openHuman({ via })).success).toBe(true);
    }
    expect(waitSchema.safeParse(openHuman({ via: 'cezar_question' as never })).success).toBe(false);
  });
});

describe('computeWaitingOn', () => {
  it('orders waitingOn human > usage limit > workers > CI > timer', () => {
    const ci = openCi({ deadline: '2026-10-17T15:40:00.000Z' });
    const timer = openTimer({ deadline: '2026-10-17T15:05:00.000Z' });
    expect(computeWaitingOn({ waits: [timer, ci] })?.kind).toBe('pr');
    expect(computeWaitingOn({ waits: [timer] })?.kind).toBe('timer');
    expect(computeWaitingOn({ waits: [ci, ...completionWaits()] })?.kind).toBe('workers');
    expect(computeWaitingOn({ status: 'waiting', waits: [ci], autoResumeAt: '2026-10-17T16:00:00.000Z' })?.kind).toBe('usage-limit');
    expect(computeWaitingOn({ waits: [ci, openHuman()] })).toEqual({ kind: 'human' });
    expect(computeWaitingOn({ waits: [ci, openHuman({ askSeq: 4 })] })).toEqual({ kind: 'human', shown: true });
    expect(computeWaitingOn({ waits: [{ ...ci, phase: 'resolved' }] })).toBeUndefined();
  });

  it('reads only open waits', () => {
    for (const phase of ['resolved', 'delivered', 'cancelled'] as const) {
      expect(computeWaitingOn({ waits: [openCi({ phase }), openTimer({ phase })] })).toBeUndefined();
    }
    expect(computeWaitingOn({})).toBeUndefined();
    expect(computeWaitingOn({ waits: [] })).toBeUndefined();
  });

  it('picks the earliest deadline among several waits of one kind', () => {
    const late = openCi({ id: '66666666-6666-4666-8666-666666666666', deadline: '2026-10-17T16:00:00.000Z', prNumber: 9 });
    const early = openCi({ deadline: '2026-10-17T15:30:00Z' });
    expect(computeWaitingOn({ waits: [late, early] })).toEqual({
      kind: 'pr', until: 'checks', waitId: CI_ID, prUrl: early.prUrl, repository: 'o/r', prNumber: 12, deadline: '2026-10-17T15:30:00Z',
    });
    const laterTimer = openTimer({ id: '77777777-7777-4777-8777-777777777777', deadline: '2026-10-17T15:50:00.000Z' });
    expect(computeWaitingOn({ waits: [laterTimer, openTimer({ note: 'deploy' })] })).toEqual({
      kind: 'timer', waitId: TIMER_ID, at: '2026-10-17T15:05:00.000Z', note: 'deploy',
    });
  });

  it('carries the usage-limit instant and the count of workers still owed', () => {
    expect(computeWaitingOn({ status: 'waiting', autoResumeAt: '2026-10-17T16:00:00.000Z' })).toEqual({ kind: 'usage-limit', at: '2026-10-17T16:00:00.000Z' });
    expect(computeWaitingOn({ waits: completionWaits() })).toEqual({ kind: 'workers', count: 2 });
  });

  it('counts a worker wait that is still open, not one whose wake is already queued', () => {
    expect(computeWaitingOn({ waits: completionWaits() })?.kind).toBe('workers');
    expect(computeWaitingOn({ waits: [...completionWaits({ phase: 'resolved' }), openCi()] })?.kind).toBe('pr');
    expect(computeWaitingOn({ delegation: { role: 'invalid' }, waits: [openCi()] })?.kind).toBe('pr');
    // An old row's `delegation.wait` is not read: the store moves it into the list on open.
    expect(computeWaitingOn({ delegation: parkedRootWait(), waits: [openCi()] })?.kind).toBe('pr');
    expect(computeWaitingOn({ delegation: parkedRootWait() })).toBeUndefined();
  });

  it('produces values the waitingOn schema accepts', () => {
    for (const input of [
      { waits: [openHuman()] },
      { waits: [openHuman({ askSeq: 4 })] },
      { status: 'waiting' as const, autoResumeAt: '2026-10-17T16:00:00.000Z' },
      { waits: completionWaits() },
      { waits: [openCi()] },
      { waits: [openTimer({ note: 'deploy' })] },
    ]) {
      const waitingOn = computeWaitingOn(input);
      expect(waitingOnSchema.parse(waitingOn)).toEqual(waitingOn);
    }
  });
});

describe('resolveWaitingOn', () => {
  it('prefers a summary\'s waitingOn and derives it from a record without one', () => {
    expect(resolveWaitingOn({ waitingOn: { kind: 'human' }, waits: [openCi()] })).toEqual({ kind: 'human' });
    expect(resolveWaitingOn({ waits: [openCi()] })?.kind).toBe('pr');
    expect(resolveWaitingOn({})).toBeUndefined();
  });
});

describe('cezar_wait request', () => {
  it('accepts the ci and timer request shapes and refuses the rest', () => {
    expect(cezarWaitRequestSchema.parse({ kind: 'pr', pr: 'https://github.com/o/r/pull/1' })).toMatchObject({ timeout_seconds: 1800 });
    // hearsay-tools/cezarion#1234: the user is asked through cezar_ask, never cezar_wait.
    expect(cezarWaitRequestSchema.safeParse({ kind: 'human', questions: CARD }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'timer', seconds: 59 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'timer', seconds: 7201 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker' }).success).toBe(false); // phase 3
  });

  it('keeps the ci bounds of cezar_wait_for_ci and refuses stray keys', () => {
    expect(cezarWaitRequestSchema.safeParse({ kind: 'pr', pr: 'https://github.com/o/r/pull/1', timeout_seconds: 0 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'pr', pr: 'https://github.com/o/r/pull/1', timeout_seconds: 7201 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'pr', pr: 'https://example.com/nope' }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'timer', seconds: 60, pr: 'https://github.com/o/r/pull/1' }).success).toBe(false);
    expect(cezarWaitRequestSchema.parse({ kind: 'timer', seconds: 7200, note: 'deploy' })).toEqual({ kind: 'timer', seconds: 7200, note: 'deploy' });
    expect(cezarWaitRequestSchema.safeParse({ kind: 'timer', seconds: 60, note: 'x'.repeat(513) }).success).toBe(false);
  });

  it('cancels by uuid only', () => {
    expect(cezarCancelWaitRequestSchema.parse({ wait_id: CI_ID })).toEqual({ wait_id: CI_ID });
    expect(cezarCancelWaitRequestSchema.safeParse({ wait_id: 'w1' }).success).toBe(false);
    expect(cezarCancelWaitRequestSchema.safeParse({ wait_id: CI_ID, extra: 1 }).success).toBe(false);
  });
});

describe('answers', () => {
  const openWait = { wait_id: CI_ID, kind: 'pr' as const, deadline: '2026-10-17T15:40:00.000Z', summary: 'CI on o/r#12' };

  it('parses accepted and refused cezar_wait answers', () => {
    expect(cezarWaitAnswerSchema.parse({ ok: true, wait_id: CI_ID, kind: 'pr', deadline: openWait.deadline, open_waits: [openWait] }).ok).toBe(true);
    expect(cezarWaitAnswerSchema.parse({ ok: false, code: 'timers_disabled', message: 'no timers' }).ok).toBe(false);
    expect(cezarWaitAnswerSchema.safeParse({ ok: false, code: 'not_a_code', message: 'x' }).success).toBe(false);
    expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: CI_ID, kind: 'pr', deadline: openWait.deadline }).success).toBe(false);
  });

  // hearsay-tools/cezarion#1234: a CI or timer wait always carries its deadline; a human wait never does.
  it('ties the deadline to the kind, in the answer and in every open wait', () => {
    const human = { wait_id: HUMAN_ID, kind: 'human' as const, summary: 'human: Which module?' };
    expect(cezarWaitAnswerSchema.parse({ ok: true, wait_id: CI_ID, kind: 'pr', deadline: openWait.deadline, open_waits: [openWait, human] }).ok).toBe(true);
    // cezar_wait opens no human wait, so its answer never names one.
    expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: HUMAN_ID, kind: 'human', open_waits: [human] }).success).toBe(false);
    for (const kind of ['pr', 'timer'] as const) {
      expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: CI_ID, kind, open_waits: [] }).success).toBe(false);
      expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: CI_ID, kind, deadline: openWait.deadline, open_waits: [{ ...openWait, kind, deadline: undefined }] }).success).toBe(false);
    }
    expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: CI_ID, kind: 'pr', deadline: openWait.deadline, open_waits: [{ ...human, deadline: openWait.deadline }] }).success).toBe(false);
    expect(cezarCancelWaitAnswerSchema.safeParse({ cancelled: true, wait_id: CI_ID, open_waits: [{ ...human, deadline: openWait.deadline }] }).success).toBe(false);
  });

  it('extends the CI error codes with the timer refusals', () => {
    expect(waitErrorCodeSchema.options).toEqual(expect.arrayContaining(['invalid_request', 'capacity', 'timers_disabled', 'wake_budget_spent']));
    expect(waitErrorCodeSchema.options).not.toContain('autonomous_run');
  });

  it('parses cancel answers, with the open waits on either branch', () => {
    expect(cezarCancelWaitAnswerSchema.parse({ cancelled: true, wait_id: CI_ID, open_waits: [] }).cancelled).toBe(true);
    expect(cezarCancelWaitAnswerSchema.parse({ cancelled: false, code: 'already_resolved', message: 'delivered with the next wake', open_waits: [openWait] }).cancelled).toBe(false);
    expect(cezarCancelWaitAnswerSchema.safeParse({ cancelled: false, code: 'capacity', message: 'x' }).success).toBe(false);
    expect(cezarCancelWaitAnswerSchema.safeParse({ cancelled: true, wait_id: CI_ID, open_waits: [{ ...openWait, summary: 'x'.repeat(257) }] }).success).toBe(false);
  });
});

// hearsay-tools/cezarion#1234: the human wait and `cezar_done` (unified waits, phase 2).
describe('human waits', () => {
  it('a human wait parses without a deadline; ci and timer still require one', () => {
    expect(waitSchema.safeParse(openHuman()).success).toBe(true);
    expect(waitSchema.safeParse(openHuman({ questions: CARD, askSeq: 7 })).success).toBe(true);
    const { deadline: _ci, ...ciWithoutDeadline } = openCi();
    const { deadline: _timer, ...timerWithoutDeadline } = openTimer();
    expect(waitSchema.safeParse(ciWithoutDeadline).success).toBe(false);
    expect(waitSchema.safeParse(timerWithoutDeadline).success).toBe(false);
    expect(waitSchema.safeParse({ ...openHuman(), deadline: '2026-10-17T15:40:00.000Z' }).success).toBe(false);
  });

  it('an open human wait outranks usage limit, workers, ci and timer', () => {
    expect(computeWaitingOn({ status: 'waiting', waits: [openCi(), openTimer(), openHuman()], autoResumeAt: '2026-10-17T16:00:00.000Z' }))
      .toEqual({ kind: 'human' });
    for (const phase of ['delivered', 'cancelled'] as const) {
      expect(computeWaitingOn({ waits: [openCi(), openHuman({ phase })] })?.kind).toBe('pr');
    }
  });

  it('lists an open human wait without a deadline in every answer', () => {
    const human = { wait_id: HUMAN_ID, kind: 'human' as const, summary: 'human: Which test library?' };
    expect(cezarAskAnswerSchema.parse({ ok: true, wait_id: HUMAN_ID, open_waits: [human] }).ok).toBe(true);
    expect(cezarCancelWaitAnswerSchema.parse({ cancelled: false, code: 'human_question', message: 'm', open_waits: [human] }).cancelled).toBe(false);
  });
});

// hearsay-tools/cezarion#1234: the user is asked with its own tool, which always carries a card.
describe('cezar_ask', () => {
  it('requires a card within the ask bounds and takes nothing else', () => {
    expect(cezarAskRequestSchema.parse({ context: 'c', questions: CARD })).toEqual({ context: 'c', questions: CARD });
    expect(cezarAskRequestSchema.safeParse({}).success).toBe(false);
    expect(cezarAskRequestSchema.safeParse({ questions: CARD }).success).toBe(false);
    expect(cezarAskRequestSchema.safeParse({ context: 'c', questions: [] }).success).toBe(false);
    const five = Array.from({ length: 5 }, (_, n) => ({ ...CARD[0]!, question: `Question ${n}?` }));
    expect(cezarAskRequestSchema.safeParse({ context: 'c', questions: five }).success).toBe(false);
    expect(cezarAskRequestSchema.safeParse({ kind: 'human', context: 'c', questions: CARD }).success).toBe(false);
  });

  it('takes an open question as a question without options', () => {
    const open = [{ header: 'Name', question: 'What should the command be called?' }];
    expect(cezarAskRequestSchema.parse({ context: 'c', questions: open })).toEqual({ context: 'c', questions: open });
    expect(cezarAskRequestSchema.parse({ context: 'c', questions: [...CARD, ...open] }).questions).toHaveLength(2);
    // A list of options keeps its bounds: an empty or one-option list is not an open question.
    expect(cezarAskRequestSchema.safeParse({ context: 'c', questions: [{ ...open[0], options: [] }] }).success).toBe(false);
    expect(cezarAskRequestSchema.safeParse({ context: 'c', questions: [{ ...open[0], options: [{ label: 'Only' }] }] }).success).toBe(false);
  });

  it('answers with the wait id and the open waits, or a refusal the agent can act on', () => {
    expect(cezarAskAnswerSchema.safeParse({ ok: true, wait_id: HUMAN_ID, kind: 'human', open_waits: [] }).success).toBe(false);
    expect(cezarAskAnswerSchema.safeParse({ ok: true, wait_id: HUMAN_ID, deadline: '2026-10-17T15:40:00.000Z', open_waits: [] }).success).toBe(false);
    expect(cezarAskAnswerSchema.parse({ ok: false, code: 'autonomous_run', message: 'm' }).ok).toBe(false);
    expect(askErrorCodeSchema.options).toEqual(expect.arrayContaining(['invalid_request', 'capacity', 'autonomous_run', 'session_closed', 'worker_wait_pending', 'unavailable']));
    // Only refusals a question can meet: no CI lookup failures, no timer refusals.
    for (const code of ['inaccessible_pr', 'gh_missing', 'timers_disabled', 'wake_budget_spent', 'questions_required']) {
      expect(askErrorCodeSchema.options).not.toContain(code);
    }
  });
});

describe('cezar_done', () => {
  it('takes an optional bounded summary and nothing else', () => {
    expect(cezarDoneRequestSchema.parse({})).toEqual({});
    expect(cezarDoneRequestSchema.parse({ summary: 'shipped' })).toEqual({ summary: 'shipped' });
    expect(cezarDoneRequestSchema.safeParse({ summary: 'x'.repeat(2001) }).success).toBe(false);
    expect(cezarDoneRequestSchema.safeParse({ force: true }).success).toBe(false);
  });

  it('cezar_done answers round-trip', () => {
    expect(cezarDoneAnswerSchema.parse({ ok: true, finishes: 'at_turn_end', completes: 'task', open_waits: [] }).ok).toBe(true);
    // hearsay-tools/cezarion#1620: a step's done names the step it starts; a task's names none.
    const step = { ok: true, finishes: 'at_turn_end', completes: 'step', next_step: 'Review', open_waits: [] };
    expect(cezarDoneAnswerSchema.parse(step)).toEqual(step);
    expect(cezarDoneAnswerSchema.safeParse({ ...step, next_step: undefined }).success).toBe(false);
    expect(cezarDoneAnswerSchema.safeParse({ ...step, completes: 'task' }).success).toBe(false);
    expect(cezarDoneAnswerSchema.safeParse({ ok: true, finishes: 'at_turn_end', open_waits: [] }).success).toBe(false);
    const refused = { ok: false, code: 'workers_outstanding', message: 'm', workers: [{ worker_id: 'w', reason: 'outstanding' }] };
    expect(cezarDoneAnswerSchema.parse(refused)).toEqual(refused);
    expect(cezarDoneAnswerSchema.safeParse({ ok: false, code: 'not_a_code', message: 'm' }).success).toBe(false);
    expect(cezarDoneAnswerSchema.safeParse({ ok: true, finishes: 'now', open_waits: [] }).success).toBe(false);
  });
});

// ---- worker waits (hearsay-tools/cezarion#1235, phase 3a) ------------------------------------

const WORKER_WAIT_ID = '88888888-8888-4888-8888-888888888888';
const W1 = '99999999-9999-4999-8999-999999999991';
const W2 = '99999999-9999-4999-8999-999999999992';
const R1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1';
const WAKE_INPUT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function workerBase(over: Record<string, unknown> = {}) {
  return {
    kind: 'worker',
    id: WORKER_WAIT_ID,
    source: 'agent',
    via: 'cezar_wait',
    registeredAt: '2026-10-19T10:00:00.000Z',
    deadline: '2026-10-19T10:10:00.000Z',
    phase: 'open',
    turnId: 'turn-1',
    timeoutSeconds: 600,
    ...over,
  };
}

function deadlined(entry: WorkerWaitEntry): DeadlinedWorkerWaitEntry {
  if (!hasWorkerDeadline(entry)) throw new Error('worker wait fixture lost its deadline');
  return entry;
}

function openWorkerWait(over: Partial<WorkerWaitEntry> = {}): DeadlinedWorkerWaitEntry {
  return deadlined(workerWaitEntrySchema.parse(workerBase({ mode: 'all', workerIds: [W1, W2], revisions: [{ workerId: W1, revision: 1 }], outcomes: [], ...over })));
}

function openRequestWait(over: Record<string, unknown> = {}): DeadlinedWorkerWaitEntry {
  return deadlined(workerWaitEntrySchema.parse(workerBase({ requestIds: [R1], requestOutcomes: [], ...over })));
}

describe('worker wait entry', () => {
  it('worker entry accepts worker ids or request ids, never both or neither', () => {
    const byWorker = workerBase({ workerIds: [W1], revisions: [], outcomes: [] });
    const byRequest = workerBase({ requestIds: [R1], requestOutcomes: [] });
    expect(waitSchema.safeParse(byWorker).success).toBe(true);
    expect(waitSchema.safeParse(byRequest).success).toBe(true);
    expect(waitSchema.safeParse(workerBase()).success).toBe(false);
    expect(waitSchema.safeParse({ ...byWorker, requestIds: [R1], requestOutcomes: [] }).success).toBe(false);
    // A half-target is no target: ids without their ledger, or the other kind's ledger.
    expect(waitSchema.safeParse(workerBase({ workerIds: [W1] })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ workerIds: [W1], revisions: [], outcomes: [], requestOutcomes: [] })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ requestIds: [R1] })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ requestIds: [R1], requestOutcomes: [], revisions: [] })).success).toBe(false);
  });

  it('bounds the ids, the timeout and the result, and refuses unknown keys', () => {
    expect(waitSchema.safeParse(workerBase({ workerIds: [], revisions: [], outcomes: [] })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ workerIds: [W1, W1], revisions: [], outcomes: [] })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ requestIds: [R1, R1], requestOutcomes: [] })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ requestIds: Array.from({ length: 33 }, (_, i) => `aaaaaaaa-aaaa-4aaa-8aaa-${String(i).padStart(12, '0')}`), requestOutcomes: [] })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ requestIds: [R1], requestOutcomes: [], timeoutSeconds: 0 })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ requestIds: [R1], requestOutcomes: [], timeoutSeconds: 1801 })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ requestIds: [R1], requestOutcomes: [], deadline: undefined })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ requestIds: [R1], requestOutcomes: [], stray: true })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ requestIds: [R1], requestOutcomes: [], phase: 'resolved', result: { reason: 'outcome' } })).success).toBe(true);
    // `cancelled` is a phase and `message` is gone: neither is a result.
    for (const reason of ['cancelled', 'message']) {
      expect(waitSchema.safeParse(workerBase({ requestIds: [R1], requestOutcomes: [], result: { reason } })).success).toBe(false);
    }
    expect(waitSchema.safeParse(workerBase({ requestIds: [R1], requestOutcomes: [], wakeInputId: WAKE_INPUT })).success).toBe(true);
    expect(waitSchema.safeParse(workerBase({ requestIds: [R1], requestOutcomes: [], wakeInputId: 'nope' })).success).toBe(false);
  });

  it('a persisted entry with mode one needs exactly one id, of either target', () => {
    const W3 = '99999999-9999-4999-8999-999999999993';
    const R2 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2';
    expect(waitSchema.safeParse(workerBase({ mode: 'one', workerIds: [W1, W2], revisions: [], outcomes: [] })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ mode: 'one', workerIds: [W1, W2, W3], revisions: [], outcomes: [] })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ mode: 'one', requestIds: [R1, R2], requestOutcomes: [] })).success).toBe(false);
    expect(waitSchema.safeParse(workerBase({ mode: 'one', workerIds: [W1], revisions: [], outcomes: [] })).success).toBe(true);
    expect(waitSchema.safeParse(workerBase({ mode: 'one', requestIds: [R1], requestOutcomes: [] })).success).toBe(true);
    expect(waitSchema.safeParse(workerBase({ mode: 'all', workerIds: [W1, W2], revisions: [], outcomes: [] })).success).toBe(true);
  });

  it('takes the cez-worker-wait origin', () => {
    expect(waitViaSchema.options).toContain('cez-worker-wait');
    expect(waitSchema.safeParse(workerBase({ via: 'cez-worker-wait', requestIds: [R1], requestOutcomes: [] })).success).toBe(true);
  });
});

describe('cezar_wait worker request', () => {
  it('cezar_wait worker request: mode one needs one id; timeout defaults to 600; 1801 refused', () => {
    expect(cezarWaitRequestSchema.parse({ kind: 'worker', worker_ids: [W1] })).toEqual({ kind: 'worker', worker_ids: [W1], timeout_seconds: 600 });
    expect(cezarWaitRequestSchema.parse({ kind: 'request', request_ids: [R1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'], mode: 'all', timeout_seconds: 1800 }))
      .toMatchObject({ mode: 'all', timeout_seconds: 1800 });
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker', worker_ids: [W1], timeout_seconds: 1801 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker', worker_ids: [W1], timeout_seconds: 0 }).success).toBe(false);
    // mode one: exactly one id, of either kind.
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker', worker_ids: [W1], mode: 'one' }).success).toBe(true);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker', worker_ids: [W1, W2], mode: 'one' }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'request', request_ids: [R1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'], mode: 'one' }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'request', request_ids: [R1], mode: 'one' }).success).toBe(true);
  });

  // hearsay-tools/cezarion#1995: request ids moved to their own kind, so "worker" never names a reply.
  it('kind worker takes worker_ids only, and kind request takes request_ids only', () => {
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker', request_ids: [R1] }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'request', worker_ids: [W1] }).success).toBe(false);
    expect(cezarWaitRequestSchema.parse({ kind: 'request', request_ids: [R1] })).toEqual({ kind: 'request', request_ids: [R1], timeout_seconds: 600 });
  });

  it('kind peer names 1 to 32 unique peers, with a deadline of 1 to 1800 seconds, default 600', () => {
    expect(cezarWaitRequestSchema.parse({ kind: WAIT_KIND.peer, peer_ids: [W1] })).toEqual({ kind: WAIT_KIND.peer, peer_ids: [W1], timeout_seconds: 600 });
    expect(cezarWaitRequestSchema.safeParse({ kind: WAIT_KIND.peer, peer_ids: [] }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: WAIT_KIND.peer, peer_ids: [W1, W1] }).success).toBe(false);
    const ids = Array.from({ length: 33 }, (_, i) => `99999999-9999-4999-8999-${String(i).padStart(12, '0')}`);
    expect(cezarWaitRequestSchema.safeParse({ kind: WAIT_KIND.peer, peer_ids: ids.slice(0, 32) }).success).toBe(true);
    expect(cezarWaitRequestSchema.safeParse({ kind: WAIT_KIND.peer, peer_ids: ids }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: WAIT_KIND.peer, peer_ids: [W1], timeout_seconds: 1801 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: WAIT_KIND.peer, peer_ids: [W1], timeout_seconds: 0 }).success).toBe(false);
    // No "any peer" form, and no mode: every named peer ends it.
    expect(cezarWaitRequestSchema.safeParse({ kind: WAIT_KIND.peer }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: WAIT_KIND.peer, peer_ids: [W1], mode: 'all' }).success).toBe(false);
  });

  it('takes exactly one id list, unique, 1 to 32, and nothing else', () => {
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker' }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker', worker_ids: [W1], request_ids: [R1] }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker', worker_ids: [] }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker', worker_ids: [W1, W1] }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker', worker_ids: [W1], mode: 'some' }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker', worker_ids: [W1], seconds: 60 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'timer', seconds: 60, worker_ids: [W1] }).success).toBe(false);
  });
});

describe('worker waits in the answers', () => {
  const workerOpen = { wait_id: WORKER_WAIT_ID, kind: 'worker' as const, deadline: '2026-10-19T10:10:00.000Z', summary: 'workers: 2 of 2 pending' };

  it('lists a worker wait with its deadline and answers its registration', () => {
    expect(openWaitSchema.parse(workerOpen)).toEqual(workerOpen);
    expect(openWaitSchema.safeParse({ ...workerOpen, deadline: undefined }).success).toBe(false);
    expect(cezarWaitAnswerSchema.parse({ ok: true, wait_id: WORKER_WAIT_ID, kind: 'worker', deadline: workerOpen.deadline, open_waits: [workerOpen] }).ok).toBe(true);
    expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: WORKER_WAIT_ID, kind: 'worker', open_waits: [] }).success).toBe(false);
  });

  it('refuses a worker the caller does not own with denied_scope', () => {
    expect(waitErrorCodeSchema.options).toContain('denied_scope');
    expect(cezarWaitAnswerSchema.parse({ ok: false, code: 'denied_scope', message: 'not your worker' }).ok).toBe(false);
  });
});

describe('workerWaitEntryToLegacy', () => {
  const outcome = { workerId: W1, status: 'done' as const, observedAt: '2026-10-19T10:03:00.000Z' };

  it('workerWaitEntryToLegacy projects each phase', () => {
    const table: ReadonlyArray<[string, Partial<WorkerWaitEntry>, { phase: string; reason?: string }]> = [
      ['open', {}, { phase: 'registered' }],
      ['resolved by outcome', { phase: 'resolved', result: { reason: 'outcome' } }, { phase: 'wake-pending', reason: 'outcome' }],
      ['resolved by timeout', { phase: 'resolved', result: { reason: 'timeout' } }, { phase: 'wake-pending', reason: 'timeout' }],
      ['delivered', { phase: 'delivered', result: { reason: 'outcome' } }, { phase: 'wake-pending', reason: 'outcome' }],
      ['cancelled', { phase: 'cancelled' }, { phase: 'wake-pending', reason: 'cancelled' }],
    ];
    for (const [name, over, expected] of table) {
      const legacy = workerWaitEntryToLegacy(openWorkerWait(over));
      expect(legacy, name).toMatchObject({ id: WORKER_WAIT_ID, workerIds: [W1, W2], mode: 'all', deadline: '2026-10-19T10:10:00.000Z', ...expected });
      if (expected.reason === undefined) expect(legacy.reason, name).toBeUndefined();
      expect(workerWaitSchema.safeParse(legacy).success, name).toBe(true);
    }
  });

  it('carries the ledger and revisions, and wakes with the queued input when an upgrade kept one', () => {
    const entry = openWorkerWait({ outcomes: [outcome] });
    expect(workerWaitEntryToLegacy(entry)).toMatchObject({ outcomes: [outcome], revisions: [{ workerId: W1, revision: 1 }], wakeId: WORKER_WAIT_ID });
    expect(workerWaitEntryToLegacy({ ...entry, wakeInputId: WAKE_INPUT }).wakeId).toBe(WAKE_INPUT);
  });

  it('projects a request wait with no worker ids', () => {
    const requestOutcomes = [{ requestId: R1, status: 'replied' as const, observedAt: '2026-10-19T10:02:00.000Z' }];
    const legacy = workerWaitEntryToLegacy(openRequestWait({ requestOutcomes }));
    expect(legacy).toMatchObject({ workerIds: [], requestIds: [R1], requestOutcomes, outcomes: [], phase: 'registered' });
    expect(workerWaitSchema.safeParse(legacy).success).toBe(true);
  });
});

describe('deadline-less cezar worker entries (hearsay-tools/cezarion#1301)', () => {
  const targets = { workerIds: [W1], revisions: [], outcomes: [] };

  it('a cezar worker entry may omit deadline and timeoutSeconds', () => {
    const entry = { ...workerBase(targets), source: 'cezar', via: 'completion', deadline: undefined, timeoutSeconds: undefined };
    expect(workerWaitEntrySchema.safeParse(entry).success).toBe(true);
  });

  it('an agent worker entry still requires deadline and timeoutSeconds', () => {
    const result = workerWaitEntrySchema.safeParse({ ...workerBase(targets), source: 'agent', deadline: undefined, timeoutSeconds: undefined });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain('deadline');
  });

  it('a cezar entry with only one of deadline and timeoutSeconds is refused', () => {
    const cezar = { ...workerBase(targets), source: 'cezar', via: 'completion' };
    expect(workerWaitEntrySchema.safeParse({ ...cezar, timeoutSeconds: undefined }).success).toBe(false);
    expect(workerWaitEntrySchema.safeParse({ ...cezar, deadline: undefined }).success).toBe(false);
    expect(workerWaitEntrySchema.safeParse(cezar).success).toBe(true);
  });

  it('a deadline-less worker entry is reported without a deadline, and the CI deadline stands alone', () => {
    const bare = workerWaitEntrySchema.parse({ ...workerBase(targets), source: 'cezar', via: 'completion', deadline: undefined, timeoutSeconds: undefined });
    const ci = openCi();
    // Workers keep their priority over CI: the bare entry wins and carries no deadline.
    expect(resolveWaitingOn({ waits: [bare, ci] })).toEqual({ kind: 'workers', count: 1 });
    expect(resolveWaitingOn({ waits: [bare] })).toEqual({ kind: 'workers', count: 1 });
    expect(computeWaitingOn({ waits: [ci] })).toMatchObject({ kind: 'pr', deadline: ci.deadline });
  });

  it('the legacy WorkerWait shape still requires a deadline, and renders only deadlined entries', () => {
    const legacy = { id: WORKER_WAIT_ID, workerIds: [W1], phase: 'registered', outcomes: [] };
    expect(workerWaitSchema.safeParse({ ...legacy, deadline: '2026-10-19T10:10:00.000Z' }).success).toBe(true);
    expect(workerWaitSchema.safeParse(legacy).success).toBe(false);
    const bare = workerWaitEntrySchema.parse({ ...workerBase(targets), source: 'cezar', via: 'completion', deadline: undefined, timeoutSeconds: undefined });
    expect(hasWorkerDeadline(bare)).toBe(false);
    expect(workerWaitView({ waits: [bare], delegation: { role: 'root' } as never })).toBeUndefined();
  });

  // Inspection and the relationships view still show the parent's wait while it parks on Cezar's
  // completion wait, which has no deadline (hearsay-tools/cezarion#1301).
  it('projects a deadline-less completion entry for inspection and the relationships view', () => {
    const bare = workerWaitEntrySchema.parse({ ...workerBase(targets), source: 'cezar', via: 'completion', mode: 'all', deadline: undefined, timeoutSeconds: undefined });
    const root = { role: 'root' } as never;
    const view = completionWaitView({ waits: [bare], delegation: root });
    expect(view).toEqual({ id: bare.id, via: 'completion', workerIds: [W1], mode: 'all', phase: 'registered', outcomes: [], wakeId: bare.id });
    expect(workerCompletionWaitSchema.safeParse(view).success).toBe(true);
    expect(completionWaitView({ status: 'waiting', waits: [bare], delegation: root })?.phase).toBe('parked');
    expect(completionWaitView({ status: 'waiting', waits: [bare, openHuman()], delegation: root })?.phase).toBe('registered');
    expect(completionWaitView({ waits: [{ ...bare, phase: 'resolved', result: { reason: 'outcome' } }], delegation: root })).toMatchObject({ phase: 'wake-pending', reason: 'outcome' });
    // A deadlined entry, an upgraded completion wait included, is the legacy view's.
    expect(completionWaitView({ waits: [workerWaitEntrySchema.parse(workerBase(targets))], delegation: root })).toBeUndefined();
    expect(completionWaitView({ waits: [bare] })).toBeUndefined();
    // The projection carries no deadline, and the legacy shape keeps requiring one.
    expect(workerCompletionWaitSchema.safeParse({ ...view, deadline: '2026-10-19T10:10:00.000Z' }).success).toBe(false);
    const inspection = { workerId: W1, parentRunId: WORKER_WAIT_ID, status: 'running',
      workspace: { ownerRunId: W1, resourceId: W1, kind: 'owned-isolated', path: '/w', branch: 'cez/w', baselineSha: 'a'.repeat(40) } };
    expect(workerInspectionSchema.safeParse({ ...inspection, completionWait: view }).success).toBe(true);
    expect(workerInspectionSchema.safeParse({ ...inspection, wait: view }).success).toBe(false);
  });
});

describe('computeWaitingOn with worker entries', () => {
  it('an open worker entry names workers, above CI and timer, below usage limit and human', () => {
    const waits = [openCi(), openTimer(), openWorkerWait()];
    expect(computeWaitingOn({ waits })).toEqual({ kind: 'workers', count: 2 });
    expect(computeWaitingOn({ waits: [openWorkerWait({ phase: 'resolved' })] })).toBeUndefined();
    expect(computeWaitingOn({ status: 'waiting', waits, autoResumeAt: '2026-10-19T12:00:00.000Z' })?.kind).toBe('usage-limit');
    expect(waitingOnSchema.parse(computeWaitingOn({ waits }))).toEqual({ kind: 'workers', count: 2 });
  });

  it("counts a request wait by the requests without an outcome, and adds Cezar's completion wait", () => {
    const answered = [{ requestId: R1, status: 'replied' as const, observedAt: '2026-10-19T10:02:00.000Z' }];
    // Only request entries open: `replies` lets a summary say "worker replies" (hearsay-tools/cezarion#1235).
    expect(computeWaitingOn({ waits: [openRequestWait()] })).toEqual({ kind: 'workers', count: 1, replies: true });
    expect(computeWaitingOn({ waits: [openRequestWait({ requestOutcomes: answered })] })).toEqual({ kind: 'workers', count: 0, replies: true });
    expect(computeWaitingOn({ waits: [openWorkerWait(), ...completionWaits()] })).toEqual({ kind: 'workers', count: 4 });
    expect(computeWaitingOn({ waits: [openRequestWait(), ...completionWaits()] })).toEqual({ kind: 'workers', count: 3 });
  });
});

// Review of #1437: Cezar's worker fallback is a real question (it carries `questions`), so
// `cez task status` and the webhook's `task.question` must see it; its other waits ask nothing.
describe('asksQuestion', () => {
  const human = (over: Record<string, unknown>) => ({ id: '00000000-0000-4000-8000-0000000000ac', kind: 'human', source: 'agent', via: 'cezar_ask',
    registeredAt: '2026-10-21T00:00:00.000Z', phase: 'open', turnId: 't', ...over }) as unknown as NonNullable<RunRecord['waits']>[number];
  it('is true for the agent\'s question and for Cezar\'s fallback question, false for Cezar\'s plain waits', () => {
    expect(asksQuestion({ waits: [human({})] })).toBe(true);
    expect(asksQuestion({ waits: [human({ source: 'cezar', via: 'no-wait', questions: [{ header: 'Worker', question: 'What next?' }] })] })).toBe(true);
    expect(asksQuestion({ waits: [human({ source: 'cezar', via: 'no-wait' })] })).toBe(false);
    expect(asksQuestion({ waits: [human({ source: 'cezar', via: 'budget' })] })).toBe(false);
    expect(asksQuestion({ waits: [human({ phase: 'resolved' })] })).toBe(false);
    expect(asksQuestion({})).toBe(false);
  });
});

// hearsay-tools/cezarion#1446: a background command the agent started, watched by its PID.
describe('process waits', () => {
  it('parses a full entry and refuses a PID below 2 or a stray key', () => {
    const full = openProcess({ startToken: 'boot:123', exitFile: '/tmp/x/build.exit', note: 'build',
      phase: 'resolved', resolvedAt: '2026-10-17T15:10:00.000Z', result: { outcome: 'exit_file', observedAt: '2026-10-17T15:10:00.000Z', exitCode: 0 } });
    expect(processWaitEntrySchema.parse(full)).toEqual(full);
    expect(waitSchema.parse(openProcess())).toEqual(openProcess());
    expect(processWaitEntrySchema.safeParse(openProcess({ pid: 1 })).success).toBe(false);
    expect(processWaitEntrySchema.safeParse({ ...openProcess(), extra: 1 }).success).toBe(false);
    expect(processWaitEntrySchema.safeParse(openProcess({ result: { outcome: 'exited', observedAt: '2026-10-17T15:10:00.000Z', exitCode: 2 ** 31 } })).success).toBe(false);
  });

  it('defaults the timeout to 1800 and bounds it to 7200', () => {
    expect(PROCESS_TIMEOUT_DEFAULT_SECONDS).toBe(1800);
    expect(cezarWaitRequestSchema.parse({ kind: 'process', pid: 42 })).toEqual({ kind: 'process', pid: 42, timeout_seconds: 1800 });
    expect(cezarWaitRequestSchema.parse({ kind: 'process', pid: 42, exit_file: 'x.exit', note: 'n', timeout_seconds: 7200 }))
      .toEqual({ kind: 'process', pid: 42, exit_file: 'x.exit', note: 'n', timeout_seconds: 7200 });
    expect(cezarWaitRequestSchema.safeParse({ kind: 'process', pid: 42, timeout_seconds: 7201 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'process', pid: 1 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'process', pid: 42, exit_file: 'x'.repeat(4097) }).success).toBe(false);
  });

  it('ranks after a PR wait and before a timer in waitingOn', () => {
    const ci = { ...openCi(), kind: 'pr' as const, until: 'checks' as const, wakeOnConflict: true };
    const timer = openTimer();
    const process = openProcess({ note: 'build' });
    expect(computeWaitingOn({ waits: [timer, process, ci] })?.kind).toBe('pr');
    expect(computeWaitingOn({ waits: [timer, process] })).toEqual({ kind: 'process', waitId: PROCESS_ID, pid: 4242, deadline: process.deadline, note: 'build' });
    expect(waitingOnSchema.parse(computeWaitingOn({ waits: [openProcess()] }))).toEqual({ kind: 'process', waitId: PROCESS_ID, pid: 4242, deadline: process.deadline });
  });

  it('answers with the process kind, its deadline and its refusals', () => {
    expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: PROCESS_ID, kind: 'process', deadline: '2026-10-17T15:30:00.000Z', open_waits: [
      { wait_id: PROCESS_ID, kind: 'process', deadline: '2026-10-17T15:30:00.000Z', summary: 'process 4242' }] }).success).toBe(true);
    for (const code of ['exit_file_outside', 'process_not_allowed', 'process_not_owned']) {
      expect(cezarWaitAnswerSchema.safeParse({ ok: false, code, message: 'no' }).success).toBe(true);
    }
  });
});

// hearsay-tools/cezarion#1425: kind "pr" replaces kind "ci" and adds the merge target.
describe('PR waits', () => {
  const pr = 'https://github.com/o/r/pull/1';
  const openPr = (over: Record<string, unknown> = {}) => ({ ...openCi(), kind: 'pr', until: 'checks' as const, wakeOnConflict: true, ...over });

  it('defaults a pr request to the checks target, conflicts waking, 1800 seconds', () => {
    expect(cezarWaitRequestSchema.parse({ kind: 'pr', pr })).toEqual({ kind: 'pr', pr, until: 'checks', wake_on_conflict: true, timeout_seconds: 1800 });
    expect(cezarWaitRequestSchema.parse({ kind: 'pr', pr, until: 'merge', wake_on_conflict: false, timeout_seconds: 7200 }))
      .toEqual({ kind: 'pr', pr, until: 'merge', wake_on_conflict: false, timeout_seconds: 7200 });
  });

  it('refuses kind ci, an unknown target and merge waits past 7200 seconds', () => {
    expect(cezarWaitRequestSchema.safeParse({ kind: 'ci', pr }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'pr', pr, until: 'land' }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'pr', pr, until: 'merge', timeout_seconds: 7201 }).success).toBe(false);
  });

  it('stores until and wakeOnConflict on a pr entry, both required', () => {
    expect(waitSchema.parse(openPr({ until: 'merge', wakeOnConflict: false }))).toMatchObject({ kind: 'pr', until: 'merge', wakeOnConflict: false });
    const { until: _until, ...noTarget } = openPr();
    expect(waitSchema.safeParse(noTarget).success).toBe(false);
  });

  it('accepts merged and closed outcomes with the merge facts', () => {
    const result = { outcome: 'merged', headSha: HEAD, observedAt: '2026-10-17T15:20:00.000Z', checks: [], totalChecks: 0, truncated: false,
      mergedAt: '2026-10-17T15:19:00Z', mergeCommitSha: 'b'.repeat(40) };
    expect(waitSchema.parse(openPr({ until: 'merge', phase: 'resolved', result }))).toMatchObject({ result: { outcome: 'merged' } });
    expect(waitSchema.safeParse(openPr({ phase: 'resolved', result: { ...result, outcome: 'closed', mergedAt: undefined, mergeCommitSha: undefined } })).success).toBe(true);
  });

  it('names the target in waitingOn', () => {
    expect(computeWaitingOn({ waits: [openPr({ until: 'merge' }) as never] })).toMatchObject({ kind: 'pr', until: 'merge', prNumber: 12 });
  });

  it('reads a stored ci waitingOn as a pr checks wait', () => {
    expect(waitingOnSchema.parse({ kind: 'ci', waitId: CI_ID, prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, deadline: '2026-10-17T15:40:00.000Z' }))
      .toEqual({ kind: 'pr', until: 'checks', waitId: CI_ID, prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, deadline: '2026-10-17T15:40:00.000Z' });
  });
});

// hearsay-tools/cezarion#1995, spec 2026-10-27-task-communication-protocol § 7.
describe('peer waits', () => {
  const P1 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc1';
  const P2 = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2';
  const peerBase = (over: Record<string, unknown> = {}) => ({
    kind: WAIT_KIND.peer, id: WORKER_WAIT_ID, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, registeredAt: '2026-10-19T10:00:00.000Z',
    deadline: '2026-10-19T10:10:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1', timeoutSeconds: 600, peerIds: [P1], ...over,
  });

  it('stores 1 to 32 named peers with a required deadline of 1 to 1800 seconds and a reason once resolved', () => {
    expect(waitSchema.safeParse(peerBase()).success).toBe(true);
    expect(waitSchema.safeParse(peerBase({ via: WAIT_VIA['cez-message-wait'] })).success).toBe(true);
    expect(waitSchema.safeParse(peerBase({ deadline: undefined })).success).toBe(false);
    expect(waitSchema.safeParse(peerBase({ peerIds: [] })).success).toBe(false);
    expect(waitSchema.safeParse(peerBase({ timeoutSeconds: 1801 })).success).toBe(false);
    for (const result of [{ reason: 'message', peerRunId: P1, messageId: R1 }, { reason: 'settled', peerRunId: P1 }, { reason: 'timeout' }]) {
      expect(peerWaitEntrySchema.safeParse(peerBase({ phase: WAIT_PHASE.resolved, resolvedAt: '2026-10-19T10:05:00.000Z', result })).success).toBe(true);
    }
    expect(peerWaitEntrySchema.safeParse(peerBase({ result: { reason: 'outcome' } })).success).toBe(false);
  });

  it('refuses a result that does not fit its reason, and a phase that does not fit its result', () => {
    const resolved = (result: unknown) => peerBase({ phase: WAIT_PHASE.resolved, resolvedAt: '2026-10-19T10:05:00.000Z', result });
    for (const result of [{ reason: 'message' }, { reason: 'message', peerRunId: P1 }, { reason: 'settled' }, { reason: 'timeout', peerRunId: P1 }, { reason: 'timeout', messageId: R1 }]) {
      expect(peerWaitEntrySchema.safeParse(resolved(result)).success).toBe(false);
    }
    // Resolved and delivered carry their result; open has none; cancelled may keep one it had.
    expect(peerWaitEntrySchema.safeParse(peerBase({ phase: WAIT_PHASE.resolved, resolvedAt: '2026-10-19T10:05:00.000Z' })).success).toBe(false);
    expect(peerWaitEntrySchema.safeParse(peerBase({ result: { reason: 'timeout' } })).success).toBe(false);
    expect(peerWaitEntrySchema.safeParse(peerBase({ phase: WAIT_PHASE.cancelled, cancelledAt: '2026-10-19T10:05:00.000Z' })).success).toBe(true);
    const view = { id: WORKER_WAIT_ID, peerIds: [P1], deadline: '2026-10-19T10:10:00.000Z' };
    expect(peerWaitViewSchema.safeParse({ ...view, phase: WAIT_PHASE.resolved }).success).toBe(false);
    expect(peerWaitViewSchema.safeParse({ ...view, phase: WAIT_PHASE.open, result: { reason: 'timeout' } }).success).toBe(false);
    expect(peerWaitViewSchema.safeParse({ ...view, phase: WAIT_PHASE.delivered, result: { reason: 'message', peerRunId: P1 } }).success).toBe(false);
    expect(peerWaitViewSchema.safeParse({ ...view, phase: WAIT_PHASE.delivered, result: { reason: 'settled', peerRunId: P1 } }).success).toBe(true);
  });

  it('reads as waiting on peers, counted once each, below workers and above a PR', () => {
    const peers = peerBase({ peerIds: [P1, P2] }) as never;
    const again = peerBase({ id: WAKE_INPUT, peerIds: [P2] }) as never;
    expect(computeWaitingOn({ waits: [peers, again] })).toEqual({ kind: 'peers', count: 2 });
    expect(computeWaitingOn({ waits: [openCi(), openTimer(), peers] })?.kind).toBe('peers');
    expect(computeWaitingOn({ waits: [peers, ...completionWaits()] })?.kind).toBe('workers');
    expect(computeWaitingOn({ waits: [peers, openHuman()] })?.kind).toBe('human');
    expect(waitingOnSchema.parse({ kind: 'peers', count: 1 })).toEqual({ kind: 'peers', count: 1 });
  });

  it('marks a request wait on a peer request, read from the root ledger', () => {
    const wait = workerBase({ requestIds: [R1], requestOutcomes: [] }) as never;
    const message = { id: R1, senderRunId: W1, recipientRunId: W2, kind: 'request', text: 'q', createdAt: '2026-10-19T10:00:00.000Z', requestHash: 'a'.repeat(64), state: 'accepted' };
    const root = (relationship?: 'peer') => { return { role: 'root', receipts: [], permissions: [], conversation: { messages: [{ ...message, ...(relationship ? { relationship } : {}) }], outcomes: [] } } as never; };
    expect(computeWaitingOn({ waits: [wait], delegation: root('peer') })).toEqual({ kind: 'workers', count: 1, replies: true, peers: true });
    expect(computeWaitingOn({ waits: [wait], delegation: root() })).toEqual({ kind: 'workers', count: 1, replies: true });
  });

  // A list row reads the summary, whose slim delegation carries no ledger: the projection keeps
  // the peer marker it read from the full record.
  it('keeps the peer marker and its label through toRunSummary, and reads a malformed ledger as none', () => {
    const wait = workerBase({ requestIds: [R1], requestOutcomes: [] }) as never;
    const message = { id: R1, senderRunId: W1, recipientRunId: W2, kind: 'request', relationship: 'peer', text: 'q', createdAt: '2026-10-19T10:00:00.000Z', requestHash: 'a'.repeat(64), state: 'accepted' };
    const record = (conversation: unknown) => makeRunRecord({ status: RUN_STATUS.waiting, waits: [wait],
      delegation: { role: 'root', receipts: [], permissions: [], conversation } as never });
    const summary = toRunSummary(record({ messages: [message], outcomes: [] }));
    expect(summary.waitingOn).toEqual({ kind: 'workers', count: 1, replies: true, peers: true });
    expect(deriveAttention(summary).label).toBe('waiting on replies');
    for (const malformed of [{ messages: [null, 7] }, { messages: 'none' }, 'ledger']) {
      expect(toRunSummary(record(malformed)).waitingOn).toEqual({ kind: 'workers', count: 1, replies: true });
    }
  });

  it('answers cez message wait --peer with its phase and result', () => {
    const entry = peerWaitEntrySchema.parse(peerBase({ phase: WAIT_PHASE.resolved, resolvedAt: '2026-10-19T10:05:00.000Z', result: { reason: 'message', peerRunId: P1, messageId: R1 } }));
    expect(peerWaitView(entry)).toEqual({ id: WORKER_WAIT_ID, peerIds: [P1], deadline: '2026-10-19T10:10:00.000Z', phase: WAIT_PHASE.resolved, result: { reason: 'message', peerRunId: P1, messageId: R1 } });
  });

  it('lists an open peer wait with its deadline and answers its registration', () => {
    const open = { wait_id: WORKER_WAIT_ID, kind: WAIT_KIND.peer, deadline: '2026-10-19T10:10:00.000Z', summary: 'peer wait on 1 task' };
    expect(openWaitSchema.parse(open)).toEqual(open);
    for (const kind of [WAIT_KIND.peer, 'request'] as const) {
      expect(cezarWaitAnswerSchema.parse({ ok: true, wait_id: WORKER_WAIT_ID, kind, deadline: open.deadline, open_waits: [open] }).ok).toBe(true);
    }
  });
});

// Callers render the newest eligible wait, rather than a delivered or cancelled entry.
describe('worker wait guard selection', () => {
  const delegation = makeRunRecord().delegation ?? { role: 'root' as const, permissions: [], receipts: [] };

  it('requires valid delegation and an eligible entry', () => {
    const waits = [openWorkerWait()];
    expect(workerWaitView({ waits })).toBeUndefined();
    expect(workerWaitView({ waits, delegation: { role: 'invalid' } })).toBeUndefined();
    expect(workerWaitView({ delegation })).toBeUndefined();
    expect(workerWaitView({ waits: [], delegation })).toBeUndefined();
  });

  it('keeps the newest open or resolved worker entry with a deadline', () => {
    const first = openWorkerWait();
    const newest = openRequestWait({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', phase: WAIT_PHASE.resolved, result: { reason: 'timeout' } });
    const ignored = [openTimer(), openWorkerWait({ phase: WAIT_PHASE.delivered }), openWorkerWait({ phase: WAIT_PHASE.cancelled }), ...completionWaits()];
    expect(workerWaitView({ waits: [first, newest, ...ignored], delegation }))
      .toEqual(workerWaitEntryToLegacy(newest));
    expect(workerWaitView({ waits: ignored, delegation })).toBeUndefined();
  });

  it('parks only open waits on a waiting run without a human wait', () => {
    const entry = openWorkerWait();
    const legacy = workerWaitEntryToLegacy(entry);
    expect(workerWaitView({ waits: [entry], delegation, status: RUN_STATUS.waiting })).toEqual({ ...legacy, phase: 'parked' });
    expect(workerWaitView({ waits: [entry], delegation, status: RUN_STATUS.running })).toEqual(legacy);
    expect(workerWaitView({ waits: [entry, openHuman()], delegation, status: RUN_STATUS.waiting })).toEqual(legacy);
    const resolved = openWorkerWait({ phase: WAIT_PHASE.resolved, result: { reason: 'outcome' } });
    expect(workerWaitView({ waits: [resolved], delegation, status: RUN_STATUS.waiting })).toEqual(workerWaitEntryToLegacy(resolved));
  });
});

describe('wait guard outputs', () => {
  it.each(['worker', 'request'] as const)('names the mode error for a multi-id %s request', kind => {
    const target = kind === 'worker' ? { worker_ids: [W1, W2] } : { request_ids: [R1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'] };
    const result = cezarWaitRequestSchema.safeParse({ kind, ...target, mode: 'one' });
    expect(result.error?.issues).toContainEqual({ code: 'custom', message: 'one mode requires exactly one id', path: ['mode'] });
    for (const mode of [undefined, 'all', 'any']) {
      expect(cezarWaitRequestSchema.safeParse({ kind, ...target, mode }).success).toBe(true);
    }
    const single = kind === 'worker' ? { worker_ids: [W1] } : { request_ids: [R1] };
    expect(cezarWaitRequestSchema.safeParse({ kind, ...single, mode: 'one' }).success).toBe(true);
  });

  it('counts only matching outcomes, including fully answered and sparse streamed entries', () => {
    const observedAt = '2026-10-19T10:02:00.000Z';
    const wait = openWorkerWait({ outcomes: [{ workerId: W1, status: RUN_STATUS.done, observedAt }, { workerId: '99999999-9999-4999-8999-999999999993', status: RUN_STATUS.done, observedAt }] });
    expect(computeWaitingOn({ waits: [wait] })).toEqual({ kind: 'workers', count: 1 });
    expect(computeWaitingOn({ waits: [openRequestWait({ requestIds: [R1, 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'], requestOutcomes: [{ requestId: R1, status: 'replied', observedAt }] })] }))
      .toEqual({ kind: 'workers', count: 1, replies: true });
    expect(computeWaitingOn({ waits: [openWorkerWait({ outcomes: [W1, W2].map(workerId => ({ workerId, status: RUN_STATUS.done, observedAt })) })] }))
      .toEqual({ kind: 'workers', count: 0 });
    expect(computeWaitingOn({ waits: [{ ...wait, outcomes: undefined }] })).toEqual({ kind: 'workers', count: 2 });
    expect(computeWaitingOn({ waits: [{ ...wait, workerIds: undefined, outcomes: undefined }] })).toEqual({ kind: 'workers', count: 0 });
    expect(computeWaitingOn({ waits: [{ ...openRequestWait(), requestOutcomes: undefined }] })).toEqual({ kind: 'workers', count: 1, replies: true });
  });

  it('ignores malformed wait collections and exposes the complete earliest process or timer', () => {
    expect(computeWaitingOn({ waits: 'unparsed' as never })).toBeUndefined();
    expect(computeWaitingOn({ waits: [null, undefined] as never })).toBeUndefined();
    const process = openProcess({ note: '' });
    const later = openProcess({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2', deadline: '2026-10-18T00:00:00.000Z', pid: 9999 });
    expect(computeWaitingOn({ waits: [later, process] })).toEqual({ kind: WAIT_KIND.process, waitId: process.id, pid: process.pid, deadline: process.deadline, note: '' });
    const timer = openTimer({ note: '' });
    expect(computeWaitingOn({ waits: [openTimer({ deadline: later.deadline }), timer] })).toEqual({ kind: WAIT_KIND.timer, waitId: timer.id, at: timer.deadline, note: '' });
    expect(computeWaitingOn({ waits: [openHuman({ askSeq: 0 })] })).toEqual({ kind: WAIT_KIND.human, shown: true });
  });
});

describe('completion projection boundaries', () => {
  it('selects only the newest eligible completion entry for the requested worker', () => {
    const first = completionWaits()[0]!;
    const newest = { ...first, id: R1, workerIds: [W1] };
    const excluded = [openTimer(), openWorkerWait({ via: WAIT_VIA.completion }),
      { ...newest, via: WAIT_VIA.cezar_wait }, { ...newest, phase: WAIT_PHASE.delivered }, { ...newest, phase: WAIT_PHASE.cancelled }];
    expect(completionWaitEntry([first, newest, ...excluded])).toEqual(newest);
    expect(completionWaitEntry([first, newest], W1)).toEqual(newest);
    expect(completionWaitEntry([first, newest], W2)).toBeUndefined();
    expect(completionWaitEntry(undefined)).toBeUndefined();
    expect(completionWaitEntry([{ ...newest, phase: WAIT_PHASE.resolved }])).toEqual({ ...newest, phase: WAIT_PHASE.resolved });
  });

  it('preserves completion evidence and omits absent optional fields', () => {
    const entry = { ...completionWaits()[0]!, workerIds: [W1], mode: 'any' as const,
      revisions: [{ workerId: W1, revision: 3 }], outcomes: [{ workerId: W1, status: RUN_STATUS.done, observedAt: '2026-10-30T12:00:00Z' }], wakeInputId: WAKE_INPUT };
    const expected = { id: entry.id, via: WAIT_VIA.completion, workerIds: [W1], mode: 'any', revisions: entry.revisions,
      outcomes: entry.outcomes, wakeId: WAKE_INPUT, phase: 'registered' };
    expect(workerCompletionWaitProjection(entry, {})).toEqual(expected);
    expect(workerCompletionWaitProjection(entry, { status: RUN_STATUS.waiting })).toEqual({ ...expected, phase: 'parked' });
    expect(workerCompletionWaitProjection(entry, { status: RUN_STATUS.waiting, waits: [openHuman()] })).toEqual(expected);
    expect(workerCompletionWaitProjection({ ...entry, phase: WAIT_PHASE.cancelled }, {})).toEqual({ ...expected, phase: 'wake-pending', reason: 'cancelled' });
    expect(workerCompletionWaitProjection({ ...entry, phase: WAIT_PHASE.resolved, result: { reason: 'timeout' } }, {}))
      .toEqual({ ...expected, phase: 'wake-pending', reason: 'timeout' });
    const sparse = { ...entry, workerIds: undefined, outcomes: undefined, mode: undefined, revisions: undefined, wakeInputId: undefined };
    expect(workerCompletionWaitProjection(sparse, {})).toEqual({ id: entry.id, via: WAIT_VIA.completion, workerIds: [], outcomes: [], wakeId: entry.id, phase: 'registered' });
  });
});

describe('peer request ledger boundaries', () => {
  it('uses only string ids on peer requests and retains only a root ledger', () => {
    const slim = { role: 'root' as const };
    const conversation = { messages: [null, 7, { id: R1, kind: 'request', relationship: 'peer' },
      { id: W1, kind: 'progress', relationship: 'peer' }, { id: W2, kind: 'request', relationship: 'family' },
      { id: 7, kind: 'request', relationship: 'peer' }] };
    const root = withRootLedger(slim, { role: 'root', conversation });
    expect(root).toEqual({ ...slim, conversation });
    expect(requestsToPeers(root, [R1])).toBe(true);
    expect(requestsToPeers(root, [W1, W2, '7'])).toBe(false);
    expect(requestsToPeers(root, undefined)).toBe(false);
    for (const raw of [undefined, null, 'root', { role: 'worker', conversation }]) {
      expect(withRootLedger(slim, raw)).toEqual(slim);
      expect(requestsToPeers(withRootLedger(slim, raw), [R1])).toBe(false);
    }
    expect(withRootLedger(undefined, { role: 'root', conversation })).toBeUndefined();
    const invalid = { role: 'invalid' as const };
    expect(withRootLedger(invalid, { role: 'root', conversation })).toEqual(invalid);
  });
});
