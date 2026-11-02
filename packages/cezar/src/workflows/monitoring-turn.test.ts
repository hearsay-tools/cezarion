import { RUN_STATUS, WAIT_KIND, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { runInternals } from './run-internals.testkit.ts';
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, describe } from 'vitest';
import { deriveAttention, WEBHOOK_TRIGGERS } from '@open-mercato/cezar-contract/attention';
import type { ApiRun, TimerWaitEntry } from '@open-mercato/cezar-contract';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { attentionFields, projectStatus } from '../task-cli/projections.ts';
import { endsWait } from '../task-cli/watch.ts';
import { TaskWebhook, type TaskWebhookPayload } from '../runs/webhook.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { manager, store, root, worker, until, semaphore, useWorkerWaitFixture, register, waitOf } from './worker-wait.testkit.ts';
import { MONITORING_TURN_CRITERIA, messagesPrompt, ACK_TEXT } from './monitoring-turn.testkit.ts';
import { monitoringWakeOf } from './waits.testkit.ts';
import { thenSay, toolCall } from './waits-parity.testkit.ts';
import { hasPendingAsk } from '../runs/run-store.testkit.ts';

type MonitoringRun = NonNullable<ReturnType<typeof store.getRun>>;
interface TurnEndTracker { recorded: number; pending: Set<Promise<void>> }
interface RowContext {
  backend: RunnerId;
  runId: string;
  run(): MonitoringRun;
  attention(label: string, wants: boolean): void;
  /** One turn: the prompt is a `toolCall`/`thenSay` script or a `messagesPrompt`. */
  send(prompt: string): Promise<void>;
  turnEnds: TurnEndTracker;
}
type RowId = (typeof MONITORING_TURN_CRITERIA)[number]['id'];
interface RowSpec {
  /** Runs once the run is parked, before the webhook exists. */
  setup?(ctx: RowContext): Promise<void>;
  body(ctx: RowContext): Promise<void>;
  /** Runs after the webhook went idle and its last delivery matched the run's label. */
  webhook?(calls: TaskWebhookPayload[]): void;
}
const QUESTIONS = [{ header: 'Choice', question: 'Which module?', options: [{ label: 'Parser' }, { label: 'Runner' }] }];
const WAIT = toolCall('cezar_wait', { kind: WAIT_KIND.timer, seconds: 60, note: 'Re-check the load campaign.' });
const ASK = toolCall('cezar_ask', { context: 'The diagnostics are reviewed.', questions: QUESTIONS });
const DONE = toolCall('cezar_done', { summary: 'Complete.' });
const script = (...parts: string[]) => parts.join(' ');

/** The run's open `cezar_wait` timer: the monitoring a tool call opens. */
function agentTimer(run: MonitoringRun): TimerWaitEntry | undefined {
  return run.waits?.find((wait): wait is TimerWaitEntry => wait.kind === WAIT_KIND.timer && wait.phase === 'open' && wait.via === WAIT_VIA.cezar_wait);
}
function expectAgentTimer(run: MonitoringRun): TimerWaitEntry {
  const wait = agentTimer(run);
  expect(wait).toBeDefined();
  return wait!;
}

async function monitoringSurvivesAck({ runId, send, attention, run }: RowContext): Promise<void> {
  await send(script(WAIT, thenSay(ACK_TEXT)));
  attention('monitoring', false);
  const wait = expectAgentTimer(run());
  const timer = runInternals(manager).waitWatches.waitTimers.get(wait.id)!.timer as NodeJS.Timeout & { _onTimeout(): void };
  expect(timer).toBeDefined();
  const boundaries = store.readEvents(runId).filter(event => event.type === 'turn-end').length;
  const expire = timer._onTimeout; clearTimeout(timer); expire();
  await until(() => store.readEvents(runId).some(event => event.type === 'note' && String(event.message).includes('automatic timer wake-up (1/')));
  // The fired timer reads `waiting` until its wake is admitted; the wake's own turn ends it.
  // Its mock response names no wait or done.
  await until(() => store.readEvents(runId).filter(event => event.type === 'turn-end').length > boundaries && run().status === 'waiting' && !agentTimer(run()));
  attention('needs you', true);
}
function sawMonitoringDelivery(calls: TaskWebhookPayload[]): void {
  expect(calls.some(call => call.task.status === 'waiting' && call.task.attentionLabel === 'monitoring')).toBe(true);
}

// No prose is read (hearsay-tools/cezarion#1234): a question after the wait leaves its timer in place.
async function proseQuestionLeavesMonitoring({ runId, send, attention, run }: RowContext): Promise<void> {
  await send(script(WAIT, thenSay('Should I merge this PR?')));
  attention('monitoring', false);
  expectAgentTimer(run());
  expect(hasPendingAsk(store, runId)).toBe(false);
  expect(store.readEvents(runId).some(event => event.type === 'note' && event.code === 'unstructured-human-gate')).toBe(false);
}
// Live workers alone keep a markerless turn monitoring: the `monitoring-line` timer.
async function reviewRequestLeavesMonitoring({ runId, send, attention, run }: RowContext): Promise<void> {
  await send(messagesPrompt(run().runner as RunnerId, ['Please review the changes before I continue.']));
  attention('monitoring', false);
  expect(monitoringWakeOf(run())).toBeDefined();
  expect(hasPendingAsk(store, runId)).toBe(false);
  expect(store.readEvents(runId).some(event => event.type === 'note' && event.code === 'unstructured-human-gate')).toBe(false);
}
async function withLiveWorker({ runId }: RowContext): Promise<void> {
  store.commitDelegation([{ id: runId, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
  await worker(runId);
}

async function laterAskBeatsMonitoring({ runId, send, attention }: RowContext): Promise<void> {
  await send(script(WAIT, ASK));
  attention('needs you', true);
  expect(hasPendingAsk(store, runId)).toBe(true);
}

// M5 and M19 differ in the turn's script only.
async function reachesReview({ runId, send, attention, run, turnEnds }: RowContext, prompt: string): Promise<void> {
  process.env.CEZ_REVIEW_GATE = '1';
  const cwd = run().worktreePath!;
  expect(cwd).toBeDefined();
  // The turn-end diff stat can still hold this worktree's index.lock while the run reads
  // `waiting`; a `git add` racing it failed with "index.lock: File exists" in PR #871's CI
  // (M5 opencode, M19 omp and cursor) and in local full runs, and on Codex under load
  // (hearsay-tools/cezarion#887). With the stat's lock held for 0.5s, these rows fail
  // without this wait and pass with it.
  expect(turnEnds.recorded).toBeGreaterThan(0);
  await until(() => turnEnds.pending.size === 0);
  writeFileSync(join(cwd, 'review.txt'), 'review this change');
  execFileSync('git', ['add', 'review.txt'], { cwd });
  execFileSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@local', 'commit', '-qm', 'review change'], { cwd });
  await send(prompt);
  expect(run().status).toBe(RUN_STATUS.review);
  await until(() => !manager.isActive(runId));
  expect(run().status).toBe(RUN_STATUS.review);
  expect(run().waits ?? []).toEqual([]);
  attention('needs review', true);
}
function laterDoneReachesReview(ctx: RowContext): Promise<void> {
  return reachesReview(ctx, script(WAIT, DONE));
}

async function idleClosureKeepsQuestion(ctx: RowContext): Promise<void> {
  await laterAskBeatsMonitoring(ctx);
  await answerClearsMonitoringAfterIdleClosure(ctx);
}
async function answerClearsMonitoringAfterIdleClosure({ runId, attention, run }: RowContext): Promise<void> {
  const askSeq = store.readEvents(runId).filter(event => event.type === 'ask.requested').at(-1)!.seq;
  const timer = manager['active'].get(runId)!.idleTimer! as NodeJS.Timeout & { _onTimeout(): void };
  const expire = timer._onTimeout; clearTimeout(timer); expire();
  await until(() => !manager.isActive(runId));
  expect(hasPendingAsk(store, runId)).toBe(true);
  attention('needs you', true);
  expect(manager.continueRun(runId, { text: script(WAIT, thenSay(ACK_TEXT)) }).ok).toBe(true);
  await until(() => run().status === 'waiting' && manager['active'].get(runId)?.atTurnBoundary !== undefined);
  attention('monitoring', false);
  expect(hasPendingAsk(store, runId)).toBe(false);
  expect(store.readEvents(runId).some(event => event.type === 'human-input-delivered' && event.askSeq === askSeq)).toBe(true);
}

async function structuredAskSurvivesAck(ctx: RowContext): Promise<void> {
  const { runId, send, attention } = ctx;
  await send(script(WAIT, ASK, thenSay(ACK_TEXT)));
  attention('needs you', true);
  expect(hasPendingAsk(store, runId)).toBe(true);
  expect(store.readEvents(runId).filter(event => event.type === 'ask.requested').at(-1)?.questions).toEqual(QUESTIONS);
  expect(store.readEvents(runId).some(event => event.type === 'note' && event.code === 'unstructured-human-gate')).toBe(false);
  await answerClearsMonitoringAfterIdleClosure(ctx);
}

function laterDoneSurvivesAck(ctx: RowContext): Promise<void> {
  return reachesReview(ctx, script(WAIT, DONE, thenSay(ACK_TEXT)));
}

// The completion gate refuses a done while the run's question is unanswered (run-finish.ts): the
// refusal answers the agent, the question stays, and the run keeps waiting for the user.
async function doneRefusedBesideQuestion({ runId, send, attention, run }: RowContext): Promise<void> {
  await send(script(WAIT, ASK, thenSay(ACK_TEXT)));
  attention('needs you', true);
  const tools = manager.cezarToolHandlers(runId, runInternals(manager).active.get(runId)!.ciGeneration!);
  const answer = await tools.finishTurn({ summary: 'Complete.' }, new AbortController().signal);
  expect(answer).toMatchObject({ ok: false, code: 'human_question_pending' });
  attention('needs you', true);
  expect(run().status).toBe(RUN_STATUS.waiting);
  expect(hasPendingAsk(store, runId)).toBe(true);
  expect(store.readEvents(runId).some(event => event.type === 'lifecycle' && event.message === 'goal achieved — session closed')).toBe(false);
  expect(manager.isActive(runId)).toBe(true);
}

const ROW_SPECS: Record<RowId, RowSpec> = {
  M1: { body: monitoringSurvivesAck, webhook: sawMonitoringDelivery },
  M2: { body: proseQuestionLeavesMonitoring },
  M3: { setup: withLiveWorker, body: reviewRequestLeavesMonitoring },
  M4: { body: laterAskBeatsMonitoring },
  M5: { body: laterDoneReachesReview },
  M7: { body: idleClosureKeepsQuestion },
  M18: { body: structuredAskSurvivesAck },
  M19: { body: laterDoneSurvivesAck },
  M21: { body: doneRefusedBesideQuestion },
};

// The run start, the Continue path, `attention`, `send` and the webhook check are the same for every row.
async function runMonitoringRow(backend: RunnerId, mode: 'fresh' | 'continuation', row: { id: RowId }): Promise<void> {
  process.env.CEZ_DRY_RUN = '0';
  process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
  // Turn-end bookkeeping (diff stat: `git add -N .`) runs after the run already reads
  // `waiting`. Track it so a row that runs its own git in the worktree can wait it out.
  const turnEnds: TurnEndTracker = { recorded: 0, pending: new Set() };
  const recordTurnEnd = runInternals(manager).turnBookkeeper.recordTurnEnd.bind(runInternals(manager).turnBookkeeper);
  runInternals(manager).turnBookkeeper.recordTurnEnd = (id, text) => {
    const task = recordTurnEnd(id, text);
    turnEnds.recorded += 1;
    turnEnds.pending.add(task);
    void task.finally(() => turnEnds.pending.delete(task));
    return task;
  };
  const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
  await until(() => store.getRun(p.id)?.status === 'waiting');
  if (mode === 'continuation') {
    expect(manager.finish(p.id)).toBe(true);
    await until(() => !manager.isActive(p.id));
    expect(manager.continueRun(p.id, { text: 'mock:hold' }).ok).toBe(true);
    await until(() => store.getRun(p.id)?.status === 'waiting');
  }
  const run = () => store.getRun(p.id)!;
  const attention = (label: string, wants: boolean) => {
    const record = run();
    expect(deriveAttention(record).label).toBe(label);
    expect(endsWait({ id: p.id, status: record.status, ...attentionFields(record) }, 'attention')).toBe(wants);
    expect(projectStatus(record as unknown as ApiRun, 'http://localhost/task')).toMatchObject({ attentionLabel: label });
  };
  const send = async (prompt: string) => {
    const boundaries = store.readEvents(p.id).filter(event => event.type === 'turn-end').length;
    expect(manager.sendMessage(p.id, [{ type: 'text', text: prompt }])).toBe(true);
    await until(() => store.readEvents(p.id).filter(event => event.type === 'turn-end').length > boundaries && semaphore.busy() === 0);
  };
  const ctx: RowContext = { backend, runId: p.id, run, attention, send, turnEnds };
  const spec = ROW_SPECS[row.id];
  await spec.setup?.(ctx);
  const calls: TaskWebhookPayload[] = [];
  const hook = new TaskWebhook(store, { dataDir: join(root, '.ai/cezar'), dryRun: false,
    // Every state: these rows pin what a delivery says, not which states send one (#1356).
    resolveProject: async () => ({ id: 'project', webhooks: [{ id: 'hook', name: 'Hook', url: 'https://example.test/hook', triggers: WEBHOOK_TRIGGERS }] }), origin: () => 'http://localhost',
    fetch: (async (_url, init) => { calls.push(JSON.parse(String(init?.body))); return new Response(null, { status: 204 }); }) as typeof fetch,
  });
  store.updateRun(p.id, { notify: true });
  try {
    await spec.body(ctx);
    await hook.idle();
    const final = calls.at(-1)!;
    expect(final.task.attentionLabel).toBe(deriveAttention(run()).label);
    spec.webhook?.(calls);
  } finally { hook.dispose(); }
}

for (const backend of RUNNER_IDS) describe(`${backend} monitoring turn`, { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const mode of ['fresh', 'continuation'] as const) for (const row of MONITORING_TURN_CRITERIA) {
    it(`${mode} ${row.id} ${row.name}`, () => runMonitoringRow(backend, mode, row));
  }
  for (const mode of ['fresh', 'continuation'] as const) it(`${mode} ${mode === 'fresh' ? 'M13' : 'M14'} ordinary markerless prose questions keep autonomous nudges`, async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
    const prompt = messagesPrompt(backend, ['Should I merge this PR?']);
    const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: mode === 'fresh' ? prompt : 'mock:hold', runner: backend, autonomous: mode === 'fresh' });
    if (mode === 'continuation') {
      await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(manager.finish(p.id)).toBe(true);
      await until(() => !manager.isActive(p.id));
      store.updateRun(p.id, { autonomous: true });
      expect(manager.continueRun(p.id, { text: prompt }).ok).toBe(true);
    }
    await until(() => store.getRun(p.id)?.status === 'waiting' || !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe('done');
    expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes('autonomous — continuing without pausing'))).toBe(true);
  });

  it('fresh M17 a clean session close with an accepted worker wait open parks the run on it', async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
    const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: 'mock:hold', runner: backend });
    await until(() => store.getRun(p.id)?.status === 'waiting');
    store.commitDelegation([{ id: p.id, delegation: { role: 'root', permissions: ['spawn', 'wait'], receipts: [] } }]);
    const w = await worker(p.id);
    expect(manager.sendMessage(p.id, [{ type: 'text', text: script(WAIT, thenSay(ACK_TEXT)) }])).toBe(true);
    register(p.id, [w.id]);
    await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
    manager['active'].get(p.id)!.session!.end();
    await until(() => !manager.isActive(p.id));
    // hearsay-tools/cezarion#1235: an agent's worker wait is a list entry, so a clean close parks
    // on it like any open wait; only the completion gate's wait still fails the session.
    expect(store.getRun(p.id)?.status).toBe('waiting');
    expect(store.getRun(p.id)?.error).toBeUndefined();
    expect(store.getRun(p.id)?.waits?.filter(wait => wait.kind === 'worker')).toEqual([expect.objectContaining({ phase: 'open', workerIds: [w.id] })]);
    expect(store.getRun(w.id)?.status).toBe('queued');
  });

  // An autonomous run assumes instead of asking while its wake budget lasts: cezar_ask is refused
  // with `autonomous_run`, registers nothing, and the turn takes the autonomous nudge.
  for (const mode of ['fresh', 'continuation'] as const) it(`${mode} M23 an autonomous cezar_ask followed by acknowledgement is refused, and the run continues`, async () => {
    process.env.CEZ_DRY_RUN = '0';
    process.env[HARNESS_ADAPTERS[backend].binEnv] = HARNESS_ADAPTERS[backend].mockBin;
    const prompt = script(ASK, thenSay(ACK_TEXT));
    const p = manager.startRun(QUICK_TASK_WORKFLOW, { task: mode === 'fresh' ? prompt : 'mock:hold', runner: backend, autonomous: mode === 'fresh' });
    if (mode === 'continuation') {
      await until(() => store.getRun(p.id)?.status === 'waiting');
      expect(manager.finish(p.id)).toBe(true);
      await until(() => !manager.isActive(p.id));
      store.updateRun(p.id, { autonomous: true });
      expect(manager.continueRun(p.id, { text: prompt }).ok).toBe(true);
    }
    await until(() => !manager.isActive(p.id));
    expect(store.getRun(p.id)?.status).toBe(RUN_STATUS.done);
    expect(store.readEvents(p.id).some(event => event.type === 'text' && String(event.text).includes('autonomous_run'))).toBe(true);
    expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).startsWith('autonomous — continuing without pausing'))).toBe(true);
    expect(store.readEvents(p.id).some(event => event.type === 'note' && event.code === 'unstructured-human-gate')).toBe(false);
    expect(store.readEvents(p.id).filter(event => event.type === 'ask.requested' || event.type === 'human-input-delivered')).toHaveLength(0);
  });

});
