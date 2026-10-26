import { describe, expect, it } from 'vitest';
import { workerOutcomeSchema } from './delegation.ts';
import { humanAskClosedEventSchema, humanInputDeliveredEventSchema, runEventSchema } from './events.ts';
import { runRecordSchema, runStatusSchema, stepStateSchema, stepStatusSchema } from './runs.ts';
import { waitPhaseSchema, waitSchema, waitViaSchema } from './waits.ts';
import {
  RUN_STATUS,
  STEP_KIND,
  STEP_STATUS,
  WAIT_KIND,
  WAIT_PHASE,
  WAIT_SOURCE,
  WAIT_VIA,
  WORKER_OUTCOME_STATUS,
  makeHumanAskClosedEvent,
  makeHumanInputDeliveredEvent,
  makeHumanWait,
  makePrWait,
  makeProcessWait,
  makeRunEvent,
  makeRunRecord,
  makeStepState,
  makeTimerWait,
  makeWorkerRequestWait,
  makeWorkerWait,
} from './test-factories.testkit.ts';

/**
 * The typed test factories (hearsay-tools/cezarion#1812). A fixture built here is valid by the
 * contract's own schemas, and one that names a field the contract no longer has fails to compile.
 */

describe('the run record factory', () => {
  it('builds a record the contract accepts, and a step it accepts', () => {
    expect(runRecordSchema.parse(makeRunRecord())).toMatchObject({ status: 'done', archived: false });
    expect(stepStateSchema.parse(makeStepState())).toMatchObject({ kind: 'agent' });
  });

  it('applies the overrides over the defaults and keeps the rest', () => {
    const record = makeRunRecord({ status: RUN_STATUS.running, title: 'mine', steps: [makeStepState({ status: STEP_STATUS.running })] });
    expect(record).toMatchObject({ status: 'running', title: 'mine', workflow: 'quick-task' });
    expect(record.steps[0]).toMatchObject({ status: 'running', kind: 'agent' });
  });

  it('gives each record its own id unless a test names one', () => {
    expect(makeRunRecord().id).not.toBe(makeRunRecord().id);
    expect(makeRunRecord({ id: 'mine' }).id).toBe('mine');
  });

  it('refuses a field the contract does not have, at compile time', () => {
    // `tsc` reports an unused directive here when the factory stops checking its overrides, so a
    // renamed `RunRecord` field cannot stay in a test unseen. The run proves only that it builds.
    // @ts-expect-error not a RunRecord field
    const record = makeRunRecord({ notARunRecordField: 1 });
    expect(record).toBeDefined();
    // @ts-expect-error a status the contract does not have
    expect(makeRunRecord({ status: 'finished' })).toBeDefined();
    // @ts-expect-error not a step field
    expect(makeStepState({ notAStepField: 1 })).toBeDefined();
  });
});

describe('the wait factories', () => {
  const all = () => [
    makeTimerWait(), makePrWait(), makeHumanWait(), makeWorkerWait(), makeWorkerRequestWait(), makeProcessWait(),
  ];

  it('build an entry the contract accepts, one for each kind', () => {
    const waits = all();
    for (const wait of waits) expect(waitSchema.parse(wait)).toEqual(wait);
    expect(waits.map((wait) => wait.kind)).toEqual([WAIT_KIND.timer, WAIT_KIND.pr, WAIT_KIND.human, WAIT_KIND.worker, WAIT_KIND.worker, WAIT_KIND.process]);
  });

  it('give each entry its own id, so a list of them has no duplicate', () => {
    const ids = [...all(), ...all()].map((wait) => wait.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('apply the overrides, and an entry stays valid with them', () => {
    const wait = makeTimerWait({ phase: WAIT_PHASE.resolved, via: WAIT_VIA['monitoring-line'], note: 'check CI' });
    expect(waitSchema.parse(wait)).toMatchObject({ kind: 'timer', phase: 'resolved', via: 'monitoring-line', note: 'check CI' });
    expect(makeWorkerRequestWait({ source: WAIT_SOURCE.cezar })).toMatchObject({ source: 'cezar' });
  });

  it('refuse a field the entry does not have, at compile time', () => {
    // @ts-expect-error a timer has no `pid`
    expect(makeTimerWait({ pid: 7 })).toBeDefined();
    // @ts-expect-error a phase the contract does not have
    expect(makeHumanWait({ phase: 'parked' })).toBeDefined();
  });
});

describe('the event factories', () => {
  it('build an event with a sequence number and a time, and keep every key a test adds', () => {
    const event = makeRunEvent({ type: 'ask.requested', requestId: 'q' });
    expect(runEventSchema.parse(event)).toMatchObject({ type: 'ask.requested', requestId: 'q' });
    expect(makeRunEvent({ type: 'x' }).seq).not.toBe(makeRunEvent({ type: 'x' }).seq);
  });

  it('build the typed events the contract names', () => {
    const delivered = makeHumanInputDeliveredEvent({ askSeq: 3 });
    expect(humanInputDeliveredEventSchema.parse(delivered)).toMatchObject({ type: 'human-input-delivered', askSeq: 3 });
    const closed = makeHumanAskClosedEvent({ askSeq: 3, reason: 'finish' });
    expect(humanAskClosedEventSchema.parse(closed)).toMatchObject({ type: 'human-ask-closed', reason: 'finish' });
  });
});

describe('the enum constants', () => {
  it('hold exactly the values the contract schemas hold, so none is written twice', () => {
    expect(Object.values(RUN_STATUS).sort()).toEqual([...runStatusSchema.options].sort());
    expect(Object.values(STEP_STATUS).sort()).toEqual([...stepStatusSchema.options].sort());
    expect(Object.values(STEP_KIND).sort()).toEqual([...stepStateSchema.shape.kind.options].sort());
    expect(Object.values(WAIT_PHASE).sort()).toEqual([...waitPhaseSchema.options].sort());
    expect(Object.values(WAIT_VIA).sort()).toEqual([...waitViaSchema.options].sort());
    expect(Object.values(WAIT_KIND).sort()).toEqual(waitSchema.options.map((entry) => entry.shape.kind.value).sort());
    expect(Object.values(WORKER_OUTCOME_STATUS).sort()).toEqual([...workerOutcomeSchema.shape.status.options].sort());
  });

  it('name a via value the way a test reads it', () => {
    expect(WAIT_VIA.cezar_ask).toBe('cezar_ask');
    expect(WAIT_VIA['monitoring-line']).toBe('monitoring-line');
  });
});
