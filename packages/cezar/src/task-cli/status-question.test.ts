import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { RunStore } from '../runs/store.ts';
import { startTestCockpit, type TestCockpit } from './cockpit.testkit.ts';
import { runTaskCommand, type TaskIo } from './cli.ts';
import type { Cockpit } from './http.ts';

/**
 * What `cez task status` prints for a pending question (hearsay-tools/cezarion#1808). The
 * question and its context come from the run's `ask.requested` event, through the cockpit's
 * history-context route, not from the human wait. Each case pins the printed JSON, so one
 * projection of the ask serves the CLI, the webhook and the card without a field changing spelling.
 */
const choice = [{ header: 'Choice', question: 'Which module?', options: [{ label: 'Parser' }, { label: 'Runner', description: 'The executor' }] }];
const open = [{ header: 'Name', question: 'What should it be called?' }, { header: 'Tags', question: 'Which tags?', options: [{ label: 'a' }, { label: 'b' }], multiSelect: true }];

describe('cez task status — the pending question', () => {
  let harness: TestCockpit;
  let store: RunStore;
  let cockpit: Cockpit;
  let out: string[];

  beforeEach(async () => {
    harness = await startTestCockpit();
    ({ store, cockpit } = harness);
    out = [];
  });

  afterEach(() => harness.close());

  const io = (): TaskIo => ({ stdout: (line) => out.push(line), stdin: async () => '', discover: async () => cockpit, open: () => {} });
  const status = async (id: string) => {
    expect(await runTaskCommand(['status', id], {}, io())).toBe(0);
    return JSON.parse(out.at(-1) ?? 'null') as Record<string, unknown>;
  };
  /** A run parked on a question the agent asked: the ask event, its open human wait, `waiting`. */
  const waitingOn = async (events: Array<Record<string, unknown>>) => {
    expect(await runTaskCommand(['start', 'do the thing'], {}, io())).toBe(0);
    const id = (JSON.parse(out.at(-1)!) as { id: string }).id;
    for (const event of events) store.appendEvent(id, { type: 'ask.requested', ...event });
    store.commitWait(id, { id: randomUUID(), kind: 'human', source: 'agent', via: 'cezar_ask', registeredAt: new Date().toISOString(), phase: 'open', turnId: 'turn-1' });
    store.updateRun(id, { status: 'waiting' });
    return id;
  };

  it('prints the questions and their context', async () => {
    const id = await waitingOn([{ requestId: 'ask-1', context: '## Findings', questions: choice }]);
    const printed = await status(id);
    expect(printed).toMatchObject({ status: 'waiting', attention: 'waiting', question: choice, questionContext: '## Findings' });
  });

  it('leaves questionContext off an ask without one', async () => {
    const id = await waitingOn([{ requestId: 'ask-1', questions: choice }]);
    const printed = await status(id);
    expect(printed).toMatchObject({ question: choice });
    expect(printed).not.toHaveProperty('questionContext');
  });

  it('prints open and multiSelect questions as stored', async () => {
    const id = await waitingOn([{ requestId: 'ask-1', context: 'Two questions.', questions: open }]);
    expect(await status(id)).toMatchObject({ question: open, questionContext: 'Two questions.' });
  });

  it('prints only the newest ask when a second replaced the first', async () => {
    const id = await waitingOn([{ requestId: 'ask-1', context: 'old', questions: open }, { requestId: 'ask-2', questions: choice }]);
    const printed = await status(id);
    expect(printed).toMatchObject({ question: choice });
    expect(printed).not.toHaveProperty('questionContext');
  });

  it('prints no question once a delivery answered it', async () => {
    const id = await waitingOn([{ requestId: 'ask-1', context: 'ctx', questions: choice }]);
    const asked = store.readEvents(id).find((event) => event.type === 'ask.requested')!;
    store.appendEvent(id, { type: 'human-input-delivered', askSeq: asked.seq, source: 'human' });
    const printed = await status(id);
    expect(printed).not.toHaveProperty('question');
    expect(printed).not.toHaveProperty('questionContext');
  });

  it('prints no question for an ask the questions schema rejects', async () => {
    const id = await waitingOn([{ requestId: 'ask-1', context: 'ctx', questions: [{ header: 'Far too long a header', question: 'Which?' }] }]);
    const printed = await status(id);
    expect(printed).not.toHaveProperty('question');
    expect(printed).not.toHaveProperty('questionContext');
  });
});
