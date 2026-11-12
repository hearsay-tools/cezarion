import { waitPartDescribers, parentWithWorker, parentTurn, nativeWire, retryAtOnce, toolResources, prompted, sessionOf, fireTimer, settled, inputsFor, timerText, github, pr, parkedOn, waitOfKind, agentWaits, turnEnds, flushMicrotasks, expectPoolCapacity, timerWaits, humanOpen } from './waits-parity-fixture.testkit.ts';
import { MAX_AUTO_CONTINUES } from './run.ts';
import { randomUUID } from 'node:crypto';
import { setRunStatus } from '../runs/run-store.testkit.ts';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { it as registerTest, vi, expect } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { STEP_STATUS, WAIT_KIND, WAIT_VIA, WAIT_SOURCE, RUN_STATUS, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { ToolsUnavailableError, CiToolController } from '../ci-wait/controller.ts';
import { manager, until, store, semaphore, toolGenerationOf, restart, root, terminal } from './worker-wait-core.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { recordCommits } from '../runs/outcome-crash.testkit.ts';
import { toolCall } from './waits-parity.testkit.ts';
import { productName } from '../home/display.ts';

// The registration part of the wait parity cells (`WAIT_PARITY_PARTS` in `waits-parity-catalog.testkit.ts`).
// A wait parity file imports this module first, so it loads no other part's cells (hearsay-tools/cezarion#3242).
export const { describeWaitParity } = waitPartDescribers('registration', registrationCells);

export function registrationCells(runners: RunnerId[], it: typeof registerTest = registerTest): void {
  for (const runner of runners) {
    for (const [kind, row] of [['worker', 'U28w'], ['request', 'U28r'], ['peer', 'U28p']] as const) {
      it(`${runner} ${row} ${kind} accepts a two-hour wait on the native wire and names the range above it`, async () => {
        const { p, w } = await parentWithWorker(runner);
        const peer = store.createRun({ title: 'peer', task: 'peer', workflow: 'quick-task', runner: 'claude', steps: [] });
        setRunStatus(store, peer.id, RUN_STATUS.running, { delegation: { role: 'root', permissions: ['spawn', 'wait', 'steer', 'inspect'], receipts: [] } });
        const requestId = randomUUID();
        store.commitConversation(p.id, { messages: [{ id: requestId, senderRunId: p.id, recipientRunId: w.id,
          kind: 'request', text: 'Review the result', createdAt: new Date().toISOString(),
          deadline: new Date(Date.now() + 7_200_000).toISOString(), requestHash: 'a'.repeat(64), state: 'accepted' }], outcomes: [] });
        const target = kind === 'worker' ? { worker_ids: [w.id] } : kind === 'request' ? { request_ids: [requestId] } : { peer_ids: [peer.id] };
        const bad = toolCall('cezar_wait', { kind, ...target, timeout_seconds: 7201 });
        const good = toolCall('cezar_wait', { kind, ...target, timeout_seconds: 7200 });
        await parentTurn(p.id, `${bad} ${good}`, () => agentWaits(p.id).length === 1);
        const [wait] = agentWaits(p.id);
        expect(wait).toMatchObject({ timeoutSeconds: 7200, phase: WAIT_PHASE.open, via: WAIT_VIA.cezar_wait });
        expect(Date.parse(('deadline' in wait! ? wait.deadline : undefined)!) - Date.parse(wait!.registeredAt)).toBe(7_200_000);
        // The native mock emits the tool's actual refusal as its response text.
        expect(JSON.stringify(store.readEvents(p.id))).toContain('must be an integer between 1 and 7200');
        expect(JSON.stringify(store.readEvents(p.id))).toContain('invalid_request');
      });
    }

    it(`${runner} U26 a launch whose Squawk tools cannot start fails with the cause, frees its slot, and the next launch after the repair is taught the tools`, async () => {
      nativeWire(runner);
      retryAtOnce();
      const resources = toolResources.current!;
      const broken = () => vi.spyOn(resources, 'controller').mockRejectedValueOnce(new ToolsUnavailableError("ENOSPC: no space left on device, mkdtemp '/tmp/cez-ci-XXXXXX'", '/tmp'));
      const cause = new RegExp(String.raw`${productName('Cezar')} tools could not start: ENOSPC: no space left on device, mkdtemp '\/tmp\/cez-ci-XXXXXX'\. .*Free space in \/tmp or fix its permissions, then Continue the task\.`);
      // A fresh start: nothing spawns, the step and the run fail with the cause.
      broken();
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: `${HARNESS_ADAPTERS[runner].scenarios.baseline!} u26-opening` });
      await until(() => store.getRun(run.id)?.status === 'failed' && !manager.isActive(run.id));
      expect(store.getRun(run.id)?.error).toMatch(cause);
      expect(store.getRun(run.id)?.steps[0]).toMatchObject({ status: STEP_STATUS.failed, error: expect.stringMatching(cause) });
      expect(prompted(runner, 'u26-opening')).toEqual([]);
      // Its slot is free: at maxParallel 1 another task starts.
      expect(semaphore.maxParallel()).toBe(1);
      const other = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: `${HARNESS_ADAPTERS[runner].scenarios.baseline!} u26-other` });
      await until(() => prompted(runner, 'u26-other').length > 0 && store.getRun(other.id)?.status === 'waiting');
      sessionOf(other.id).end();
      await until(() => !manager.isActive(other.id));
      // The repair: Continue starts the tools and the session learns them.
      expect(manager.continueRun(run.id, { text: 'u26-continue' }).ok).toBe(true);
      await until(() => prompted(runner, 'u26-continue').length > 0 && store.getRun(run.id)?.status === 'waiting');
      // A wake with no live session: the failed launch keeps the result, and the retry delivers it.
      const handlers = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
      const registered = await handlers.registerWait({ kind: WAIT_KIND.timer, seconds: 60, note: 'u26-wake' }, 'cezar_wait', new AbortController().signal);
      if (!('wait' in registered)) throw Error('registration refused');
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      broken();
      fireTimer(registered.wait.id);
      await until(() => settled(run.id, registered.wait.id)?.phase === 'delivered' && prompted(runner, 'u26-wake').length > 0 && store.getRun(run.id)?.status === 'waiting');
      expect(store.getRun(run.id)?.steps.filter(step => step.status === 'failed').map(step => step.error)).toEqual([expect.stringMatching(cause), expect.stringMatching(cause)]);
      expect(inputsFor(run.id, registered.wait.id).map(input => input.text)).toEqual([timerText(registered.wait, 'u26-wake')]);
    });

    it(`${runner} U1 ci and timer register through cezar_wait on the native wire, park, and wake with their result`, async () => {
      const external = github();
      nativeWire(runner);
      const provision = vi.spyOn(CiToolController.prototype, 'provision');
      const initial = toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr, timeout_seconds: 30 });
      const changed = toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr, timeout_seconds: 60 });
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: `${initial} ${initial} ${changed}`, runner });
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'pr')));
      const ci = waitOfKind(run.id, 'pr')!;
      expect(ci).toMatchObject({ via: WAIT_VIA.cezar_wait, source: WAIT_SOURCE.agent, prUrl: pr, timeoutSeconds: 30 });
      expect(store.getRun(run.id)?.waitRegistrations).toMatchObject([{ wait: { id: ci.id }, deduplicated: false }, { wait: { id: ci.id }, deduplicated: true }]);
      expect(agentWaits(run.id)).toHaveLength(1);
      expect(manager.isActive(run.id)).toBe(true);
      // The wait outlives its session: a Continue's registration for the same PR returns it.
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      const boundaries = turnEnds(run.id);
      expect(manager.continueRun(run.id, { text: initial }).ok).toBe(true);
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'pr')) && turnEnds(run.id) > boundaries);
      expect(store.getRun(run.id)?.waitRegistrations?.at(-1)).toMatchObject({ wait: { id: ci.id }, deduplicated: true });
      expect(agentWaits(run.id)).toMatchObject([{ id: ci.id }]);
      // A recovery keeps it, and its result wakes the run with one observation.
      await restart();
      expect(manager.isActive(run.id)).toBe(false);
      expect(store.getRun(run.id)?.status).toBe(RUN_STATUS.waiting);
      expect(agentWaits(run.id)).toMatchObject([{ id: ci.id, phase: WAIT_PHASE.open }]);
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered');
      expect(inputsFor(run.id, ci.id).map(input => input.text)).toEqual([expect.stringContaining(`CI wait observation ${ci.id} for ${pr}`)]);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      // Each session, fresh, continued and woken after recovery, gets its own tool descriptor.
      const descriptors = provision.mock.results.filter(result => result.type === 'return').map(result => result.value.descriptor.name);
      expect(descriptors.length).toBeGreaterThanOrEqual(3);
      expect(new Set(descriptors).size).toBe(descriptors.length);

      expect(manager.sendMessage(run.id, [{ type: 'text', text: toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'u1' }) }])).toBe(true);
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'timer')));
      const timer = waitOfKind(run.id, 'timer')!;
      expect(timer).toMatchObject({ via: WAIT_VIA.cezar_wait, seconds: 60, note: 'u1' });
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'delivered');
      expect(inputsFor(run.id, timer.id).map(input => input.text)).toEqual([timerText(timer, 'u1')]);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(agentWaits(run.id)).toEqual([]);
    });

    it(`${runner} U4 cezar_cancel_wait cancels and no observation is delivered`, async () => {
      const external = github();
      nativeWire(runner);
      const opened = toolCall('cezar_wait', { kind: WAIT_KIND.pr, pr }), cancelled = toolCall('cezar_cancel_wait', { wait_id: 'last' });
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: `${opened} ${cancelled}`, runner });
      await until(() => store.getRun(run.id)?.lastWaits?.some(wait => wait.kind === 'pr') === true && store.getRun(run.id)?.status === 'waiting');
      const ci = store.getRun(run.id)!.lastWaits!.find(wait => wait.kind === 'pr')!;
      expect(ci).toMatchObject({ phase: WAIT_PHASE.cancelled, via: WAIT_VIA.cezar_wait });
      expect(external.aborted()).toBe(true);
      const turns = store.readEvents(run.id).filter(event => event.type === 'turn-end').length;
      external.settle();
      await flushMicrotasks();
      expect(inputsFor(run.id, ci.id)).toEqual([]);

      const timerOpened = toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'u4' });
      expect(manager.sendMessage(run.id, [{ type: 'text', text: `${timerOpened} ${cancelled}` }])).toBe(true);
      await until(() => store.getRun(run.id)?.lastWaits?.some(wait => wait.kind === 'timer') === true
        && store.readEvents(run.id).filter(event => event.type === 'turn-end').length > turns);
      const timer = store.getRun(run.id)!.lastWaits!.find(wait => wait.kind === 'timer')!;
      expect(timer).toMatchObject({ phase: WAIT_PHASE.cancelled, note: 'u4' });
      fireTimer(timer.id);
      await flushMicrotasks();
      expect(inputsFor(run.id, timer.id)).toEqual([]);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(inputsFor(run.id, timer.id)).toEqual([]);
      expect(agentWaits(run.id)).toEqual([]);
    });

    it(`${runner} U10 timer wakes stop at the automatic-wake budget; one admitted turn is charged once`, async () => {
      nativeWire(runner);
      const release = join(root, 'u10-release');
      process.env.CEZ_MOCK_RELEASE_FILE = release;
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios['hold-gated']!, runner });
      await until(() => store.readEvents(run.id).some(event => event.type === 'turn.started'));
      const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
      const open = async (seconds: number, note: string) => {
        const registered = await tools.registerWait({ kind: WAIT_KIND.timer, seconds, note }, 'cezar_wait', new AbortController().signal);
        if (!('wait' in registered)) throw Error('registration refused');
        return registered.wait;
      };
      const first = await open(60, 'u10 first'), second = await open(61, 'u10 second'), last = await open(62, 'u10 last');
      store.updateRun(run.id, { automaticWakes: 39, waitDeliveryFailures: 2 });
      // What a crash after any commit would leave (hearsay-tools/cezarion#1805): every committed row.
      const commits = recordCommits(join(root, '.ai/cezar'));
      // Two timers resolve before one boundary: one admitted turn carries both and spends one wake.
      fireTimer(first.id); fireTimer(second.id);
      await until(() => store.getRun(run.id)?.waits?.filter(wait => wait.phase === 'resolved').length === 2);
      writeFileSync(release, '');
      await until(() => settled(run.id, first.id)?.phase === 'delivered' && settled(run.id, second.id)?.phase === 'delivered');
      await until(() => prompted(runner, timerText(first, 'u10 first')).length > 0);
      expect(prompted(runner, timerText(first, 'u10 first')).at(-1)).toContain(timerText(second, 'u10 second'));
      expect(store.getRun(run.id)?.automaticWakes).toBe(40);
      const charged = store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith('automatic timer wake-up ('));
      expect(charged.map(event => event.message)).toEqual(['automatic timer wake-up (40/40)']);
      // The delivery, its charge and the cleared failure count are one commit: no committed row
      // holds a delivered timer without its charge.
      commits.expectEveryCommit(run.id, row => !row.lastWaits?.some(wait => [first.id, second.id].includes(wait.id) && wait.phase === 'delivered') ||
        (row.automaticWakes === 40 && row.waitDeliveryFailures === undefined && row.lastWaits.filter(wait => wait.phase === 'delivered').length === 2), 'a delivered timer and its charge');
      expect(commits.rows(run.id).some(row => row?.lastWaits?.some(wait => wait.id === first.id && wait.phase === 'delivered'))).toBe(true);
      await until(() => parkedOn(run.id, store.getRun(run.id)?.waits?.find(wait => wait.id === last.id)));
      const turns = turnEnds(run.id);
      // The budget is spent: the next timer to come due is cancelled and wakes nothing.
      fireTimer(last.id);
      await until(() => settled(run.id, last.id)?.phase === 'cancelled');
      await flushMicrotasks();
      expect(inputsFor(run.id, last.id)).toEqual([]);
      expect(prompted(runner, `Timer ${last.id} fired`)).toEqual([]);
      expect(turnEnds(run.id)).toBe(turns);
      expect(store.readEvents(run.id).some(event => event.type === 'note' && event.message === `automatic timer wake-up cap reached (40); timer ${last.id} cancelled`)).toBe(true);
      // hearsay-tools/cezarion#1234: the spent budget leaves a Squawk human wait, so the run waits on the user.
      expect(store.getRun(run.id)?.waits ?? []).toMatchObject([{ kind: WAIT_KIND.human, via: WAIT_VIA.budget, source: WAIT_SOURCE.cezar, phase: WAIT_PHASE.open }]);
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      await expectPoolCapacity(runner, run.id, false);
    });

    it(`${runner} U10 a timer due while a charged batch awaits its acknowledgement is cancelled at the cap, and CI still wakes`, async () => {
      const external = github();
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios.baseline!, runner });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
      const open = async (request: Parameters<typeof tools.registerWait>[0]) => {
        const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
        if (!('wait' in registered)) throw Error('registration refused');
        return registered.wait;
      };
      const first = await open({ kind: WAIT_KIND.timer, seconds: 60, note: 'u10 first' });
      const second = await open({ kind: WAIT_KIND.timer, seconds: 61, note: 'u10 second' });
      const ci = await open({ kind: WAIT_KIND.pr, pr, timeout_seconds: 600 });
      const session = sessionOf(run.id);
      store.updateRun(run.id, { automaticWakes: 39 });
      // The first wake reaches the native wire; its provider acknowledgement is held.
      let release!: () => void;
      const gate = new Promise<void>(resolve => { release = resolve; });
      const send = session.sendAgentMessage.bind(session);
      vi.spyOn(session, 'sendAgentMessage').mockImplementation((content, ids) => {
        const ack = send(content, ids);
        return ack && ack.then(() => gate);
      });
      fireTimer(first.id);
      await until(() => prompted(runner, timerText(first, 'u10 first')).length > 0);
      expect(settled(run.id, first.id)).toBeUndefined();
      // The pending batch already holds the last wake of the budget.
      fireTimer(second.id);
      await until(() => settled(run.id, second.id)?.phase === 'cancelled');
      expect(inputsFor(run.id, second.id)).toEqual([]);
      release();
      await until(() => settled(run.id, first.id)?.phase === 'delivered');
      expect(store.getRun(run.id)?.automaticWakes).toBe(40);
      const notes = () => store.readEvents(run.id).filter(event => event.type === 'note').map(event => String(event.message));
      expect(notes().filter(note => note.startsWith('automatic timer wake-up ('))).toEqual(['automatic timer wake-up (40/40)']);
      expect(notes()).toContain(`automatic timer wake-up cap reached (40); timer ${second.id} cancelled`);
      expect(prompted(runner, `Timer ${second.id} fired`)).toEqual([]);
      // A CI result is an external event: it still wakes the agent at the cap and is not charged.
      await until(() => parkedOn(run.id, waitOfKind(run.id, 'pr')));
      external.settle();
      await until(() => settled(run.id, ci.id)?.phase === 'delivered' && prompted(runner, `CI wait observation ${ci.id}`).length > 0);
      expect(store.getRun(run.id)?.automaticWakes).toBe(40);
    });
    // hearsay-tools/cezarion#1234: the budget is on the record, so a new session does not refill it.
    it(`${runner} U16 a scheduler continuation keeps the automatic-wake budget and a human Continue resets it`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const { timer } = await timerWaits(run.id);
      store.updateRun(run.id, { automaticWakes: 39 });
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'delivered');
      expect(store.getRun(run.id)?.automaticWakes).toBe(40);
      expect(store.readEvents(run.id).filter(event => event.type === 'note' && String(event.message).startsWith('automatic timer wake-up ('))
        .map(event => event.message)).toEqual(['automatic timer wake-up (40/40)']);
      await until(() => store.getRun(run.id)?.status === 'waiting' && manager.isActive(run.id));
      const tools = manager.squawkToolHandlers(run.id, toolGenerationOf(run.id));
      const refused = await tools.registerWait({ kind: WAIT_KIND.timer, seconds: 60 }, 'cezar_wait', new AbortController().signal);
      expect(refused.answer).toMatchObject({ ok: false, code: 'wake_budget_spent' });
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      expect(manager.continueRun(run.id, { text: 'carry on' }).ok).toBe(true);
      expect(store.getRun(run.id)?.automaticWakes).toBe(0);
      await until(() => store.getRun(run.id)?.status === 'waiting');
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    // Recovery fires an overdue timer before any session exists. At the spent budget it wakes
    // nothing, and once no wait is left the run must still wait on the user through a wait.
    it(`${runner} U16b timers due at the spent budget with no live session are cancelled, and the last one opens a budget human wait the user answers`, async () => {
      nativeWire(runner);
      const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: HARNESS_ADAPTERS[runner].scenarios.baseline! });
      await until(() => store.getRun(run.id)?.status === 'waiting');
      const { timer, later } = await timerWaits(run.id);
      store.updateRun(run.id, { automaticWakes: MAX_AUTO_CONTINUES });
      sessionOf(run.id).end();
      await until(() => !manager.isActive(run.id));
      fireTimer(timer.id);
      await until(() => settled(run.id, timer.id)?.phase === 'cancelled');
      // The other timer is still open: the run waits on it, not on the user.
      expect(humanOpen(run.id)).toEqual([]);
      fireTimer(later.id);
      await until(() => settled(run.id, later.id)?.phase === 'cancelled' && humanOpen(run.id)[0]?.askSeq !== undefined);
      expect(humanOpen(run.id)).toMatchObject([{ via: WAIT_VIA.budget, source: WAIT_SOURCE.cezar, phase: WAIT_PHASE.open }]);
      expect(store.getRun(run.id)?.status).toBe('waiting');
      expect(deriveAttention(store.getRun(run.id)!).label).toBe('needs you');
      expect(manager.isActive(run.id)).toBe(false);
      const [budget] = humanOpen(run.id);
      const commits = recordCommits(join(root, '.ai/cezar'));
      expect(manager.continueRun(run.id, { text: 'carry on' }).ok).toBe(true);
      await until(() => settled(run.id, budget!.id)?.phase === 'delivered');
      expect(store.getRun(run.id)?.automaticWakes ?? 0).toBe(0);
      // hearsay-tools/cezarion#1805: the restarted budget and the answered wait are committed with
      // the Continue they come from, never before it.
      const step = store.getRun(run.id)!.steps.at(-1)!.id;
      commits.expectEveryCommit(run.id, row => {
        return (row.automaticWakes === MAX_AUTO_CONTINUES && !row.lastWaits?.some(wait => wait.id === budget!.id && wait.phase === 'delivered')) ||
          row.continuationMessage?.text === 'carry on' || row.steps.some(entry => entry.id === step && entry.status !== 'pending');
      }, 'a restarted budget and its Continue');
      await until(() => store.getRun(run.id)?.status === 'waiting' && manager.isActive(run.id));
      expect(manager.finish(run.id)).toBe(true);
      await until(() => terminal.includes(store.getRun(run.id)?.status ?? ''));
    });

    // Clearing the wake counters is bookkeeping: a refused write may not stop a cleanup from
    // stopping the run.
  }
}
