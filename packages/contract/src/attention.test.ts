import { describe, expect, it } from 'vitest';
import { computeWaitingOn, type WaitingOnInput, type WorkerWaitEntry } from './waits.ts';
import { ATTENTION_RANK, ATTENTION_RUNGS, DEFAULT_WEBHOOK_TRIGGERS, attentionOfRung, deriveAttention, deriveWebhookState, WEBHOOK_TRIGGERS, workerWaitLabel, workersWaitingLabel, type Attention, type AttentionInput, type AttentionRung } from './attention.ts';
import type { RunStatus } from './runs.ts';
import {
  makePeerWait,
  makeSubagentWait,
  makeTimerWait,
  RUN_STATUS,
  SUBAGENT_STATUS,
  WAIT_PHASE,
  WAIT_KIND,
  WAIT_SOURCE,
  WAIT_VIA,
  WORKER_OUTCOME_STATUS,
} from './test-factories.testkit.ts';

/**
 * The attention ladder, pinned where it now lives (#553/#609). The cockpit's
 * `packages/web/src/lib/attention.test.ts` keeps the full rendering matrix (tones against
 * `StatusDot`, the #617 status key); this file pins what the CLI and the cockpit SHARE: the
 * rank order, one answer per status, and the delegation rungs that separate "waiting on you"
 * from "waiting on its own workers".
 */

const run = (over: Partial<AttentionInput> & { status: RunStatus }): AttentionInput => ({ ...over });

/** An open human wait; `shown` once the user sees its card (`askSeq`). */
const humanWait = (shown = false) => ({
  kind: WAIT_KIND.human, id: '33333333-3333-4333-8333-333333333334', source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_ask,
  registeredAt: '2026-10-21T14:00:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1', ...(shown ? { askSeq: 7 } : {}),
}) as unknown as NonNullable<AttentionInput['waits']>[number];

/** Every `RunStatus`, spelled out: a new status must get an explicit answer, not the chain's last `return`. */
const ALL_STATUSES: readonly RunStatus[] = ['queued', 'running', 'waiting', 'review', 'done', 'failed', 'cancelled'];

describe('ATTENTION_RANK', () => {
  it('is the spec ladder: permission > error > waiting > running > unseen > none', () => {
    const order = Object.entries(ATTENTION_RANK)
      .sort(([, a], [, b]) => a - b)
      .map(([bucket]) => bucket);
    expect(order).toEqual(['permission', 'error', 'waiting', 'running', 'unseen', 'none']);
  });

  it('ranks error above waiting — an error can never be masked by a gate', () => {
    expect(ATTENTION_RANK.error).toBeLessThan(ATTENTION_RANK.waiting);
    expect(ATTENTION_RANK.permission).toBeLessThan(ATTENTION_RANK.error);
  });
});

describe('deriveAttention', () => {
  const cases: ReadonlyArray<[RunStatus, Attention]> = [
    ['waiting', { rung: 'needs-you', bucket: 'waiting', tone: 'pending', shape: 'filled', pulse: true, label: 'needs you' }],
    ['review', { rung: 'needs-review', bucket: 'waiting', tone: 'info', shape: 'filled', pulse: true, label: 'needs review' }],
    ['running', { rung: 'running', bucket: 'running', tone: 'running', shape: 'filled', pulse: true, label: 'running' }],
    ['queued', { rung: 'queued', bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'queued' }],
    ['done', { rung: 'done', bucket: 'none', tone: 'success', shape: 'filled', pulse: false, label: 'done' }],
    ['failed', { rung: 'failed', bucket: 'error', tone: 'danger', shape: 'filled', pulse: false, label: 'failed' }],
    ['cancelled', { rung: 'cancelled', bucket: 'none', tone: 'neutral', shape: 'filled', pulse: false, label: 'cancelled' }],
  ];

  it.each(cases)('maps %s', (status, expected) => {
    expect(deriveAttention(run({ status }))).toEqual(expected);
  });

  it('answers for every status the API can send', () => {
    expect(cases.map(([status]) => status).sort()).toEqual([...ALL_STATUSES].sort());
  });

  it('is pure — the same record twice is the same answer, and the record is untouched', () => {
    const record = run({ status: RUN_STATUS.waiting });
    const frozen = JSON.stringify(record);
    expect(deriveAttention(record)).toEqual(deriveAttention(record));
    expect(JSON.stringify(record)).toBe(frozen);
  });

  it('never claims permission or unseen — nothing feeds those buckets yet', () => {
    for (const status of ALL_STATUSES) {
      expect(['permission', 'unseen']).not.toContain(deriveAttention(run({ status })).bucket);
    }
  });

  // The #609 contract: `waiting` is attention whether or not a structured question is pending.
  it('treats waiting as attention with or without an open human wait', () => {
    expect(deriveAttention(run({ status: RUN_STATUS.waiting }))).toMatchObject({ bucket: 'waiting', label: 'needs you' });
    expect(deriveAttention(run({ status: RUN_STATUS.waiting, waits: [humanWait()] }))).toMatchObject({ bucket: 'waiting', label: 'needs you' });
  });

  // Rung 3 (phase 4b, hearsay-tools/cezarion#1236): a question the user sees waits on them at any
  // live status. A wake turn that runs beside it (a worker result, a CI result) is Needs you, not
  // running. One registered mid-turn and not shown yet is the turn it is in.
  it('reads a shown human wait as Needs you at any live status', () => {
    for (const status of ['waiting', 'running', 'queued'] as const) {
      expect(deriveAttention(run({ status, waits: [humanWait(true)] }))).toMatchObject({ bucket: 'waiting', label: 'needs you' });
      expect(deriveAttention(run({ status, waitingOn: { kind: WAIT_KIND.human, shown: true } }))).toMatchObject({ bucket: 'waiting', label: 'needs you' });
    }
    expect(deriveAttention(run({ status: RUN_STATUS.running, waits: [humanWait()] })).label).toBe('running');
    expect(deriveAttention(run({ status: RUN_STATUS.queued, waits: [humanWait()] })).label).toBe('queued');
    // A finished run's leftovers are history; review and failed keep their own rungs.
    expect(deriveAttention(run({ status: RUN_STATUS.review, waits: [humanWait(true)] })).label).toBe('needs review');
    expect(deriveAttention(run({ status: RUN_STATUS.failed, waits: [humanWait(true)] })).label).toBe('failed');
    expect(deriveAttention(run({ status: RUN_STATUS.done, waits: [humanWait(true)] })).label).toBe('done');
  });

  it('reads a usage-limited waiting run as usage limit, not as Needs you', () => {
    expect(deriveAttention(run({ status: RUN_STATUS.waiting, autoResumeAt: '2026-10-21T15:00:00.000Z' }))).toEqual({
      rung: 'usage-limit', bucket: 'none', tone: 'neutral', shape: 'ring', pulse: false, label: 'usage limit',
    });
    expect(deriveAttention(run({ status: RUN_STATUS.running, autoResumeAt: '2026-08-03T19:33:53.000Z' })).label).toBe('running');
  });

  it('reads a failed run as failed, whatever autoResumeAt it carries', () => {
    expect(deriveAttention(run({ status: RUN_STATUS.failed, autoResumeAt: '2026-08-03T19:33:53.000Z' })).label).toBe('failed');
  });

  it('an open human wait outranks the usage limit, and the usage limit outranks workers', () => {
    const human = { kind: WAIT_KIND.human, id: '33333333-3333-4333-8333-333333333333', source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_ask,
      registeredAt: '2026-10-21T14:00:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1' } as unknown as NonNullable<AttentionInput['waits']>[number];
    expect(deriveAttention(run({ status: RUN_STATUS.waiting, autoResumeAt: '2026-10-21T15:00:00.000Z', waits: [human] })).label).toBe('needs you');
    expect(deriveAttention(run({ status: RUN_STATUS.waiting, autoResumeAt: '2026-10-21T15:00:00.000Z', delegation: { role: 'root' }, waits: [workerEntry()] } as AttentionInput)).label).toBe('usage limit');
  });

  it('a usage limit outranks a resolved worker wake, which waits for the appointment, not capacity', () => {
    const record = { status: RUN_STATUS.waiting, autoResumeAt: '2026-10-21T15:00:00.000Z', delegation: { role: 'root' }, waits: [workerEntry({ phase: WAIT_PHASE.resolved })] } as AttentionInput;
    expect(deriveAttention(record).label).toBe('usage limit');
  });
});

// hearsay-tools/cezarion#1496: one id per rung; the label is copy and can carry a count.
describe('rung ids', () => {
  const pr = (until: 'checks' | 'merge') => ({ kind: WAIT_KIND.pr, until, waitId: '11111111-1111-4111-8111-111111111111', prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, deadline: '2026-10-17T15:40:00.000Z' });
  const table: ReadonlyArray<[AttentionRung, string, AttentionInput]> = [
    ['needs-permission', 'needs permission', { status: RUN_STATUS.running, hasPendingPermission: true }],
    ['failed', 'failed', { status: RUN_STATUS.failed }],
    ['needs-you', 'needs you', { status: RUN_STATUS.waiting }],
    ['needs-you', 'needs you', { status: RUN_STATUS.running, waitingOn: { kind: WAIT_KIND.human, shown: true } }],
    ['needs-review', 'needs review', { status: RUN_STATUS.review }],
    ['running', 'running', { status: RUN_STATUS.running }],
    ['usage-limit', 'usage limit', { status: RUN_STATUS.waiting, autoResumeAt: '2026-10-17T16:00:00.000Z' }],
    ['waiting-on-workers', 'waiting on 2 workers', { status: RUN_STATUS.waiting, waitingOn: { kind: 'workers', count: 2 } }],
    ['waiting-on-workers', 'waiting on workers', { status: RUN_STATUS.waiting, waitingOn: { kind: 'workers', count: 0 } }],
    ['waiting-on-workers', 'waiting on worker replies', { status: RUN_STATUS.waiting, waitingOn: { kind: 'workers', count: 1, replies: true } }],
    ['waiting-on-workers', 'waiting on parent reply', { status: RUN_STATUS.waiting, delegation: { role: 'worker' }, waitingOn: { kind: 'workers', count: 1 } } as AttentionInput],
    // hearsay-tools/cezarion#1995: a peer request's reply, and named peer tasks.
    ['waiting-on-workers', 'waiting on replies', { status: RUN_STATUS.waiting, waitingOn: { kind: 'workers', count: 1, replies: true, peers: true } }],
    ['waiting-on-workers', 'waiting on 2 tasks', { status: RUN_STATUS.waiting, waitingOn: { kind: 'peers', count: 2 } }],
    ['waiting-on-workers', 'waiting on 1 task', { status: RUN_STATUS.waiting, waits: [makePeerWait()] }],
    // hearsay-tools/cezarion#2431: native subagents the turn left running.
    ['waiting-on-subagents', 'waiting for 1 subagent', { status: RUN_STATUS.waiting, waits: [makeSubagentWait()] }],
    ['waiting-on-subagents', 'waiting for 2 subagents', { status: RUN_STATUS.waiting, waitingOn: { kind: 'subagents', count: 2 } }],
    ['waiting-on-subagents', 'waiting for subagents', { status: RUN_STATUS.waiting, waitingOn: { kind: 'subagents', count: 0 } }],
    ['waiting-for-ci', 'waiting for CI', { status: RUN_STATUS.waiting, waitingOn: pr('checks') }],
    ['waiting-for-merge', 'waiting for merge', { status: RUN_STATUS.waiting, waitingOn: pr('merge') }],
    ['waiting-for-command', 'waiting for a command', { status: RUN_STATUS.waiting, waitingOn: { kind: WAIT_KIND.process, waitId: '77777777-7777-4777-8777-777777777777', pid: 4242, deadline: '2026-10-17T15:30:00.000Z' } }],
    ['monitoring', 'monitoring', { status: RUN_STATUS.waiting, waitingOn: { kind: WAIT_KIND.timer, waitId: '22222222-2222-4222-8222-222222222222', at: '2026-10-17T15:05:00.000Z' } }],
    ['waiting-for-capacity', 'waiting for capacity', { status: RUN_STATUS.waiting, waitWakePending: true }],
    ['queued', 'queued', { status: RUN_STATUS.queued }],
    ['done', 'done', { status: RUN_STATUS.done }],
    ['cancelled', 'cancelled', { status: RUN_STATUS.cancelled }],
  ];

  it.each(table)('reads %s with the label %j', (rung, label, input) => {
    expect(deriveAttention(input)).toMatchObject({ rung, label });
  });

  it('lists every rung the table reaches, and only the reserved unseen besides', () => {
    expect([...new Set([...table.map(([rung]) => rung), 'unseen'])].sort()).toEqual([...ATTENTION_RUNGS].sort());
  });
});

describe('attentionOfRung', () => {
  // Activity snapshots render a rung without a full run, including the reserved unseen rung.
  const presentations: readonly Attention[] = [
    { rung: 'needs-permission', bucket: 'permission', tone: 'info', shape: 'filled', pulse: true, label: 'needs permission' },
    { rung: 'waiting-for-merge', bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'waiting for merge' },
    { rung: 'monitoring', bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'monitoring' },
    { rung: 'unseen', bucket: 'unseen', tone: 'accent', shape: 'filled', pulse: false, label: 'unseen' },
  ];

  it.each(presentations)('presents $rung from its id alone', expected => {
    expect(attentionOfRung(expected.rung)).toEqual(expected);
  });
});

/** A worker wait is a list entry (hearsay-tools/cezarion#1235), Squawk's completion wait included
 *  (hearsay-tools/cezarion#1301): `delegation.wait` is never read. */
const workerEntry = (over: Partial<WorkerWaitEntry> = {}): WorkerWaitEntry => ({
  kind: WAIT_KIND.worker, id: '88888888-8888-4888-8888-888888888880', source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, registeredAt: '2026-10-19T10:00:00.000Z',
  deadline: '2026-10-19T10:10:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1', timeoutSeconds: 600, workerIds: ['child'], revisions: [], outcomes: [],
  ...over,
} as WorkerWaitEntry);
const completionEntry = (over: Partial<WorkerWaitEntry> = {}): WorkerWaitEntry => {
  const { deadline: _deadline, timeoutSeconds: _timeout, ...entry } = workerEntry({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.completion, ...over });
  return { ...entry, mode: 'all' } as WorkerWaitEntry;
};

describe('workersWaitingLabel', () => {
  it.each([
    [0, 'waiting on workers'],
    [1, 'waiting on 1 worker'],
    [2, 'waiting on 2 workers'],
  ] as const)('labels a summary with %i pending workers', (count, expected) => {
    expect(workersWaitingLabel({ status: RUN_STATUS.waiting, waitingOn: { kind: 'workers', count } })).toBe(expected);
  });

  it('counts pending workers once across agent and completion waits', () => {
    const input: AttentionInput = {
      status: RUN_STATUS.waiting,
      waits: [
        workerEntry({ workerIds: ['a', 'b'], outcomes: [{ workerId: 'a', status: WORKER_OUTCOME_STATUS.done, observedAt: '2026-10-19T10:03:00.000Z' }] }),
        completionEntry({ id: '88888888-8888-4888-8888-888888888882', workerIds: ['b', 'c'] }),
        workerEntry({ id: '88888888-8888-4888-8888-888888888883', workerIds: ['d'], phase: WAIT_PHASE.resolved }),
      ],
    };
    expect(workersWaitingLabel(input)).toBe('waiting on 2 workers');
  });

  it('distinguishes worker replies, peer replies and a reply to a worker', () => {
    const input: AttentionInput = { status: RUN_STATUS.waiting, waitingOn: { kind: 'workers', count: 1, replies: true } };
    expect(workersWaitingLabel(input)).toBe('waiting on worker replies');
    expect(workersWaitingLabel({ ...input, waitingOn: { kind: 'workers', count: 1, replies: true, peers: true } })).toBe('waiting on replies');
    expect(workersWaitingLabel({ ...input, delegation: { role: 'worker', parentRunId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' } })).toBe('waiting on parent reply');
  });

  const withoutWorkerLabel: ReadonlyArray<[string, AttentionInput]> = [
    ['no waits', { status: RUN_STATUS.waiting }],
    ['an empty wait list', { status: RUN_STATUS.waiting, waits: [] }],
    ['a settled worker wait', { status: RUN_STATUS.waiting, waits: [workerEntry({ phase: WAIT_PHASE.resolved })] }],
    ['a timer wait', { status: RUN_STATUS.waiting, waits: [makeTimerWait()] }],
    ['a peer task wait', { status: RUN_STATUS.waiting, waits: [makePeerWait()] }],
    ['a native subagent wait', { status: RUN_STATUS.waiting, waits: [makeSubagentWait()] }],
    ['a human wait above workers', { status: RUN_STATUS.waiting, waits: [workerEntry(), humanWait()] }],
    ['a usage limit above workers', { status: RUN_STATUS.waiting, autoResumeAt: '2026-10-21T15:00:00.000Z', waits: [workerEntry()] }],
  ];

  it.each(withoutWorkerLabel)('returns no worker label for %s', (_name, input) => {
    expect(workersWaitingLabel(input)).toBeUndefined();
  });
});

describe('delegation rungs', () => {
  const parkedRoot = (waits: WorkerWaitEntry[] = [workerEntry()]): AttentionInput => ({
    status: RUN_STATUS.waiting, waits, delegation: { role: 'root' },
  } as unknown as AttentionInput);

  it.each(['open', 'resolved'] as const)('distinguishes a %s worker wait without masking human attention', (phase) => {
    const attention = deriveAttention(parkedRoot([workerEntry({ phase })]));
    if (phase === 'open') expect(attention).toMatchObject({ bucket: 'none', label: 'waiting on 1 worker' });
    // A queued automatic wake is a scheduler/capacity wait, not a human gate (#971).
    else expect(attention).toEqual({ rung: 'waiting-for-capacity', bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity' });
  });

  it('a root parked on its own workers is bucket none — the CLI must not stop an attention wait on it', () => {
    expect(deriveAttention(parkedRoot([workerEntry({ workerIds: ['a', 'b'] })]))).toEqual({
      rung: 'waiting-on-workers', bucket: 'none', tone: 'running', shape: 'workers', pulse: false, label: 'waiting on 2 workers',
    });
  });

  it("reads a root on Cezar's completion wait, which has no deadline, as waiting on its workers", () => {
    expect(deriveAttention(parkedRoot([completionEntry({ workerIds: ['a', 'b'] })]))).toEqual({
      rung: 'waiting-on-workers', bucket: 'none', tone: 'running', shape: 'workers', pulse: false, label: 'waiting on 2 workers',
    });
    expect(deriveAttention(parkedRoot([completionEntry({ phase: WAIT_PHASE.resolved })])).label).toBe('waiting for capacity');
  });

  it('a parked parent with a pending human ask is attention again', () => {
    const record = { ...parkedRoot(), waits: [workerEntry(), humanWait()] } as AttentionInput;
    expect(deriveAttention(record)).toMatchObject({ bucket: 'waiting', label: 'needs you' });
  });

  it('a wake-pending parent with a pending human ask stays Needs you', () => {
    const record = { ...parkedRoot(), waits: [workerEntry({ phase: WAIT_PHASE.resolved }), humanWait()] } as AttentionInput;
    expect(deriveAttention(record)).toMatchObject({ bucket: 'waiting', label: 'needs you' });
  });

  it('a queued leftover wake-pending parent is waiting for capacity, not queued', () => {
    const record = { ...parkedRoot([workerEntry({ phase: WAIT_PHASE.resolved })]), status: RUN_STATUS.queued };
    expect(deriveAttention(record)).toEqual({
      rung: 'waiting-for-capacity', bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity',
    });
  });

  it('running still wins over leftover wake-pending', () => {
    const record = { ...parkedRoot([workerEntry({ phase: WAIT_PHASE.resolved })]), status: RUN_STATUS.running };
    expect(deriveAttention(record)).toEqual({
      rung: 'running', bucket: 'running', tone: 'running', shape: 'filled', pulse: true, label: 'running',
    });
  });

  it('a queued leftover wake-pending parent with a shown question is Needs you', () => {
    const record = { ...parkedRoot(), status: RUN_STATUS.queued, waits: [workerEntry({ phase: WAIT_PHASE.resolved }), humanWait(true)] } as AttentionInput;
    expect(deriveAttention(record)).toMatchObject({ bucket: 'waiting', label: 'needs you' });
  });

  it('labels a legacy-shape worker wait by the workers that have not reported yet', () => {
    const outcome = (workerId: string) => ({ workerId, status: WORKER_OUTCOME_STATUS.done, observedAt: '2026-09-05T00:00:00.000Z' });
    expect(workerWaitLabel('root', { workerIds: ['a', 'b'], outcomes: [outcome('a')] })).toBe('waiting on 1 worker');
    expect(workerWaitLabel('root', { workerIds: ['a', 'b'], outcomes: [outcome('a'), outcome('b')] })).toBe('waiting on workers');
    expect(workerWaitLabel('root', { requestIds: ['r'], workerIds: [], outcomes: [] })).toBe('waiting on worker replies');
    expect(workerWaitLabel('worker', { requestIds: ['r'], workerIds: [], outcomes: [] })).toBe('waiting on parent reply');
    expect(workerWaitLabel('root', { requestIds: ['r'], workerIds: [], outcomes: [] }, true)).toBe('waiting on replies');
  });

  // hearsay-tools/cezarion#1995: a run parked on named peers is never Needs you.
  it('a run parked on a peer wait waits outside itself, in no bucket', () => {
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [makePeerWait({ peerIds: ['cccccccc-cccc-4ccc-8ccc-ccccccccccc1', 'cccccccc-cccc-4ccc-8ccc-ccccccccccc2'] })] }))
      .toMatchObject({ rung: 'waiting-on-workers', bucket: 'none', shape: 'ring', label: 'waiting on 2 tasks' });
  });

  it('an invalid delegation never hides a waiting run', () => {
    const invalid = { status: RUN_STATUS.waiting, delegation: { role: 'invalid', reason: 'x' } } as unknown as AttentionInput;
    expect(deriveAttention(invalid)).toMatchObject({ bucket: 'waiting', label: 'needs you' });
  });
});

it('keeps a native permission prompt above worker-wait attention (hearsay-tools/cezarion#1049)', () => {
  const waiting = { status: RUN_STATUS.waiting, hasPendingPermission: true, waits: [workerEntry()], delegation: { role: 'root' as const } };
  expect(deriveAttention(waiting as AttentionInput)).toMatchObject({ bucket: 'permission', label: 'needs permission' });
});

/** CI and timer parks are `waiting` with an open wait (spec 2026-10-17-unified-waits, phase 1).
 *  The cockpit derives attention from full records and stream-patched records too, which carry
 *  `waits` but no `waitingOn` key, so the rows below pass RECORDS. */
describe('open waits', () => {
  const openCi = () => ({
    kind: WAIT_KIND.pr, id: '11111111-1111-4111-8111-111111111111', source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait,
    registeredAt: '2026-10-17T15:10:00.000Z', deadline: '2026-10-17T15:40:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1',
    prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, headSha: 'a'.repeat(40),
    generation: 'gen-1', timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true,
  });
  const openTimer = () => ({
    kind: WAIT_KIND.timer, id: '22222222-2222-4222-8222-222222222222', source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait,
    registeredAt: '2026-10-17T15:00:00.000Z', deadline: '2026-10-17T15:05:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1',
    seconds: 300,
  });

  it('reads a waiting record parked on a process wait as running, waiting for a command (hearsay-tools/cezarion#1446)', () => {
    const waitingOn = { kind: WAIT_KIND.process, waitId: '77777777-7777-4777-8777-777777777777', pid: 4242, deadline: '2026-10-17T15:30:00.000Z' };
    expect(deriveAttention({ status: RUN_STATUS.waiting, waitingOn })).toEqual({ rung: 'waiting-for-command', bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'waiting for a command' });
  });

  it('reads a waiting record with an open CI or timer wait as running, not Needs you', () => {
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [openCi()] })).toMatchObject({ bucket: 'running', shape: 'ring', label: 'waiting for CI' });
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [openTimer()] })).toMatchObject({ bucket: 'running', shape: 'ring', label: 'monitoring' });
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [openCi()] })).toEqual({
      rung: 'waiting-for-ci', bucket: 'running', tone: 'running', shape: 'ring', pulse: true, label: 'waiting for CI',
    });
  });

  // hearsay-tools/cezarion#1425: a PR wait's target names what the run waits for.
  it.each(['merge', 'merge_or_blocked'] as const)('labels an open PR %s wait waiting for merge', target => {
    expect(deriveAttention({ status: RUN_STATUS.waiting, waitingOn: { kind: WAIT_KIND.pr, until: target, waitId: '11111111-1111-4111-8111-111111111111',
      prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, deadline: '2026-10-17T15:40:00.000Z' } } as never))
      .toMatchObject({ bucket: 'running', shape: 'ring', label: 'waiting for merge' });
  });

  it('keeps an open human signal above the wait', () => {
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [openCi(), humanWait()] }).label).toBe('needs you');
    // The transcript-context argument the cockpit passes says the same.
    expect(deriveAttention({ status: RUN_STATUS.waiting, waitingOn: { kind: WAIT_KIND.human }, waits: [openCi()] }).label).toBe('needs you');
  });

  it('follows a summary\'s waitingOn when the row carries no waits', () => {
    expect(deriveAttention({
      status: RUN_STATUS.waiting,
      waitingOn: { kind: WAIT_KIND.pr, until: 'checks', waitId: '11111111-1111-4111-8111-111111111111', prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, deadline: '2026-10-17T15:40:00.000Z' },
    }).label).toBe('waiting for CI');
    expect(deriveAttention({ status: RUN_STATUS.waiting, waitingOn: { kind: WAIT_KIND.timer, waitId: '22222222-2222-4222-8222-222222222222', at: '2026-10-17T15:05:00.000Z' } }).label).toBe('monitoring');
  });

  // Rung 10: a resolved wait is a wake owed to the agent; until its turn starts the run waits for
  // a slot, not for the user.
  it('reads a waiting record with only a resolved wait as waiting for capacity', () => {
    const resolved = { ...openCi(), phase: WAIT_PHASE.resolved, resolvedAt: '2026-10-17T15:20:00.000Z' };
    const capacity = { rung: 'waiting-for-capacity', bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity' };
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [resolved] })).toEqual(capacity);
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [{ ...openTimer(), phase: WAIT_PHASE.resolved }] })).toEqual(capacity);
    // A summary carries the flag instead of the list.
    expect(deriveAttention({ status: RUN_STATUS.waiting, waitWakePending: true })).toEqual(capacity);
    // An open CI or timer wait still names what the run waits on.
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [resolved, openTimer()] }).label).toBe('monitoring');
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [{ ...openTimer(), phase: WAIT_PHASE.resolved }, openCi()] }).label).toBe('waiting for CI');
    // An open human signal still wins.
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [resolved, humanWait()] }).label).toBe('needs you');
    // Delivered and cancelled entries are no wake.
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [{ ...resolved, phase: WAIT_PHASE.delivered }] }).label).toBe('needs you');
    expect(deriveAttention({ status: RUN_STATUS.running, waits: [resolved] }).label).toBe('running');
  });

  // Workers outrank CI and timers (`computeWaitingOn`), and a worker park keeps its open waits
  // (hearsay-tools/cezarion#1233): the workers' label and their owed wake stay on top.
  it('keeps a parked or wake-pending worker wait above open CI and timer waits', () => {
    const root = (phase: 'parked' | 'wake-pending', waits: unknown[]) => ({
      status: RUN_STATUS.waiting, waits: [...waits, workerEntry({ workerIds: ['a'], phase: phase === 'parked' ? 'open' : 'resolved' })], delegation: { role: 'root' },
    } as unknown as AttentionInput);
    for (const waits of [[openTimer()], [openCi()], [openCi(), openTimer()]]) {
      expect(deriveAttention(root('parked', waits))).toMatchObject({ shape: 'workers', label: 'waiting on 1 worker' });
      expect(deriveAttention(root('wake-pending', waits))).toEqual({
        rung: 'waiting-for-capacity', bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting for capacity',
      });
      expect(deriveAttention(root('wake-pending', [...waits, humanWait()])).label).toBe('needs you');
    }
  });

  it('leaves every other status alone', () => {
    expect(deriveAttention({ status: RUN_STATUS.running, waits: [openCi()] }).label).toBe('running');
    expect(deriveAttention({ status: RUN_STATUS.review, waits: [openCi()] }).label).toBe('needs review');
    expect(deriveAttention({ status: RUN_STATUS.failed, waits: [openCi()] }).label).toBe('failed');
    expect(deriveAttention({ status: RUN_STATUS.waiting }).label).toBe('needs you'); // no wait: unchanged fallback
  });
});

// hearsay-tools/cezarion#1235 (phase 3a): worker waits are wait-list entries.
describe('computeWaitingOn and worker entries', () => {
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `99999999-9999-4999-8999-99999999999${i}`);
  const workerWait = (id: string, workerIds: string[], reported: string[] = []): WorkerWaitEntry => ({
    kind: WAIT_KIND.worker, id, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, registeredAt: '2026-10-19T10:00:00.000Z',
    deadline: '2026-10-19T10:10:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1', timeoutSeconds: 600,
    workerIds, revisions: [],
    outcomes: reported.map((workerId) => ({ workerId, status: WORKER_OUTCOME_STATUS.done, observedAt: '2026-10-19T10:03:00.000Z' })),
  });
  const ci = {
    kind: WAIT_KIND.pr, id: '11111111-1111-4111-8111-111111111111', source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait,
    registeredAt: '2026-10-19T10:00:00.000Z', deadline: '2026-10-19T10:30:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1',
    prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, headSha: 'a'.repeat(40), generation: 'gen-1', timeoutSeconds: 1800, until: 'checks' as const, wakeOnConflict: true,
  };

  it('computeWaitingOn counts unreported workers across two worker entries', () => {
    const [a, b, c] = ids(3);
    const waits = [
      workerWait('88888888-8888-4888-8888-888888888881', [a!, b!], [b!]),
      workerWait('88888888-8888-4888-8888-888888888882', [c!]),
      workerWait('88888888-8888-4888-8888-888888888883', [a!, c!], [a!, c!]),
    ];
    // 1 + 1 unreported across the first two; the third has every worker reported.
    expect(computeWaitingOn({ waits: waits.slice(0, 2) })).toEqual({ kind: 'workers', count: 2 });
    expect(computeWaitingOn({ waits: [workerWait('88888888-8888-4888-8888-888888888884', [a!, b!]), workerWait('88888888-8888-4888-8888-888888888885', [c!])] }))
      .toEqual({ kind: 'workers', count: 3 });
    // Only open entries count.
    expect(computeWaitingOn({ waits: [{ ...waits[0]!, phase: WAIT_PHASE.resolved }] })).toBeUndefined();
  });

  // hearsay-tools/cezarion#2588: a worker in two open waits is one pending worker.
  it('counts each pending worker once across overlapping and disjoint waits', () => {
    const [a, b] = ids(2);
    const overlapping = [workerWait('88888888-8888-4888-8888-888888888881', [a!]), workerWait('88888888-8888-4888-8888-888888888882', [a!, b!])];
    expect(computeWaitingOn({ waits: overlapping })).toEqual({ kind: 'workers', count: 2 });
    expect(deriveAttention({ status: RUN_STATUS.waiting, delegation: { role: 'root' }, waits: overlapping } as AttentionInput).label).toBe('waiting on 2 workers');
    expect(computeWaitingOn({ waits: [workerWait('88888888-8888-4888-8888-888888888881', [a!]), workerWait('88888888-8888-4888-8888-888888888882', [b!])] }))
      .toEqual({ kind: 'workers', count: 2 });
  });

  it('a reported outcome removes only the worker it satisfies', () => {
    const [a, b] = ids(2);
    // A reported in the second wait; the first wait still owes A, so A still counts once, and B counts.
    expect(computeWaitingOn({ waits: [workerWait('88888888-8888-4888-8888-888888888881', [a!]), workerWait('88888888-8888-4888-8888-888888888882', [a!, b!], [a!])] }))
      .toEqual({ kind: 'workers', count: 2 });
    expect(computeWaitingOn({ waits: [workerWait('88888888-8888-4888-8888-888888888881', [a!], [a!]), workerWait('88888888-8888-4888-8888-888888888882', [a!, b!], [a!])] }))
      .toEqual({ kind: 'workers', count: 1 });
  });

  it('settled worker waits add no pending worker', () => {
    const [a, b] = ids(2);
    const open = workerWait('88888888-8888-4888-8888-888888888881', [a!]);
    for (const phase of [WAIT_PHASE.resolved, WAIT_PHASE.delivered, WAIT_PHASE.cancelled]) {
      expect(computeWaitingOn({ waits: [open, { ...workerWait('88888888-8888-4888-8888-888888888882', [a!, b!]), phase }] })).toEqual({ kind: 'workers', count: 1 });
    }
  });

  it('counts each unanswered request once across request waits', () => {
    const request = (id: string, requestIds: string[]): WorkerWaitEntry => ({ ...workerWait(id, ['99999999-9999-4999-8999-999999999990']), requestIds });
    const [r1, r2] = ['77777777-7777-4777-8777-777777777771', '77777777-7777-4777-8777-777777777772'];
    expect(computeWaitingOn({ waits: [request('88888888-8888-4888-8888-888888888881', [r1]), request('88888888-8888-4888-8888-888888888882', [r1, r2])] }))
      .toEqual({ kind: 'workers', count: 2, replies: true });
  });

  it('a worker entry outranks an open ci wait', () => {
    const [a] = ids(1);
    expect(computeWaitingOn({ waits: [ci, workerWait('88888888-8888-4888-8888-888888888881', [a!])] })).toEqual({ kind: 'workers', count: 1 });
  });

  it('a human wait outranks a worker entry', () => {
    const [a] = ids(1);
    const waits = [workerWait('88888888-8888-4888-8888-888888888881', [a!])];
    expect(computeWaitingOn({ waits: [...waits, humanWait()] })).toEqual({ kind: WAIT_KIND.human });
    expect(computeWaitingOn({ waits: [...waits, humanWait(true)] })).toEqual({ kind: WAIT_KIND.human, shown: true });
  });

  // The attention rung for list entries and summaries (previously fell through to "needs you").
  it('reads a waiting run with only an open worker entry as waiting on its workers', () => {
    const [a, b] = ids(2);
    const entry = workerWait('88888888-8888-4888-8888-888888888881', [a!, b!]);
    const expected = { rung: 'waiting-on-workers', bucket: 'none', tone: 'running', shape: 'workers', pulse: false, label: 'waiting on 2 workers' };
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [entry] })).toEqual(expected);
    // With CI beside it, workers still name the run.
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [ci, entry] })).toEqual(expected);
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [workerWait('88888888-8888-4888-8888-888888888881', [a!])] }).label).toBe('waiting on 1 worker');
    // Every worker reported but the wait is still open: no number.
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [workerWait('88888888-8888-4888-8888-888888888881', [a!], [a!])] }).label).toBe('waiting on workers');
  });

  it('reads a summary carrying only waitingOn workers the same way', () => {
    expect(deriveAttention({ status: RUN_STATUS.waiting, waitingOn: { kind: 'workers', count: 2 } }))
      .toEqual({ rung: 'waiting-on-workers', bucket: 'none', tone: 'running', shape: 'workers', pulse: false, label: 'waiting on 2 workers' });
    expect(deriveAttention({ status: RUN_STATUS.waiting, waitingOn: { kind: 'workers', count: 0 } }).label).toBe('waiting on workers');
    expect(deriveAttention({ status: RUN_STATUS.waiting, waitingOn: { kind: WAIT_KIND.human } }).label).toBe('needs you');
    expect(deriveAttention({ status: RUN_STATUS.running, waitingOn: { kind: 'workers', count: 1 } }).label).toBe('running');
  });

  it('keeps the parent-reply and worker-reply wording for request entries', () => {
    const request: WorkerWaitEntry = {
      kind: WAIT_KIND.worker, id: '88888888-8888-4888-8888-888888888881', source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, registeredAt: '2026-10-19T10:00:00.000Z',
      deadline: '2026-10-19T10:10:00.000Z', phase: WAIT_PHASE.open, turnId: 'turn-1', timeoutSeconds: 600,
      requestIds: ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'], requestOutcomes: [],
    };
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [request], delegation: { role: 'root' } } as unknown as AttentionInput))
      .toMatchObject({ shape: 'workers', label: 'waiting on worker replies' });
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [request], delegation: { role: 'worker' } } as unknown as AttentionInput))
      .toEqual({ rung: 'waiting-on-workers', bucket: 'none', tone: 'running', shape: 'ring', pulse: false, label: 'waiting on parent reply' });
    // A summary has no entries: a worker still reads as waiting on its parent.
    expect(deriveAttention({ status: RUN_STATUS.waiting, waitingOn: { kind: 'workers', count: 1 }, delegation: { role: 'worker' } } as unknown as AttentionInput).label)
      .toBe('waiting on parent reply');
    // A root's summary says so through `waitingOn.replies`, which only request entries set.
    const waitingOn = computeWaitingOn({ waits: [request], delegation: { role: 'root' } } as unknown as WaitingOnInput);
    expect(waitingOn).toEqual({ kind: 'workers', count: 1, replies: true });
    expect(deriveAttention({ status: RUN_STATUS.waiting, waitingOn, delegation: { role: 'root' } } as unknown as AttentionInput).label)
      .toBe('waiting on worker replies');
    expect(computeWaitingOn({ waits: [request, workerWait('88888888-8888-4888-8888-888888888882', ['aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa2'])] }))
      .toEqual({ kind: 'workers', count: 2 });
  });

  it("counts Cezar's completion wait beside an agent's worker entry, on a summary and a record", () => {
    const entry = workerWait('88888888-8888-4888-8888-888888888881', ids(1));
    const completion = completionEntry({ id: '88888888-8888-4888-8888-888888888882', workerIds: ['a', 'b'] });
    expect(computeWaitingOn({ waits: [entry, completion] })).toEqual({ kind: 'workers', count: 3 });
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [entry, completion] } as unknown as AttentionInput).label).toBe('waiting on 3 workers');
    const summary = { status: RUN_STATUS.waiting, delegation: { role: 'root' }, waitingOn: { kind: 'workers', count: 3 } } as unknown as AttentionInput;
    expect(deriveAttention(summary).label).toBe('waiting on 3 workers');
    expect(deriveAttention({ ...summary, waitingOn: { kind: WAIT_KIND.human } }).label).toBe('needs you');
  });
});

// hearsay-tools/cezarion#1356: the state a project webhook filters on, read off the same ladder.
describe('deriveWebhookState', () => {
  const ci = { kind: WAIT_KIND.pr, until: 'checks' as const, waitId: '11111111-1111-4111-8111-111111111111', prUrl: 'https://github.com/o/r/pull/12', repository: 'o/r', prNumber: 12, deadline: '2026-10-17T15:40:00.000Z' };
  const timer = { kind: WAIT_KIND.timer, waitId: '22222222-2222-4222-8222-222222222222', at: '2026-10-17T15:05:00.000Z' };
  const cases: ReadonlyArray<[string, AttentionInput, ReturnType<typeof deriveWebhookState>]> = [
    ['a plain waiting run', { status: RUN_STATUS.waiting }, 'needs-you'],
    ['a pending question', { status: RUN_STATUS.waiting, waitingOn: { kind: WAIT_KIND.human } }, 'needs-you'],
    ['a question shown during a wake turn', { status: RUN_STATUS.running, waitingOn: { kind: WAIT_KIND.human, shown: true } }, 'needs-you'],
    ['a question not shown yet during its turn', { status: RUN_STATUS.running, waitingOn: { kind: WAIT_KIND.human } }, 'running'],
    ['a review', { status: RUN_STATUS.review }, 'needs-you'],
    ['a live permission request on a running run', { status: RUN_STATUS.running, hasPendingPermission: true }, 'needs-you'],
    ['a failed run', { status: RUN_STATUS.failed }, 'failed'],
    ['a usage-limited run', { status: RUN_STATUS.waiting, autoResumeAt: '2026-10-17T16:00:00.000Z' }, undefined],
    ['a done run', { status: RUN_STATUS.done }, 'done'],
    ['a cancelled run', { status: RUN_STATUS.cancelled }, 'cancelled'],
    ['a running run', { status: RUN_STATUS.running }, 'running'],
    ['a queued run', { status: RUN_STATUS.queued }, undefined],
    ['a root on its workers', { status: RUN_STATUS.waiting, delegation: { role: 'root' }, waitingOn: { kind: 'workers', count: 2 } } as AttentionInput, 'waiting-workers'],
    ['a worker on its parent\'s reply', { status: RUN_STATUS.waiting, delegation: { role: 'worker' }, waitingOn: { kind: 'workers', count: 1, replies: true } } as AttentionInput, 'waiting-workers'],
    ['a CI wait', { status: RUN_STATUS.waiting, waitingOn: ci }, 'waiting-ci'],
    ['a merge wait', { status: RUN_STATUS.waiting, waitingOn: { ...ci, until: 'merge' } }, 'waiting-other'],
    ['a root on named peer tasks', { status: RUN_STATUS.waiting, waitingOn: { kind: 'peers', count: 1 } }, 'waiting-other'],
    ['a timer wait', { status: RUN_STATUS.waiting, waitingOn: timer }, 'waiting-timer'],
    // hearsay-tools/cezarion#2431: the owner chose the workers trigger.
    ['a root on native subagents', { status: RUN_STATUS.waiting, waitingOn: { kind: 'subagents', count: 1 } }, 'waiting-workers'],
    // hearsay-tools/cezarion#1446: no option of its own, so the catch-all.
    ['a process wait', { status: RUN_STATUS.waiting, waitingOn: { kind: WAIT_KIND.process, waitId: '77777777-7777-4777-8777-777777777777', pid: 4242, deadline: '2026-10-17T15:30:00.000Z' } }, 'waiting-other'],
    // A usage-limit park is parked on a clock, as the scheduled resume it replaces was: no state.
    ['a usage-limit wait', { status: RUN_STATUS.waiting, waitingOn: { kind: 'usage-limit', at: '2026-10-17T16:00:00.000Z' } }, undefined],
    ['a resolved wait owed a wake', { status: RUN_STATUS.waiting, waitWakePending: true }, undefined],
  ];

  it.each(cases)('reads %s', (_name, input, state) => {
    expect(deriveWebhookState(input)).toBe(state);
  });

  it('reads an unknown wait kind as waiting-other', () => {
    expect(deriveWebhookState({ status: RUN_STATUS.waiting, waitingOn: { kind: 'future' } } as unknown as AttentionInput)).toBe('waiting-other');
  });

  it('only ever answers a trigger, and the default is the four that end a task or need a person', () => {
    for (const status of ALL_STATUSES) {
      const state = deriveWebhookState(run({ status }));
      if (state !== undefined) expect(WEBHOOK_TRIGGERS).toContain(state);
    }
    expect(DEFAULT_WEBHOOK_TRIGGERS).toEqual(['needs-you', 'failed', 'done', 'cancelled']);
  });
});

describe('attention boundary cases', () => {
  it('labels empty, sparse and fully reported legacy worker waits', () => {
    expect(workerWaitLabel('root', { workerIds: ['a', 'b'], outcomes: [] })).toBe('waiting on 2 workers');
    expect(workerWaitLabel('root', { workerIds: ['a', 'b'], outcomes: [{ workerId: 'b', status: RUN_STATUS.done, observedAt: '2026-10-30T12:00:00Z' }] })).toBe('waiting on 1 worker');
    expect(workerWaitLabel('root', { workerIds: [], outcomes: [] })).toBe('waiting on workers');
    expect(workerWaitLabel('root', {} as never)).toBe('waiting on workers');
    expect(workerWaitLabel('root', { workerIds: ['a'], outcomes: undefined } as never)).toBe('waiting on 1 worker');
    expect(workerWaitLabel('root', { requestIds: [], workerIds: ['a'], outcomes: [] }, true)).toBe('waiting on 1 worker');
    expect(workerWaitLabel('root', { requestIds: ['r'], workerIds: [], outcomes: [] }, true)).toBe('waiting on replies');
    expect(workerWaitLabel('worker', { requestIds: ['r'], workerIds: [], outcomes: [] }, true)).toBe('waiting on parent reply');
  });

  it.each(ALL_STATUSES)('applies native permission attention only to live status %s', status => {
    const result = deriveAttention({ status, hasPendingPermission: true });
    expect(result.rung === 'needs-permission').toBe(status === 'running' || status === 'waiting');
  });

  it('keeps queued worker wakes and usage holds distinct from open queued waits', () => {
    expect(deriveAttention({ status: RUN_STATUS.queued, waits: [workerEntry({ phase: WAIT_PHASE.resolved })] }).rung).toBe('waiting-for-capacity');
    expect(deriveAttention({ status: RUN_STATUS.queued, waits: [workerEntry()] }).rung).toBe('queued');
    expect(deriveAttention({ status: RUN_STATUS.queued, waitingOn: { kind: 'usage-limit', at: '2026-10-30T12:00:00Z' } }).rung).toBe('usage-limit');
    expect(deriveAttention({ status: RUN_STATUS.waiting, delegation: { role: 'invalid' }, waits: [workerEntry({ phase: WAIT_PHASE.resolved }), workerEntry()] }).rung).toBe('waiting-on-workers');
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: 'malformed' as never }).rung).toBe('needs-you');
  });

  it('reads native subagents as the robot glyph without a pulse, and outranks a timer beside them', () => {
    const subagents = makeSubagentWait({ children: [{ id: 'a', status: SUBAGENT_STATUS.running }, { id: 'b', status: SUBAGENT_STATUS.completed }] });
    const timer = makeTimerWait({ deadline: '2026-10-26T00:01:00.000Z' });
    const attention = deriveAttention({ status: RUN_STATUS.waiting, waits: [timer, subagents] });
    expect(attention).toEqual({ rung: 'waiting-on-subagents', bucket: 'none', tone: 'running', shape: 'workers', pulse: false, label: 'waiting for 1 subagent' });
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [subagents, workerEntry()] }).rung).toBe('waiting-on-workers');
    expect(deriveAttention({ status: RUN_STATUS.waiting, waits: [makeSubagentWait({ phase: WAIT_PHASE.resolved })] }).rung).toBe('waiting-for-capacity');
  });

  // hearsay-tools/cezarion#2588: a child two open entries name is one running subagent.
  it('counts each running subagent once across open subagent waits', () => {
    const first = makeSubagentWait({ children: [{ id: 'a', status: SUBAGENT_STATUS.running }] });
    const second = makeSubagentWait({ id: '66666666-6666-4666-8666-666666666662', children: [{ id: 'a', status: SUBAGENT_STATUS.running }, { id: 'b', status: SUBAGENT_STATUS.running }] });
    expect(computeWaitingOn({ waits: [first, second] })).toEqual({ kind: 'subagents', count: 2 });
  });

  it.each([0, 1, 2])('labels %i peer tasks and preserves the webhook catch-all', count => {
    const input: AttentionInput = { status: RUN_STATUS.waiting, waitingOn: { kind: 'peers', count } };
    expect(deriveAttention(input).label).toBe(['waiting on tasks', 'waiting on 1 task', 'waiting on 2 tasks'][count]);
    expect(deriveWebhookState(input)).toBe('waiting-other');
  });
});
