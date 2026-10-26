import { describe, expect, it } from 'vitest';
import { advancePendingHumanAsk } from './ask.ts';
import { askRequestSchema } from './ask-schema.ts';
import type { RunEvent } from './events.ts';
import {
  advancePendingAsk, askCardOf, askOf, askPayloadOf, askRequestOf, askStatusFields, pendingAskOf,
  type AskCardFields, type PendingAsk,
} from './pending-ask.ts';

/**
 * hearsay-tools/cezarion#1808: one projection replaced the copies in the transcript facts, the
 * status command, the webhook, the cockpit card and the worker request. Each table below keeps the
 * deleted copy as its oracle, as it was on `main` at a53a37d0e, and asserts the projection answers
 * the same for every transcript.
 */
const choice = [{ header: 'Choice', question: 'Which module?', options: [{ label: 'Parser' }, { label: 'Runner', description: 'The executor' }] }];
const open = [{ header: 'Name', question: 'What should it be called?' }, { header: 'Tags', question: 'Which tags?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true }];
const rejected = [{ header: 'A header over twelve characters', question: 'Which?' }];

let seq = 0;
const ev = (type: string, fields: Record<string, unknown> = {}): RunEvent => ({ seq: ++seq, ts: '2026-10-26T00:00:00.000Z', type, ...fields });
const ask = (fields: Record<string, unknown>) => ev('ask.requested', { requestId: 'ask', questions: choice, ...fields });

/** Each case is a transcript; `pending` names the ask index, if any, that the run still waits on. */
const transcripts: Array<{ name: string; events: () => RunEvent[] }> = [
  { name: 'an ask with context', events: () => [ask({ context: '## Findings' })] },
  { name: 'an ask without context', events: () => [ask({})] },
  { name: 'open and multiSelect questions', events: () => [ask({ context: 'Two.', questions: open })] },
  { name: 'an empty context', events: () => [ask({ context: '' })] },
  { name: 'a context that is not a string', events: () => [ask({ context: 42 })] },
  { name: 'a newer ask replacing the first', events: () => [ask({ requestId: 'a', context: 'old', questions: open }), ask({ requestId: 'b' })] },
  { name: 'an ask a human answered', events: () => { const a = ask({ context: 'ctx' }); return [a, ev('human-input-delivered', { askSeq: a.seq, source: 'human' })]; } },
  { name: 'an ask its parent answered', events: () => { const a = ask({}); return [a, ev('human-input-delivered', { askSeq: a.seq, source: 'parent' })]; } },
  { name: 'an ask Finish closed', events: () => { const a = ask({}); return [a, ev('human-ask-closed', { askSeq: a.seq, reason: 'finish' })]; } },
  { name: 'a delivery that names another ask', events: () => { const a = ask({ context: 'ctx' }); return [a, ev('human-input-delivered', { askSeq: a.seq + 99 })]; } },
  { name: 'an ask the questions schema rejects', events: () => [ask({ questions: rejected })] },
  { name: 'a valid ask then a rejected one', events: () => [ask({ context: 'kept' }), ask({ requestId: 'bad', questions: rejected })] },
  { name: 'an ask with no requestId', events: () => [ev('ask.requested', { questions: choice })] },
  { name: 'an ask with a requestId that is not a string', events: () => [ev('ask.requested', { requestId: 7, questions: choice })] },
  { name: 'no ask', events: () => [ev('text', { text: 'hello' }), ev('turn.completed', {})] },
  { name: 'an ask after unrelated events', events: () => [ev('text', {}), ask({ context: 'late' }), ev('text', {}), ev('worker-question-routed', { askSeq: 1, messageId: 'm' })] },
];

/** The deleted copies. */
const old = {
  // packages/cezar/src/runs/transcript-facts-fold.ts `foldEvent`, the lines that held `pendingAsk`
  facts(events: RunEvent[]) {
    let pending: { seq: number; requestId: string; questions: unknown; context?: unknown } | undefined;
    for (const event of events) {
      const marker = pending && ({ type: 'ask.requested', seq: pending.seq, ts: '' } as RunEvent);
      const next = advancePendingHumanAsk(marker, event);
      if (next === event) pending = { seq: event.seq, requestId: event.requestId as string, questions: event.questions, ...(event.context !== undefined ? { context: event.context } : {}) };
      else if (next === undefined && pending) pending = undefined;
    }
    return pending;
  },
  // packages/cezar/src/task-cli/cli.ts and packages/cezar/src/runs/webhook.ts `pendingQuestion`, over the
  // context events the server derives: the one pending ask and nothing else of that type.
  question(events: RunEvent[]) {
    let pending: RunEvent | undefined;
    for (const event of events) pending = advancePendingHumanAsk(pending, event);
    const ask = [...(pending ? [pending] : [])].reverse().find((event) => event.type === 'ask.requested');
    return ask ? { questions: ask.questions, context: ask.context } : undefined;
  },
  // packages/web/src/routes/task-thread/thread-fold-reducers.ts `reduceAskRequested`, without the fold
  card(event: RunEvent) {
    const requestId = typeof event.requestId === 'string' ? event.requestId : undefined;
    const questions = Array.isArray(event.questions)
      ? event.questions.filter((q) => typeof q === 'object' && q !== null && !Array.isArray(q) && typeof q.header === 'string' && (q.options === undefined || Array.isArray(q.options)))
      : [];
    if (requestId === undefined || questions.length === 0) return undefined;
    const context = typeof event.context === 'string' && event.context !== '' ? event.context : undefined;
    return { id: requestId, questions, ...(context ? { context } : {}), askSeq: event.seq };
  },
  // packages/cezar/src/workflows/run.ts `routeWorkerQuestion`
  request(ask: { questions: unknown; context?: unknown }) {
    const parsed = askRequestSchema.safeParse({ questions: ask.questions, ...(ask.context !== undefined ? { context: ask.context } : {}) });
    return parsed.success ? parsed.data : undefined;
  },
};

describe('the pending ask', () => {
  describe.each(transcripts)('for $name', ({ events: build }) => {
    it('folds to the facts the transcript index kept, and to the same object on the fold step by step', () => {
      const events = build();
      expect(pendingAskOf(events)).toStrictEqual(old.facts(events));
      let pending: PendingAsk | undefined;
      for (const event of events) pending = advancePendingAsk(pending, event) as PendingAsk | undefined;
      expect(pending).toStrictEqual(old.facts(events));
    });

    it('gives the status command and the webhook the questions and context the server derived', () => {
      const events = build();
      const pending = pendingAskOf(events);
      const expected = old.question(events);
      expect(pending && { questions: pending.questions, ...(pending.context !== undefined ? { context: pending.context } : {}) })
        .toStrictEqual(expected && { questions: expected.questions, ...(expected.context !== undefined ? { context: expected.context } : {}) });
      expect(askStatusFields(pending)).toStrictEqual(pending ? { question: expected!.questions, questionContext: expected!.context } : {});
    });

    it('gives every ask event the card the reducer built', () => {
      for (const event of build().filter((candidate) => candidate.type === 'ask.requested')) {
        const found = askOf(event);
        expect(found && askCardOf(found)).toStrictEqual(old.card(event));
      }
    });

    it('gives the worker the request it was sent', () => {
      const pending = pendingAskOf(build());
      if (pending) expect(askRequestOf(pending)).toStrictEqual(old.request(pending));
    });
  });

  it('keeps the same pending object while unrelated events pass, and starts a new one for a newer ask', () => {
    const first = ask({ requestId: 'a' });
    const kept = advancePendingAsk(undefined, first) as PendingAsk;
    expect(advancePendingAsk(kept, ev('text', {}))).toBe(kept);
    expect(advancePendingAsk(kept, ev('human-input-delivered', { askSeq: first.seq + 99 }))).toBe(kept);
    const second = ask({ requestId: 'b' });
    expect(advancePendingAsk(kept, second)).toStrictEqual({ seq: second.seq, requestId: 'b', questions: choice });
    expect(advancePendingAsk(kept, ev('human-input-delivered', { askSeq: first.seq }))).toBeUndefined();
  });

  it('keeps routing flags a caller added to the pending object', () => {
    const first = ask({});
    const withRouting = { ...(advancePendingAsk(undefined, first) as PendingAsk), routedMessageId: 'm' };
    expect(advancePendingAsk(withRouting, ev('text', {}))).toBe(withRouting);
  });

  it('reads the payload of a live runner event, which has no seq', () => {
    expect(askPayloadOf({ type: 'ask.requested', requestId: 'live', questions: choice })).toStrictEqual({ requestId: 'live', questions: choice });
    expect(askPayloadOf({ type: 'ask.requested', requestId: 'live', questions: choice, context: 'ctx' })).toStrictEqual({ requestId: 'live', questions: choice, context: 'ctx' });
    expect(askPayloadOf({ type: 'ask.requested', questions: choice })).toBeUndefined();
    expect(askPayloadOf({ type: 'turn.started', requestId: 'live', questions: choice })).toBeUndefined();
  });

  it('builds the worker request from the questions alone when asked to', () => {
    // run.ts leaves the context out of the wait a native ask opens (hearsay-tools/cezarion#1234).
    expect(askRequestOf({ questions: choice })).toStrictEqual({ questions: choice });
    expect(askRequestOf({ questions: rejected })).toBeUndefined();
    expect(askRequestOf({ questions: choice, context: 42 })).toBeUndefined();
  });
});

/**
 * The guard behind "a new ask field reaches every reader through one edit". `OUTPUTS` must name
 * every key of `PendingAsk`, so a field added to the interface fails the typecheck here until it is
 * placed on the card and in the status fields, or left off one with a reason, and the test below
 * then fails if a placed field does not arrive.
 */
const OUTPUTS: Record<keyof PendingAsk, { card?: keyof AskCardFields; status?: string }> = {
  seq: { card: 'askSeq' },
  requestId: { card: 'id' },
  questions: { card: 'questions', status: 'question' },
  context: { card: 'context', status: 'questionContext' },
};

describe('a field of the ask', () => {
  const full: Required<PendingAsk> = { seq: 9, requestId: 'r-9', questions: choice, context: '## Draft' };

  it.each(Object.entries(OUTPUTS) as Array<[keyof PendingAsk, { card?: keyof AskCardFields; status?: string }]>)('%s reaches the outputs it is placed on', (key, placed) => {
    const card = askCardOf(full)!;
    const status = askStatusFields(full) as Record<string, unknown>;
    if (placed.card) expect(card[placed.card]).toStrictEqual(full[key]);
    if (placed.status) expect(status[placed.status]).toStrictEqual(full[key]);
    expect(Object.keys(card).sort()).toStrictEqual(Object.values(OUTPUTS).flatMap((output) => output.card ?? []).sort());
    expect(Object.keys(status).sort()).toStrictEqual(Object.values(OUTPUTS).flatMap((output) => output.status ?? []).sort());
  });
});
