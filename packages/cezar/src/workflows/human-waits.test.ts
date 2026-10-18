import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { deriveAttention, toRunSummary, type CezarWaitRequest, type HumanWaitEntry } from '@open-mercato/cezar-contract';
import type { AgentSession } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CredentialRegistry } from '../delegation/credentials.ts';
import { DelegationService } from '../delegation/service.ts';
import { PROSE_HUMAN_GATE } from '../runs/transcript-facts.ts';
import { readPersistedRuns } from '../runs/run-store.testkit.ts';
import { eventCheckpoint, manager, parent, restart, root, semaphore, store, until, useWorkerWaitFixture, worker } from './worker-wait.testkit.ts';
import { messagesPrompt } from './monitoring-turn.testkit.ts';
import { MAX_AUTO_CONTINUES } from './run.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { toolCall } from './waits-parity.testkit.ts';

// hearsay-tools/cezarion#1234: the human kind of the wait list on the Claude wire. The rules are
// runner-neutral (RUNNER_IDS coverage is U7h and U9h in `waits-parity.test.ts`); the runner,
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
  waitTimers: Map<string, { timer: NodeJS.Timeout & { _onTimeout(): void } }>;
};
const tools = (id: string) => manager.cezarToolHandlers(id, engine().active.get(id)!.ciGeneration);
const register = (id: string, request: CezarWaitRequest) => tools(id).registerWait(request, 'cezar_wait', new AbortController().signal);
const turnStarted = (id: string) => store.readEvents(id).some(event => event.type === 'turn.started');
const asks = (id: string) => store.readEvents(id).filter(event => event.type === 'ask.requested');
const gates = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && event.code === PROSE_HUMAN_GATE);
const humanOpen = (id: string) => store.getRun(id)?.waits?.filter((wait): wait is HumanWaitEntry => wait.kind === 'human') ?? [];
const settled = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(wait => wait.id === waitId);
// A card sets `hasPendingHumanAsk`; the gate (no card) reads Needs you from the park alone.
const needsYou = (id: string) => store.getRun(id)?.status === 'waiting' && deriveAttention(store.getRun(id)!).label === 'needs you';

describe('human waits (hearsay-tools/cezarion#1234)', { timeout: 45_000 }, () => {
  useWorkerWaitFixture();
  afterEach(() => vi.restoreAllMocks());

  it('a mid-turn human message settles an unsurfaced human wait', async () => {
    const { run, release } = await heldTurn();
    const registered = await register(run.id, { kind: 'human', questions: card('Which module?') });
    if (!('wait' in registered)) throw Error('registration refused');
    expect(manager.sendMessage(run.id, [{ type: 'text', text: 'Start with the parser.' }])).toBe(true);
    expect(settled(run.id, registered.wait.id)).toMatchObject({ phase: 'delivered' });
    expect(humanOpen(run.id)).toEqual([]);
    release();
    // The held turn ends, then the message runs as its own turn.
    await until(() => store.getRun(run.id)?.status === 'waiting' && store.readEvents(run.id).filter(event => event.type === 'turn-end').length >= 2);
    // The question is answered already: its turn end raises no card.
    expect(asks(run.id)).toEqual([]);
    expect(gates(run.id)).toEqual([]);
  });

  it('a second registration in one turn replaces the card and keeps the wait_id', async () => {
    const { run, release } = await heldTurn();
    const first = await register(run.id, { kind: 'human', questions: card('Which module?') });
    const second = await register(run.id, { kind: 'human', questions: card('Which runner?') });
    expect(first.answer).toMatchObject({ ok: true, kind: 'human' });
    expect(second.answer).toMatchObject({ ok: true, kind: 'human' });
    if (!first.answer.ok || !second.answer.ok) throw Error('registration refused');
    expect(second.answer.wait_id).toBe(first.answer.wait_id);
    expect(humanOpen(run.id)).toMatchObject([{ id: first.answer.wait_id, questions: card('Which runner?') }]);
    release();
    await until(() => needsYou(run.id));
    expect(asks(run.id)).toMatchObject([{ questions: card('Which runner?') }]);
    expect(humanOpen(run.id)).toMatchObject([{ id: first.answer.wait_id, askSeq: asks(run.id)[0]!.seq }]);
    // An earlier turn's question still pending: a new registration returns it unchanged.
    const again = await register(run.id, { kind: 'human', questions: card('Which library?') });
    expect(again.answer).toMatchObject({ ok: true, wait_id: first.answer.wait_id });
    expect(humanOpen(run.id)).toMatchObject([{ questions: card('Which runner?') }]);
    expect(asks(run.id)).toHaveLength(1);
  });

  it('cezar_cancel_wait refuses a surfaced human wait with human_question', async () => {
    const { run, release } = await heldTurn();
    // Not yet shown (the same turn): the agent may withdraw it.
    const withdrawn = await register(run.id, { kind: 'human', questions: card('Which module?') });
    if (!('wait' in withdrawn)) throw Error('registration refused');
    expect(await tools(run.id).cancelWait({ wait_id: withdrawn.wait.id })).toMatchObject({ cancelled: true });
    const kept = await register(run.id, { kind: 'human', questions: card('Which runner?') });
    if (!('wait' in kept)) throw Error('registration refused');
    release();
    await until(() => needsYou(run.id));
    const refused = await tools(run.id).cancelWait({ wait_id: kept.wait.id });
    expect(refused).toMatchObject({ cancelled: false, code: 'human_question', open_waits: [{ wait_id: kept.wait.id, kind: 'human' }] });
    expect(humanOpen(run.id)).toMatchObject([{ id: kept.wait.id, phase: 'open' }]);
    expect(needsYou(run.id)).toBe(true);
  });

  it('an autonomous run refuses cezar_wait human with autonomous_run until the budget is spent', async () => {
    const { run } = await heldTurn({ autonomous: true });
    const refused = await register(run.id, { kind: 'human', questions: card('Which module?') });
    expect(refused.answer).toEqual({ ok: false, code: 'autonomous_run', open_waits: [],
      message: 'This is an autonomous run: do not wait for the user. Make a reasonable assumption and continue; the user can steer you at any time.' });
    expect(humanOpen(run.id)).toEqual([]);
    store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES });
    expect((await register(run.id, { kind: 'human', questions: card('Which module?') })).answer).toMatchObject({ ok: true, kind: 'human' });
    expect(humanOpen(run.id)).toHaveLength(1);
  });

  it('a worker without questions is refused with questions_required; with questions it routes to the parent and the parent reply settles the wait', async () => {
    process.env.CEZ_DELEGATION = '1';
    claudeWire();
    const p = await parent();
    const delegation = store.getRun(p.id)!.delegation!;
    if (delegation.role !== 'root') throw Error('missing root');
    store.commitDelegation([{ id: p.id, delegation: { ...delegation, permissions: [...delegation.permissions, 'steer'] } }]);
    await until(() => store.getRun(p.id)?.status === 'waiting');
    const gate = join(root, 'release');
    process.env.CEZ_MOCK_RELEASE_FILE = gate;
    const w = await worker(p.id, HARNESS_ADAPTERS.claude.scenarios['hold-gated']!);
    manager.enqueueOwnedRun(w.id);
    await until(() => engine().active.get(w.id)?.session?.open === true && turnStarted(w.id));
    const bare = await register(w.id, { kind: 'human' });
    expect(bare.answer).toEqual({ ok: false, code: 'questions_required', open_waits: [],
      message: 'A worker\'s question goes to its parent as a card: call again with questions.' });
    const registered = await register(w.id, { kind: 'human', questions: card('Which module?') });
    if (!('wait' in registered)) throw Error('registration refused');
    writeFileSync(gate, '');
    await until(() => store.readEvents(w.id).some(event => event.type === 'worker-question-routed') && store.getRun(w.id)?.status === 'waiting');
    const routed = store.readEvents(w.id).find(event => event.type === 'worker-question-routed')!;
    expect(routed).toMatchObject({ askSeq: asks(w.id)[0]!.seq, parentRunId: p.id });
    const credentials = new CredentialRegistry();
    try {
      const caller = credentials.authenticate(credentials.issue('project', p.id, randomUUID()))!;
      const service = new DelegationService();
      service.registerProject({ id: 'project', root, store, manager });
      await service.send(caller, { id: randomUUID(), recipientRunId: w.id, kind: 'reply', requestId: String(routed.messageId), text: 'Choice: Parser', timeoutSeconds: 600 });
      await until(() => settled(w.id, registered.wait.id)?.phase === 'delivered');
      expect(store.readEvents(w.id).filter(event => event.type === 'human-input-delivered')).toMatchObject([{ askSeq: asks(w.id)[0]!.seq, source: 'parent' }]);
    } finally { credentials.close(); }
  });

  it('recovery surfaces an unsurfaced human wait', async () => {
    const { run } = await heldTurn();
    const registered = await register(run.id, { kind: 'human', questions: card('Which module?') });
    if (!('wait' in registered)) throw Error('registration refused');
    // The process dies mid-turn, after the registration and before its turn end.
    const events = eventCheckpoint();
    const disk = readPersistedRuns(join(root, '.ai/cezar'));
    await restart(false, disk, events);
    await until(() => needsYou(run.id));
    expect(asks(run.id)).toMatchObject([{ questions: card('Which module?') }]);
    expect(humanOpen(run.id)).toMatchObject([{ id: registered.wait.id, askSeq: asks(run.id)[0]!.seq }]);
    expect(toRunSummary(store.getRun(run.id)!).waitingOn).toEqual({ kind: 'human' });
    expect(manager.isActive(run.id)).toBe(false);
  });

  it('the monitoring line with re-checks off opens a monitoring-line human wait', async () => {
    claudeWire();
    vi.spyOn(semaphore, 'monitoringWakeIntervalMinutes').mockReturnValue(null);
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: messagesPrompt('claude', ['Still waiting for the load test.\nCEZ:MONITORING']), runner: 'claude' });
    await until(() => needsYou(run.id));
    expect(humanOpen(run.id)).toMatchObject([{ via: 'monitoring-line', source: 'agent', phase: 'open', askSeq: gates(run.id)[0]!.seq }]);
    expect(humanOpen(run.id)[0]?.questions).toBeUndefined();
    expect(store.getRun(run.id)?.waits?.some(wait => wait.kind === 'timer')).toBe(false);
    expect(asks(run.id)).toEqual([]);
    expect(toRunSummary(store.getRun(run.id)!).waitingOn).toEqual({ kind: 'human' });
  });

  it('a timer cancelled at the budget with nothing else open opens a budget human wait', async () => {
    claudeWire();
    const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: toolCall('cezar_wait', { kind: 'timer', seconds: 60, note: 'recheck' }), runner: 'claude' });
    await until(() => store.getRun(run.id)?.status === 'waiting' && store.getRun(run.id)?.waits?.some(wait => wait.kind === 'timer') === true);
    const timer = store.getRun(run.id)!.waits!.find(wait => wait.kind === 'timer')!;
    store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES });
    engine().waitTimers.get(timer.id)!.timer._onTimeout();
    await until(() => needsYou(run.id));
    expect(settled(run.id, timer.id)?.phase).toBe('cancelled');
    expect(humanOpen(run.id)).toMatchObject([{ via: 'budget', source: 'cezar', phase: 'open', askSeq: gates(run.id)[0]!.seq }]);
    expect(toRunSummary(store.getRun(run.id)!).waitingOn).toEqual({ kind: 'human' });
  });
});
