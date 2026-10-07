import { describe, expect, it } from 'vitest';
import { advancePendingHumanAsk, pendingHumanAsk, type RunEvent } from '@open-mercato/cezar-contract';
import { emptyFacts, foldEvent, foldText, PROSE_HUMAN_GATE, workerOutcomeKey } from './transcript-facts.ts';

const questions = [{ header: 'Pick', question: 'Which one?', multiSelect: false, options: [{ label: 'A' }, { label: 'B' }] }];
let seq = 0;
const ev = (type: string, fields: Record<string, unknown> = {}): RunEvent => ({ seq: ++seq, ts: '2026-10-07T00:00:00.000Z', type, ...fields });
const ask = (requestId = 'r') => ev('ask.requested', { requestId, questions });

describe('transcript facts fold', () => {
  it('indexes projection ids once', () => {
    const facts = emptyFacts();
    expect(foldEvent(facts, ev('conversation-message', { projectionId: 'p:1' }))).toBe(true);
    expect(foldEvent(facts, ev('request-outcome', { projectionId: 'p:2' }))).toBe(true);
    expect(foldEvent(facts, ev('conversation-message', { projectionId: 'p:1' }))).toBe(false);
    expect(facts.projectionIds).toEqual(['p:1', 'p:2']);
  });

  it('tracks the pending ask and its delivery receipt', () => {
    const facts = emptyFacts();
    const asked = ask();
    expect(foldEvent(facts, asked)).toBe(true);
    expect(facts.pendingAsk).toEqual({ seq: asked.seq, requestId: 'r', questions });
    expect(foldEvent(facts, ev('human-input-delivered', { askSeq: asked.seq - 1 }))).toBe(false);
    expect(facts.pendingAsk?.seq).toBe(asked.seq);
    expect(foldEvent(facts, ev('human-input-delivered', { askSeq: asked.seq }))).toBe(true);
    expect(facts.pendingAsk).toBeUndefined();
  });

  it('records routing and fallback for the current ask only', () => {
    const facts = emptyFacts();
    const asked = ask();
    foldEvent(facts, asked);
    expect(foldEvent(facts, ev('worker-question-routed', { askSeq: asked.seq - 1, messageId: 'old' }))).toBe(false);
    expect(foldEvent(facts, ev('worker-question-routed', { askSeq: asked.seq, messageId: 'm' }))).toBe(true);
    expect(facts.pendingAsk?.routedMessageId).toBe('m');
    // The first routing wins, as routedAsk's `find` did.
    expect(foldEvent(facts, ev('worker-question-routed', { askSeq: asked.seq, messageId: 'later' }))).toBe(false);
    expect(facts.pendingAsk?.routedMessageId).toBe('m');
    expect(foldEvent(facts, ev('worker-question-fallback', { askSeq: asked.seq, reason: 'x' }))).toBe(true);
    expect(facts.pendingAsk?.fallback).toBe(true);
  });

  it('a new ask drops the previous routing', () => {
    const facts = emptyFacts();
    const first = ask('one');
    foldEvent(facts, first);
    foldEvent(facts, ev('worker-question-routed', { askSeq: first.seq, messageId: 'm' }));
    foldEvent(facts, ev('worker-question-fallback', { askSeq: first.seq, reason: 'x' }));
    const second = ask('two');
    foldEvent(facts, second);
    expect(facts.pendingAsk).toEqual({ seq: second.seq, requestId: 'two', questions });
  });

  it('tracks a prose human gate like pendingHumanAskSeq', () => {
    const facts = emptyFacts();
    const gate = ev('note', { code: PROSE_HUMAN_GATE, message: 'need a human' });
    expect(foldEvent(facts, gate)).toBe(true);
    expect(facts.pendingGateSeq).toBe(gate.seq);
    expect(facts.pendingAsk).toBeUndefined();
    expect(foldEvent(facts, ev('human-input-delivered', { askSeq: gate.seq }))).toBe(true);
    expect(facts.pendingGateSeq).toBeUndefined();
  });

  it('keys worker outcomes by wait, worker and revision', () => {
    const facts = emptyFacts();
    expect(foldEvent(facts, ev('worker-outcome', { waitId: 'w', outcome: { workerId: 'x', status: 'done' } }))).toBe(true);
    expect(foldEvent(facts, ev('worker-outcome', { waitId: 'w', outcome: { workerId: 'x', status: 'done', revision: 0 } }))).toBe(false);
    expect(foldEvent(facts, ev('worker-outcome', { waitId: 'w', outcome: { workerId: 'x', status: 'done', revision: 2 } }))).toBe(true);
    expect(facts.workerOutcomeKeys).toEqual([workerOutcomeKey('w', 'x', 0), 'w:x:2']);
    expect(workerOutcomeKey('w', 'x', 0)).toBe('w:x:0');
  });

  it('advances lastSeq without reporting a persisted change', () => {
    const facts = emptyFacts();
    const text = ev('text', { text: 'hello' });
    expect(foldEvent(facts, text)).toBe(false);
    expect(facts.lastSeq).toBe(text.seq);
  });

  it('matches the readEvents derivations on a recorded transcript', () => {
    seq = 0;
    const events: RunEvent[] = [];
    const push = (event: RunEvent) => { events.push(event); return event; };
    for (let i = 0; i < 40; i++) {
      push(ev('text', { text: `token ${i}` }));
      if (i % 7 === 0) push(ev('item.completed', { item: { kind: 'message', role: 'assistant', text: 'x' } }));
      if (i % 9 === 0) push(ev('conversation-message', { projectionId: `conversation-message:${i}:queued` }));
      if (i === 5) { const a = push(ask('a')); push(ev('worker-question-routed', { askSeq: a.seq, messageId: 'ma' })); push(ev('human-input-delivered', { askSeq: a.seq, source: 'parent' })); }
      if (i === 12) push(ev('note', { code: PROSE_HUMAN_GATE, message: 'gate' }));
      if (i === 20) push(ev('worker-outcome', { waitId: 'w1', outcome: { workerId: 'k', revision: 1 } }));
      if (i === 30) { const b = push(ask('b')); push(ev('worker-question-routed', { askSeq: b.seq, messageId: 'mb' })); }
    }
    const text = `${events.map((event) => JSON.stringify(event)).join('\n')}\n{not json\n`;
    const facts = emptyFacts();
    foldText(facts, text);

    expect(facts.bytes).toBe(Buffer.byteLength(text));
    expect(facts.lastSeq).toBe(events.at(-1)!.seq);
    expect(new Set(facts.projectionIds)).toEqual(new Set(events.map((event) => event.projectionId).filter((id) => id !== undefined)));
    // routedAsk's derivation
    const pending = pendingHumanAsk(events);
    expect(facts.pendingAsk?.seq).toBe(pending?.seq);
    const routed = events.find((event) => event.type === 'worker-question-routed' && event.askSeq === pending?.seq);
    expect(facts.pendingAsk?.routedMessageId).toBe(routed?.messageId);
    expect(!!facts.pendingAsk?.fallback).toBe(events.some((event) => event.type === 'worker-question-fallback' && event.askSeq === pending?.seq));
    // pendingHumanAskSeq's derivation
    let gate: RunEvent | undefined;
    for (const event of events) gate = event.type === 'note' && event.code === PROSE_HUMAN_GATE ? event : advancePendingHumanAsk(gate, event);
    expect(facts.pendingGateSeq).toBe(gate?.seq);
    expect(facts.workerOutcomeKeys).toEqual(['w1:k:1']);
  });
});
