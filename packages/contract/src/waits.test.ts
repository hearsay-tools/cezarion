import { describe, expect, it } from 'vitest';
import type { RunRecord } from './runs.ts';
import {
  cezarCancelWaitAnswerSchema,
  cezarDoneAnswerSchema,
  cezarDoneRequestSchema,
  cezarCancelWaitRequestSchema,
  cezarWaitAnswerSchema,
  cezarWaitRequestSchema,
  computeWaitingOn,
  LAST_WAITS_LIMIT,
  resolveWaitingOn,
  TIMER_MAX_SECONDS,
  TIMER_MIN_SECONDS,
  WAIT_LIMIT,
  waitErrorCodeSchema,
  waitingOnSchema,
  waitSchema,
  type CiWaitEntry,
  type HumanWaitEntry,
  type TimerWaitEntry,
} from './waits.ts';

/**
 * The wait list (spec 2026-10-17-unified-waits, phase 1: hearsay-tools/cezarion#1233). The
 * schemas are the stored and model-facing shapes; `computeWaitingOn` is the one function that
 * names the run's top open wait, so its order is pinned here rather than in each reader.
 */

const CI_ID = '11111111-1111-4111-8111-111111111111';
const TIMER_ID = '22222222-2222-4222-8222-222222222222';
const HEAD = 'a'.repeat(40);

function openCi(over: Partial<CiWaitEntry> = {}): CiWaitEntry {
  return {
    kind: 'ci',
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
    timeoutSeconds: 1800,
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

const HUMAN_ID = '66666666-6666-4666-8666-666666666666';
const CARD = [{ header: 'Library', question: 'Which test library?', options: [{ label: 'Vitest' }, { label: 'Node test' }] }];

function openHuman(over: Partial<HumanWaitEntry> = {}): HumanWaitEntry {
  return {
    kind: 'human',
    id: HUMAN_ID,
    source: 'agent',
    via: 'cezar_wait',
    registeredAt: '2026-10-17T15:20:00.000Z',
    phase: 'open',
    turnId: 'turn-1',
    ...over,
  };
}

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
  });
});

describe('computeWaitingOn', () => {
  it('orders waitingOn human > usage limit > workers > CI > timer', () => {
    const ci = openCi({ deadline: '2026-10-17T15:40:00.000Z' });
    const timer = openTimer({ deadline: '2026-10-17T15:05:00.000Z' });
    expect(computeWaitingOn({ waits: [timer, ci] })?.kind).toBe('ci');
    expect(computeWaitingOn({ waits: [timer] })?.kind).toBe('timer');
    expect(computeWaitingOn({ waits: [ci], delegation: parkedRootWait() })?.kind).toBe('workers');
    expect(computeWaitingOn({ waits: [ci], autoResumeAt: '2026-10-17T16:00:00.000Z' })?.kind).toBe('usage-limit');
    expect(computeWaitingOn({ waits: [ci], hasPendingHumanAsk: true })?.kind).toBe('human');
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
      kind: 'ci', waitId: CI_ID, prUrl: early.prUrl, repository: 'o/r', prNumber: 12, deadline: '2026-10-17T15:30:00Z',
    });
    const laterTimer = openTimer({ id: '77777777-7777-4777-8777-777777777777', deadline: '2026-10-17T15:50:00.000Z' });
    expect(computeWaitingOn({ waits: [laterTimer, openTimer({ note: 'deploy' })] })).toEqual({
      kind: 'timer', waitId: TIMER_ID, at: '2026-10-17T15:05:00.000Z', note: 'deploy',
    });
  });

  it('carries the usage-limit instant and the count of workers still owed', () => {
    expect(computeWaitingOn({ autoResumeAt: '2026-10-17T16:00:00.000Z' })).toEqual({ kind: 'usage-limit', at: '2026-10-17T16:00:00.000Z' });
    expect(computeWaitingOn({ delegation: parkedRootWait() })).toEqual({ kind: 'workers', count: 2 });
  });

  it('counts a worker wait that is still open, not one whose wake is already queued', () => {
    const delegation = (phase: string) => {
      const root = parkedRootWait() as { wait: Record<string, unknown> };
      return { ...root, wait: { ...root.wait, phase } } as unknown as RunRecord['delegation'];
    };
    expect(computeWaitingOn({ delegation: delegation('registered') })?.kind).toBe('workers');
    expect(computeWaitingOn({ delegation: delegation('wake-pending'), waits: [openCi()] })?.kind).toBe('ci');
    expect(computeWaitingOn({ delegation: { role: 'invalid' }, waits: [openCi()] })?.kind).toBe('ci');
  });

  it('produces values the waitingOn schema accepts', () => {
    for (const input of [
      { hasPendingHumanAsk: true },
      { autoResumeAt: '2026-10-17T16:00:00.000Z' },
      { delegation: parkedRootWait() },
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
    expect(resolveWaitingOn({ waits: [openCi()] })?.kind).toBe('ci');
    expect(resolveWaitingOn({})).toBeUndefined();
  });
});

describe('cezar_wait request', () => {
  it('accepts the ci, timer and human request shapes and refuses the rest', () => {
    expect(cezarWaitRequestSchema.parse({ kind: 'ci', pr: 'https://github.com/o/r/pull/1' })).toMatchObject({ timeout_seconds: 1800 });
    expect(cezarWaitRequestSchema.safeParse({ kind: 'timer', seconds: 59 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'timer', seconds: 7201 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'worker' }).success).toBe(false); // phase 3
  });

  it('keeps the ci bounds of cezar_wait_for_ci and refuses stray keys', () => {
    expect(cezarWaitRequestSchema.safeParse({ kind: 'ci', pr: 'https://github.com/o/r/pull/1', timeout_seconds: 0 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'ci', pr: 'https://github.com/o/r/pull/1', timeout_seconds: 7201 }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'ci', pr: 'https://example.com/nope' }).success).toBe(false);
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
  const openWait = { wait_id: CI_ID, kind: 'ci' as const, deadline: '2026-10-17T15:40:00.000Z', summary: 'CI on o/r#12' };

  it('parses accepted and refused cezar_wait answers', () => {
    expect(cezarWaitAnswerSchema.parse({ ok: true, wait_id: CI_ID, kind: 'ci', deadline: openWait.deadline, open_waits: [openWait] }).ok).toBe(true);
    expect(cezarWaitAnswerSchema.parse({ ok: false, code: 'timers_disabled', message: 'no timers' }).ok).toBe(false);
    expect(cezarWaitAnswerSchema.safeParse({ ok: false, code: 'not_a_code', message: 'x' }).success).toBe(false);
    expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: CI_ID, kind: 'ci', deadline: openWait.deadline }).success).toBe(false);
  });

  // hearsay-tools/cezarion#1234: a CI or timer wait always carries its deadline; a human wait never does.
  it('ties the deadline to the kind, in the answer and in every open wait', () => {
    const human = { wait_id: CI_ID, kind: 'human' as const, summary: 'human: Which module?' };
    expect(cezarWaitAnswerSchema.parse({ ok: true, wait_id: CI_ID, kind: 'human', open_waits: [human] }).ok).toBe(true);
    expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: CI_ID, kind: 'human', deadline: openWait.deadline, open_waits: [] }).success).toBe(false);
    for (const kind of ['ci', 'timer'] as const) {
      expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: CI_ID, kind, open_waits: [] }).success).toBe(false);
      expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: CI_ID, kind, deadline: openWait.deadline, open_waits: [{ ...openWait, kind, deadline: undefined }] }).success).toBe(false);
    }
    expect(cezarWaitAnswerSchema.safeParse({ ok: true, wait_id: CI_ID, kind: 'ci', deadline: openWait.deadline, open_waits: [{ ...human, deadline: openWait.deadline }] }).success).toBe(false);
    expect(cezarCancelWaitAnswerSchema.safeParse({ cancelled: true, wait_id: CI_ID, open_waits: [{ ...human, deadline: openWait.deadline }] }).success).toBe(false);
  });

  it('extends the CI error codes with the timer refusals', () => {
    expect(waitErrorCodeSchema.options).toEqual(expect.arrayContaining(['invalid_request', 'capacity', 'timers_disabled', 'wake_budget_spent']));
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

  it('a human request validates its card with the ask bounds', () => {
    expect(cezarWaitRequestSchema.parse({ kind: 'human' })).toEqual({ kind: 'human' });
    expect(cezarWaitRequestSchema.parse({ kind: 'human', questions: CARD })).toEqual({ kind: 'human', questions: CARD });
    const five = Array.from({ length: 5 }, (_, n) => ({ ...CARD[0]!, question: `Question ${n}?` }));
    expect(cezarWaitRequestSchema.safeParse({ kind: 'human', questions: five }).success).toBe(false);
    expect(cezarWaitRequestSchema.safeParse({ kind: 'human', seconds: 60 }).success).toBe(false);
  });

  it('an open human wait outranks usage limit, workers, ci and timer', () => {
    expect(computeWaitingOn({ waits: [openCi(), openTimer(), openHuman()], autoResumeAt: '2026-10-17T16:00:00.000Z', delegation: parkedRootWait() }))
      .toEqual({ kind: 'human' });
    for (const phase of ['delivered', 'cancelled'] as const) {
      expect(computeWaitingOn({ waits: [openCi(), openHuman({ phase })] })?.kind).toBe('ci');
    }
  });

  it('lists an open human wait without a deadline in both answers', () => {
    const human = { wait_id: HUMAN_ID, kind: 'human' as const, summary: 'human: Which test library?' };
    expect(cezarWaitAnswerSchema.parse({ ok: true, wait_id: HUMAN_ID, kind: 'human', open_waits: [human] }).ok).toBe(true);
    expect(cezarCancelWaitAnswerSchema.parse({ cancelled: false, code: 'human_question', message: 'm', open_waits: [human] }).cancelled).toBe(false);
    expect(waitErrorCodeSchema.options).toEqual(expect.arrayContaining(['autonomous_run', 'questions_required']));
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
    expect(cezarDoneAnswerSchema.parse({ ok: true, finishes: 'at_turn_end', open_waits: [] }).ok).toBe(true);
    const refused = { ok: false, code: 'workers_outstanding', message: 'm', workers: [{ worker_id: 'w', reason: 'outstanding' }] };
    expect(cezarDoneAnswerSchema.parse(refused)).toEqual(refused);
    expect(cezarDoneAnswerSchema.safeParse({ ok: false, code: 'not_a_code', message: 'm' }).success).toBe(false);
    expect(cezarDoneAnswerSchema.safeParse({ ok: true, finishes: 'now', open_waits: [] }).success).toBe(false);
  });
});
