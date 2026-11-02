import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { runInternals } from './run-internals.testkit.ts';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cezarDoneAnswerSchema } from '@open-mercato/cezar-contract/waits';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { toRunSummary } from '@open-mercato/cezar-contract/runs';
import type { AskQuestion, HumanWaitEntry } from '@open-mercato/cezar-contract';
import type { AgentSession } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { handoffInstructions } from '../handoff.ts';
import { PROSE_HUMAN_GATE } from '../runs/transcript-facts.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { eventCheckpoint, manager, parent, restart, root, semaphore, store, terminal, until, delegatingParent, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';
import { messagesPrompt } from './monitoring-turn.testkit.ts';
import { MAX_AUTO_CONTINUES, NO_WAIT_NUDGE_NOTE } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { toolCall } from './waits-parity.testkit.ts';

// hearsay-tools/cezarion#1234: the human kind of the wait list on the Claude wire. The rules are
// runner-neutral (RUNNER_IDS coverage is U7h and U9h in `waits-parity-cells.testkit.ts`); the runner,
// store, tool handlers and scheduler stay real.

const card = (question: string) => [{ header: 'Choice', question, options: [{ label: 'Parser' }, { label: 'Runner' }] }];

function claudeWire() {
  process.env.CEZ_DRY_RUN = '0';
  process.env.CEZ_CLAUDE_BIN = HARNESS_ADAPTERS.claude.mockBin;
}

/** A turn the mock holds until `release()`: registrations in it land mid-turn. */
async function heldTurn(options: { autonomous?: boolean } = {}) {
  claudeWire();
  const gate = join(root, 'release');
  process.env.CEZ_MOCK_RELEASE_FILE = gate;
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios['hold-gated']!, runner: 'claude', ...options });
  await until(() => engine().active.get(run.id)?.session?.open === true && turnStarted(run.id));
  return { run, release: () => writeFileSync(gate, '') };
}

const engine = () => manager as unknown as {
  active: Map<string, { session?: AgentSession & { end(): void }; ciGeneration: string }>;

};
const tools = (id: string) => manager.cezarToolHandlers(id, engine().active.get(id)!.ciGeneration);
const ask = (id: string, questions: AskQuestion[], context = '## Draft\n\nThe plan.') => tools(id).ask({ context, questions }, new AbortController().signal);
const turnStarted = (id: string) => store.readEvents(id).some(event => event.type === 'turn.started');
const asks = (id: string) => store.readEvents(id).filter(event => event.type === 'ask.requested');
const gates = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && event.code === PROSE_HUMAN_GATE);
const humanOpen = (id: string) => store.getRun(id)?.waits?.filter((wait): wait is HumanWaitEntry => wait.kind === 'human') ?? [];
const settled = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(wait => wait.id === waitId);
// A card sets `hasPendingHumanAsk`; the gate (no card) reads Needs you from the park alone.
const needsYou = (id: string) => store.getRun(id)?.status === 'waiting' && deriveAttention(store.getRun(id)!).rung === 'needs-you';

describe('human waits (hearsay-tools/cezarion#1234)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture({ nudgeReply: 'card' });
  afterEach(() => vi.restoreAllMocks());

  it('a mid-turn human message settles an unsurfaced human wait', async () => {
    const { run, release } = await heldTurn();
    const registered = await ask(run.id, card('Which module?'));
    if (!registered.ok) throw Error('registration refused');
    expect(humanOpen(run.id)).toMatchObject([{ id: registered.wait_id, source: 'agent', via: 'cezar_ask', questions: card('Which module?') }]);
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Start with the parser.' }])).toBe(true);
    expect(settled(run.id, registered.wait_id)).toMatchObject({ phase: 'delivered' });
    expect(humanOpen(run.id)).toEqual([]);
    release();
    // The held turn ends, then the message runs as its own turn.
    await until(() => store.getRun(run.id)?.status === 'waiting' && store.readEvents(run.id).filter(event => event.type === 'turn-end').length >= 2);
    // The question is answered already: no turn end raises it again. The message's own turn end
    // gets the no-wait nudge, which the mock answers with a card of its own (phase 2b).
    expect(asks(run.id).map(event => event.questions)).toEqual([[expect.objectContaining({ header: 'Next step' })]]);
    expect(gates(run.id)).toEqual([]);
  });

  it('a second registration in one turn replaces the card and keeps the wait_id', async () => {
    const { run, release } = await heldTurn();
    const first = await ask(run.id, card('Which module?'), 'First draft');
    const second = await ask(run.id, card('Which runner?'), 'Second draft');
    if (!first.ok || !second.ok) throw Error('registration refused');
    expect(second.wait_id).toBe(first.wait_id);
    // hearsay-tools/cezarion#1458: the replacement card brings its own context.
    expect(humanOpen(run.id)).toMatchObject([{ id: first.wait_id, context: 'Second draft', questions: card('Which runner?') }]);
    release();
    await until(() => needsYou(run.id));
    expect(asks(run.id)).toMatchObject([{ context: 'Second draft', questions: card('Which runner?') }]);
    expect(humanOpen(run.id)).toMatchObject([{ id: first.wait_id, askSeq: asks(run.id)[0]!.seq }]);
    // An earlier turn's question still pending: a new registration returns it unchanged.
    const again = await ask(run.id, card('Which library?'));
    expect(again).toMatchObject({ ok: true, wait_id: first.wait_id });
    expect(humanOpen(run.id)).toMatchObject([{ questions: card('Which runner?') }]);
    expect(asks(run.id)).toHaveLength(1);
  });

  it('cezar_cancel_wait refuses a surfaced human wait with human_question', async () => {
    const { run, release } = await heldTurn();
    // Not yet shown (the same turn): the agent may withdraw it.
    const withdrawn = await ask(run.id, card('Which module?'));
    if (!withdrawn.ok) throw Error('registration refused');
    expect(await tools(run.id).cancelWait({ wait_id: withdrawn.wait_id }, new AbortController().signal)).toMatchObject({ cancelled: true });
    const kept = await ask(run.id, card('Which runner?'));
    if (!kept.ok) throw Error('registration refused');
    release();
    await until(() => needsYou(run.id));
    const refused = await tools(run.id).cancelWait({ wait_id: kept.wait_id }, new AbortController().signal);
    expect(refused).toMatchObject({ cancelled: false, code: 'human_question', open_waits: [{ wait_id: kept.wait_id, kind: 'human' }] });
    expect(humanOpen(run.id)).toMatchObject([{ id: kept.wait_id, phase: 'open' }]);
    expect(needsYou(run.id)).toBe(true);
  });

  // hearsay-tools/cezarion#1234: a question without options reaches the user as an open question.
  it('an open question is shown as a card question without options', async () => {
    const { run, release } = await heldTurn();
    const open = [{ header: 'Name', question: 'What should the command be called?' }];
    expect(await ask(run.id, [...card('Which module?'), ...open])).toMatchObject({ ok: true });
    release();
    await until(() => needsYou(run.id));
    expect(asks(run.id)).toMatchObject([{ questions: [...card('Which module?'), ...open] }]);
    expect((asks(run.id)[0] as unknown as { questions: object[] }).questions[1]).not.toHaveProperty('options');
  });

  it('an autonomous run refuses cezar_ask with autonomous_run until the budget is spent', async () => {
    const { run } = await heldTurn({ autonomous: true });
    const refused = await ask(run.id, card('Which module?'));
    expect(refused).toEqual({ ok: false, code: 'autonomous_run', open_waits: [],
      message: 'This is an autonomous run: do not wait for the user. Make a reasonable assumption and continue; the user can steer you at any time.' });
    expect(humanOpen(run.id)).toEqual([]);
    store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES });
    expect(await ask(run.id, card('Which module?'))).toMatchObject({ ok: true });
    expect(humanOpen(run.id)).toHaveLength(1);
  });

  // The handlers return their refusals, so the MCP server and the `/api/v1/tools/ask` route carry
  // the code and its message to the agent unchanged; only a thrown non-wait error reads `unavailable`.
  it('a refusal reaches the agent through the wire with its own code and message', async () => {
    claudeWire();
    const answers = join(root, 'answers');
    process.env.CEZ_MOCK_CI_RESULT = answers;
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_ask', { context: 'c', questions: card('Which module?') }), runner: 'claude', autonomous: true });
    await until(() => existsSync(answers));
    const answer = JSON.parse(JSON.parse(readFileSync(answers, 'utf8')).response.content[0].text.split('\n')[0]);
    expect(answer).toMatchObject({ ok: false, code: 'autonomous_run',
      message: 'This is an autonomous run: do not wait for the user. Make a reasonable assumption and continue; the user can steer you at any time.' });
    expect(humanOpen(run.id)).toEqual([]);
  });

  it('a worker\'s question routes to the parent and the parent reply settles the wait', async () => {
    claudeWire();
    const { p, service, callerFor, close } = await delegatingParent({ permissions: ['spawn', 'wait', 'steer'] });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const gate = join(root, 'release');
    process.env.CEZ_MOCK_RELEASE_FILE = gate;
    const w = await worker(p.id, HARNESS_ADAPTERS.claude.scenarios['hold-gated']!);
    manager.enqueueOwnedRun(w.id);
    await until(() => engine().active.get(w.id)?.session?.open === true && turnStarted(w.id));
    const registered = await ask(w.id, card('Which module?'));
    if (!registered.ok) throw Error('registration refused');
    writeFileSync(gate, '');
    await until(() => store.readEvents(w.id).some(event => event.type === 'worker-question-routed') && store.getRun(w.id)?.status === 'waiting');
    const routed = store.readEvents(w.id).find(event => event.type === 'worker-question-routed')!;
    expect(routed).toMatchObject({ askSeq: asks(w.id)[0]!.seq, parentRunId: p.id });
    // hearsay-tools/cezarion#1458: the parent reads the worker's context with the question.
    const parentDelegation = store.getRun(p.id)!.delegation!;
    if (parentDelegation.role !== 'root') throw Error('missing root');
    const question = parentDelegation.conversation!.messages.find(message => message.id === routed.messageId)!;
    expect(question.question).toMatchObject({ context: '## Draft\n\nThe plan.' });
    expect(question.text).toContain('Context:\n## Draft\n\nThe plan.\n\n1. [Choice] Which module?');
    try {
      const caller = callerFor(p.id);
      await service.send(caller, { id: randomUUID(), recipientRunId: w.id, kind: 'reply', requestId: String(routed.messageId), text: 'Choice: Parser', timeoutSeconds: 600 });
      await until(() => settled(w.id, registered.wait_id)?.phase === 'delivered');
      expect(store.readEvents(w.id).filter(event => event.type === 'human-input-delivered')).toMatchObject([{ askSeq: asks(w.id)[0]!.seq, source: 'parent' }]);
    } finally { close(); }
  });

  it('recovery surfaces an unsurfaced human wait', async () => {
    const { run } = await heldTurn();
    const registered = await ask(run.id, card('Which module?'), '## Findings\n\n- one');
    if (!registered.ok) throw Error('registration refused');
    // The process dies mid-turn, after the registration and before its turn end.
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar'));
    await restart(false, disk, events);
    await until(() => needsYou(run.id));
    // hearsay-tools/cezarion#1458: the context survives the restart, read from the stored wait.
    expect(asks(run.id)).toMatchObject([{ context: '## Findings\n\n- one', questions: card('Which module?') }]);
    expect(humanOpen(run.id)).toMatchObject([{ id: registered.wait_id, askSeq: asks(run.id)[0]!.seq }]);
    expect(toRunSummary(store.getRun(run.id)!).waitingOn).toEqual({ kind: 'human', shown: true });
    expect(manager.isActive(run.id)).toBe(false);
  });

  it('a timer cancelled at the budget with nothing else open opens a budget human wait', async () => {
    claudeWire();
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'recheck' }), runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting' && store.getRun(run.id)?.waits?.some(wait => wait.kind === 'timer') === true);
    const timer = store.getRun(run.id)!.waits!.find(wait => wait.kind === 'timer')!;
    store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES });
    runInternals(manager).waitWatches.waitTimers.get(timer.id)!.timer._onTimeout();
    await until(() => needsYou(run.id));
    expect(settled(run.id, timer.id)?.phase).toBe('cancelled');
    const [budget, ...more] = humanOpen(run.id);
    expect(more).toEqual([]);
    expect(budget).toMatchObject({ via: 'budget', source: 'cezar', phase: 'open' });
    // Cezar's own wait is shown as its note and raises no human gate (hearsay-tools/cezarion#1234).
    expect(store.readEvents(run.id).find(event => event.seq === budget!.askSeq))
      .toMatchObject({ type: 'note', message: `automatic-wake budget spent (${MAX_AUTO_CONTINUES}); waiting for you` });
    expect(gates(run.id)).toEqual([]);
    expect(toRunSummary(store.getRun(run.id)!).waitingOn).toEqual({ kind: 'human', shown: true });
  });
});

// hearsay-tools/cezarion#1234, hearsay-tools/cezarion#2397: every session is taught the tools,
// and a monitoring wake speaks them.
describe('the lifecycle prompt teaches the cezar tools', { timeout: 45_000 }, () => {
  useWorkerWaitFixture({ nudgeReply: 'card' });
  afterEach(() => vi.restoreAllMocks());

  /** The `--append-system-prompt` of every Claude process the mock started, oldest first. */
  const prompts = () => existsSync(join(root, 'args')) ? readFileSync(join(root, 'args'), 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as string[]).filter(argv => argv.includes('--append-system-prompt'))
    .map(argv => argv[argv.indexOf('--append-system-prompt') + 1]!) : [];
  function wire() {
    claudeWire();
    process.env.CEZ_MOCK_ARGS_FILE = join(root, 'args');
  }
  const opened = async () => {
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios.baseline!, runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting');
    return run;
  };

  it('a timer wake speaks the tools', async () => {
    wire();
    const run = await opened();
    expect(manager.sendMessage(run.id, [{ type: 'text', text: toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 120, note: 'recheck' }) }])).toBe(true);
    await until(() => store.getRun(run.id)?.status === 'waiting' && store.getRun(run.id)?.waits?.some(wait => wait.kind === 'timer') === true);
    const timer = store.getRun(run.id)!.waits!.find(wait => wait.kind === 'timer')!;
    runInternals(manager).waitWatches.waitTimers.get(timer.id)!.timer._onTimeout();
    await until(() => store.getRun(run.id)?.agentInputs?.some(input => input.id === timer.id) === true);
    expect(store.getRun(run.id)!.agentInputs!.find(input => input.id === timer.id)!.text)
      .toBe(`Timer ${timer.id} fired: recheck. Continue toward the task goal; register another wait if you are still waiting.`);
  });

  it('a session is taught the tools when it opens and when it continues', async () => {
    wire();
    const run = await opened();
    engine().active.get(run.id)!.session!.end();
    // The run waits on the card the mock answered the no-wait nudge with; Continue answers it.
    await until(() => !manager.isActive(run.id) && store.getRun(run.id)?.status === 'waiting');
    expect(manager.continueRun(run.id, { text: 'carry on' }).ok).toBe(true);
    await until(() => prompts().length === 2 && store.getRun(run.id)?.status === 'waiting');
    for (const prompt of prompts()) {
      expect(prompt).toContain(handoffInstructions({ handoffInjected: true }));
      for (const marker of ['CEZ:DONE', 'CEZ:ASK', 'CEZ:MONITORING']) expect(prompt).not.toContain(marker);
    }
  });

  // hearsay-tools/cezarion#2397: a session taught the markers before the upgrade gets no special
  // reading of them. The line is ordinary text, and the no-wait nudge names the tools.
  it('a done line is ordinary text: the turn gets the no-wait nudge, and the task does not finish', async () => {
    wire();
    const run = await opened();
    const nudges = () => store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE)).length;
    const before = nudges();
    expect(manager.sendMessage(run.id, [{ type: 'text', text: messagesPrompt('claude', ['All done.\nCEZ:DONE']) }])).toBe(true);
    await until(() => nudges() > before && store.getRun(run.id)?.status === 'waiting');
    expect(terminal).not.toContain(store.getRun(run.id)?.status);
    expect(store.readEvents(run.id).some(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed')).toBe(false);
  });
});

// hearsay-tools/cezarion#1234: a refusal that lists every blocking worker still fits the contract's
// message bound at worker capacity, so the controller never turns it into `unavailable`.
describe('cezar_done refusals at worker capacity', { timeout: 45_000 }, () => {
  useWorkerWaitFixture({ nudgeReply: 'card' });
  afterEach(() => vi.restoreAllMocks());

  const ids = () => Array.from({ length: 32 }, () => randomUUID());
  const internals = () => manager as unknown as {
    parentCompletionBlockers(id: string): { workerId: string; reason: string }[];
  };
  const done = (id: string) => tools(id).finishTurn({}, new AbortController().signal);

  it('every refusal naming 32 workers parses as a CezarDoneAnswer', async () => {
    claudeWire();
    // A parent parked on a timer, not on a question of its own: the worker checks decide.
    const p = await parent(toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 600, note: 'recheck' }), 'claude');
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const asked = vi.spyOn(runInternals(manager).workerQuestions, 'unansweredQuestions').mockReturnValue(ids().map(workerId => ({ workerId, messageId: randomUUID() })));
    const questions = await done(p.id);
    expect(cezarDoneAnswerSchema.safeParse(questions).success).toBe(true);
    expect(questions).toMatchObject({ ok: false, code: 'worker_questions' });
    expect(questions.ok === false && questions.workers).toHaveLength(32);
    expect(asked).toHaveBeenCalledWith(p.id);
    asked.mockReturnValue([]);
    const blockers = vi.spyOn(internals(), 'parentCompletionBlockers');
    for (const reason of ['outstanding', 'uncollected'] as const) {
      blockers.mockReturnValue(ids().map(workerId => ({ workerId, reason })));
      const refused = await done(p.id);
      expect(cezarDoneAnswerSchema.safeParse(refused).success).toBe(true);
      expect(refused).toMatchObject({ ok: false, code: reason === 'outstanding' ? 'workers_outstanding' : 'workers_uncollected' });
      expect(refused.ok === false && refused.workers).toHaveLength(32);
    }
  });
});
