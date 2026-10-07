import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { brotliCompressSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advancePendingHumanAsk, pendingHumanAsk, type RunEvent } from '@open-mercato/cezar-contract';
import { historyPaths } from './history-file.ts';
import { emptyFacts, foldEvent, foldText, PROSE_HUMAN_GATE, TranscriptFactsIndex, workerOutcomeKey } from './transcript-facts.ts';
import { countTranscriptReads, restoreTranscriptReads } from './transcript-reads.testkit.ts';

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

describe('transcript facts sidecar', () => {
  let dataDir: string;
  const id = '11111111-2222-4333-8444-555555555555';
  const line = (event: RunEvent) => `${JSON.stringify(event)}\n`;
  const plainPath = () => historyPaths(dataDir, id).plain;
  const factsPath = () => historyPaths(dataDir, id).facts;
  /** Append to the transcript and tell the index, as RunStore.appendEvent does. */
  const append = (index: TranscriptFactsIndex, event: RunEvent) => {
    const text = line(event);
    appendFileSync(plainPath(), text);
    index.append(id, event, Buffer.byteLength(text));
  };
  const fresh = () => { const facts = emptyFacts(); foldText(facts, readFileSync(plainPath(), 'utf8')); return facts; };

  beforeEach(() => {
    seq = 0;
    dataDir = mkdtempSync(join(tmpdir(), 'cez-facts-'));
    mkdirSync(join(dataDir, 'runs'));
  });
  afterEach(() => { restoreTranscriptReads(); rmSync(dataDir, { recursive: true, force: true }); });

  it('persists only when an indexed fact changes', () => {
    const index = new TranscriptFactsIndex(dataDir);
    // The first append loads the run, which saves the facts it built.
    append(index, ev('text', { text: 'hi' }));
    const saved = readFileSync(factsPath(), 'utf8');
    for (let i = 0; i < 5; i++) append(index, ev('text', { text: `t${i}` }));
    expect(readFileSync(factsPath(), 'utf8')).toBe(saved);
    append(index, ev('conversation-message', { projectionId: 'p:1' }));
    expect(statSync(factsPath()).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(factsPath(), 'utf8'))).toMatchObject({ version: 1, projectionIds: ['p:1'] });
  });

  it('trusts a sidecar whose size matches', () => {
    const writer = new TranscriptFactsIndex(dataDir);
    append(writer, ev('text', { text: 'hi' }));
    append(writer, ask());
    writer.flush();
    const reads = countTranscriptReads();
    expect(new TranscriptFactsIndex(dataDir).get(id)?.pendingAsk?.requestId).toBe('r');
    expect(reads.counts.files).toEqual([]);
  });

  it('folds an unindexed tail after restart', () => {
    const writer = new TranscriptFactsIndex(dataDir);
    append(writer, ev('conversation-message', { projectionId: 'p:1' }));
    // Another process generation appended without updating the sidecar.
    appendFileSync(plainPath(), line(ev('text', { text: 'tail' })) + line(ask('tail')));
    const reads = countTranscriptReads();
    const facts = new TranscriptFactsIndex(dataDir).get(id)!;
    expect(facts.pendingAsk?.requestId).toBe('tail');
    expect(facts.bytes).toBe(statSync(plainPath()).size);
    expect(reads.counts.files).toEqual([plainPath()]);
  });

  it('rebuilds when the tail does not start on a line boundary', () => {
    appendFileSync(plainPath(), line(ev('conversation-message', { projectionId: 'p:1' })) + line(ask('x')));
    writeFileSync(factsPath(), JSON.stringify({ ...emptyFacts(), bytes: 7 }));
    expect(new TranscriptFactsIndex(dataDir).get(id)).toEqual(fresh());
  });

  it('rebuilds when the transcript shrank', () => {
    appendFileSync(plainPath(), line(ask('x')));
    writeFileSync(factsPath(), JSON.stringify({ ...emptyFacts(), bytes: 10_000, projectionIds: ['stale'] }));
    expect(new TranscriptFactsIndex(dataDir).get(id)).toEqual(fresh());
  });

  it('rebuilds from a corrupt or unknown-version sidecar', () => {
    appendFileSync(plainPath(), line(ev('conversation-message', { projectionId: 'p:1' })));
    writeFileSync(factsPath(), '{not json');
    expect(new TranscriptFactsIndex(dataDir).get(id)).toEqual(fresh());
    writeFileSync(factsPath(), JSON.stringify({ ...fresh(), version: 2, projectionIds: [] }));
    expect(new TranscriptFactsIndex(dataDir).get(id)).toEqual(fresh());
  });

  it('rebuilds after the sidecar is deleted by hand', () => {
    const writer = new TranscriptFactsIndex(dataDir);
    append(writer, ev('conversation-message', { projectionId: 'p:1' }));
    rmSync(factsPath());
    expect(new TranscriptFactsIndex(dataDir).get(id)?.projectionIds).toEqual(['p:1']);
  });

  it('rebuilds from an archive without a sidecar', () => {
    const text = line(ev('conversation-message', { projectionId: 'p:1' })) + line(ask('x'));
    const { compressed } = historyPaths(dataDir, id);
    writeFileSync(compressed, brotliCompressSync(Buffer.from(text)));
    const facts = new TranscriptFactsIndex(dataDir).get(id)!;
    expect(facts.projectionIds).toEqual(['p:1']);
    expect(facts.bytes).toBe(Buffer.byteLength(text));
    const st = statSync(compressed);
    const persisted = JSON.parse(readFileSync(factsPath(), 'utf8'));
    expect(persisted.archive).toEqual({ size: st.size, mtimeMs: st.mtimeMs, ino: st.ino });
    const reads = countTranscriptReads();
    expect(new TranscriptFactsIndex(dataDir).get(id)?.pendingAsk?.requestId).toBe('x');
    expect(reads.counts.decompress).toBe(0);
    expect(reads.counts.files).toEqual([]);
  });

  it('answers empty facts for a run with no transcript, without writing', () => {
    expect(new TranscriptFactsIndex(dataDir).get(id)).toEqual(emptyFacts());
    expect(existsSync(factsPath())).toBe(false);
  });

  it('flushes advanced byte counts so the next process reads no tail', () => {
    const writer = new TranscriptFactsIndex(dataDir);
    append(writer, ev('conversation-message', { projectionId: 'p:1' }));
    for (let i = 0; i < 5; i++) append(writer, ev('text', { text: `t${i}` }));
    writer.flush();
    const reads = countTranscriptReads();
    expect(new TranscriptFactsIndex(dataDir).get(id)?.bytes).toBe(statSync(plainPath()).size);
    expect(reads.counts.files).toEqual([]);
  });
});
