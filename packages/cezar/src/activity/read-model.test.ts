import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { AttentionRung } from '@open-mercato/cezar-contract';
import { activitySnapshotSchema, activityToolSchema } from '@open-mercato/cezar-contract/activity';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import {
  makeHumanWait, makePeerWait, makePrWait, makeProcessWait, makeSubagentWait, makeTimerWait, makeWorkerRequestWait, makeWorkerWait,
  RUN_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA, WORKER_OUTCOME_STATUS,
} from '@open-mercato/cezar-contract/test-factories.testkit';
import { computeWaitingOn } from '@open-mercato/cezar-contract/waits';
import type { RunRecord } from '../runs/store.ts';
import { addRequest, fakeStore, iso, makeRoot, makeWorker, NOW, rootOf, type FakeStoreOptions } from './activity.testkit.ts';
import { buildActivityProject, buildActivitySnapshot, unreadableLogger, type ActivityDeps } from './read-model.ts';
import { ToolActivityTracker } from './tool-activity.ts';

const read = (runs: readonly RunRecord[], options: FakeStoreOptions & { deps?: ActivityDeps; active?: (id: string) => boolean } = {}) =>
  buildActivityProject({ projectId: 'shop', name: 'Shop', loaded: { store: fakeStore(runs, options), isActive: options.active ?? (() => false) } },
    options.deps ?? {}, { now: NOW }).project;
const card = (runs: readonly RunRecord[], id: string, options?: Parameters<typeof read>[1]) => {
  const found = read(runs, options).tasks.find((task) => task.runId === id);
  if (!found) throw new Error(`no card for ${id}`);
  return found;
};
const outcome = (workerId: string) => ({ workerId, status: WORKER_OUTCOME_STATUS.done, revision: 0, observedAt: iso(-1_000) });

describe('the activity snapshot', () => {
  it('stamps the read time and validates against the contract', () => {
    const root = makeRoot();
    const snapshot = buildActivitySnapshot([
      { projectId: 'shop', name: 'Shop', loaded: { store: fakeStore([root]), isActive: () => false } },
      { projectId: 'docs', name: 'Docs' },
    ], { now: () => NOW });
    expect(activitySnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.generatedAt).toBe(iso(0));
    expect(snapshot.projects.map((project) => [project.projectId, project.loaded, project.tasks.length])).toEqual([['shop', true, 1], ['docs', false, 0]]);
  });

  it('answers a project this process has not loaded with empty lists', () => {
    const { project } = buildActivityProject({ projectId: 'docs', name: 'Docs' }, {}, { now: NOW });
    expect(project).toEqual({ projectId: 'docs', name: 'Docs', loaded: false, inReview: 0, tasks: [], requests: [], closed: [] });
  });
});

describe('D8: which roots are cards', () => {
  it.each([
    [RUN_STATUS.queued, true], [RUN_STATUS.running, true], [RUN_STATUS.waiting, true],
    [RUN_STATUS.review, false], [RUN_STATUS.failed, false], [RUN_STATUS.done, false], [RUN_STATUS.cancelled, false],
  ])('a %s root without a live worker is a card: %s', (status, shown) => {
    const root = makeRoot({ status });
    expect(read([root]).tasks.map((task) => task.runId)).toEqual(shown ? [root.id] : []);
  });

  it('counts review roots for the chip, and never workers', () => {
    const one = makeRoot({ status: RUN_STATUS.review });
    const two = makeRoot({ status: RUN_STATUS.review });
    const worker = makeWorker(one, { status: RUN_STATUS.review });
    expect(read([one, two, worker]).inReview).toBe(2);
  });

  it.each([RUN_STATUS.review, RUN_STATUS.failed, RUN_STATUS.done, RUN_STATUS.cancelled])('keeps a %s root while a worker in it lives', (status) => {
    const root = makeRoot({ status, error: status === RUN_STATUS.failed ? 'build broke\nstack trace' : undefined });
    const live = makeWorker(root, { status: RUN_STATUS.running });
    const settled = makeWorker(root, { status: RUN_STATUS.done });
    const shown = card([root, live, settled], root.id);
    expect(shown.status).toBe(status);
    expect(shown.rung).toBe(deriveAttention(root).rung);
    expect(shown.wait).toBeUndefined();
    expect(shown.workers.map((worker) => worker.runId).sort()).toEqual([live.id, settled.id].sort());
    if (status === RUN_STATUS.failed) expect(shown.error).toBe('build broke');
    // The card leaves when its last worker settles.
    live.status = RUN_STATUS.done;
    expect(read([root, live, settled]).tasks).toEqual([]);
  });

  it('never lists an archived root, and orders cards by creation', () => {
    const late = makeRoot({ createdAt: iso(-1_000) });
    const early = makeRoot({ createdAt: iso(-9_000) });
    const archived = makeRoot({ archived: true });
    expect(read([late, early, archived]).tasks.map((task) => task.runId)).toEqual([early.id, late.id]);
  });

  it('leaves out a run whose record cannot be read, and logs it once', () => {
    const readable = makeRoot();
    const broken = makeRoot();
    const onUnreadable = vi.fn();
    const project = read([readable, broken], { unreadable: [broken.id], deps: { onUnreadable } });
    expect(project.tasks.map((task) => task.runId)).toEqual([readable.id]);
    expect(onUnreadable).toHaveBeenCalledWith('shop', broken.id);
    const log = vi.fn();
    const once = unreadableLogger(log);
    once('shop', broken.id);
    once('shop', broken.id);
    expect(log).toHaveBeenCalledTimes(1);
  });
});

describe('unreadable records', () => {
  /** Two snapshots that share one once-only logger, as the route does. */
  const twoSnapshots = (runs: readonly RunRecord[], options: FakeStoreOptions & { carryOver?: string[] }) => {
    const log = vi.fn();
    const deps: ActivityDeps = { onUnreadable: unreadableLogger(log) };
    const source = { projectId: 'shop', name: 'Shop', loaded: { store: fakeStore(runs, options), isActive: () => true } };
    const snapshots = [0, 1].map(() => buildActivityProject(source, deps, { now: NOW, ...(options.carryOver ? { carryOver: options.carryOver } : {}) }).project);
    return { snapshots, logged: log.mock.calls.map(([message]) => message as string) };
  };

  it('leaves out a worker it cannot read, and logs it once', () => {
    const root = makeRoot();
    const readable = makeWorker(root);
    const broken = makeWorker(root);
    const { snapshots, logged } = twoSnapshots([root, readable, broken], { unreadable: [broken.id] });
    for (const project of snapshots) expect(project.tasks[0]!.workers.map((worker) => worker.runId)).toEqual([readable.id]);
    expect(logged).toEqual([expect.stringContaining(broken.id)]);
  });

  it('logs a request recipient it cannot read once, and draws the request without its title', () => {
    const sender = makeRoot({ status: RUN_STATUS.waiting });
    // Not a card: only the request read meets it.
    const recipient = makeRoot({ status: RUN_STATUS.review });
    const request = addRequest(sender, sender, recipient, { relationship: 'peer' });
    const { snapshots, logged } = twoSnapshots([sender, recipient], { unreadable: [recipient.id] });
    for (const project of snapshots) {
      expect(project.tasks.map((task) => task.runId)).toEqual([sender.id]);
      expect(project.requests.map((entry) => [entry.requestId, 'recipientTitle' in entry])).toEqual([[request.id, false]]);
    }
    expect(logged).toEqual([expect.stringContaining(recipient.id)]);
  });

  it('logs a carry-over root it cannot read once', () => {
    const live = makeRoot();
    const gone = makeRoot({ status: RUN_STATUS.done });
    const { snapshots, logged } = twoSnapshots([live, gone], { unreadable: [gone.id], carryOver: [gone.id] });
    for (const project of snapshots) expect(project.requests).toEqual([]);
    expect(logged).toEqual([expect.stringContaining(gone.id)]);
  });
});

describe('workers', () => {
  it('lists every owned worker, settled ones included, oldest first', () => {
    const root = makeRoot();
    const second = makeWorker(root, { createdAt: iso(-1_000) });
    const first = makeWorker(root, { createdAt: iso(-2_000), status: RUN_STATUS.failed, error: `${'x'.repeat(300)}\nmore` });
    const shown = card([root, first, second], root.id);
    expect(shown.workers.map((worker) => worker.runId)).toEqual([first.id, second.id]);
    expect(shown.workers[0]!.error).toBe('x'.repeat(200));
    expect(shown.workers[1]!.error).toBeUndefined();
  });

  it('says collected only for a result of the current revision', () => {
    const root = makeRoot();
    const none = makeWorker(root, { status: RUN_STATUS.done });
    const current = makeWorker(root, { status: RUN_STATUS.done });
    const older = makeWorker(root, { status: RUN_STATUS.done });
    for (const worker of [current, older]) (worker.delegation as { executionRevision?: number }).executionRevision = 2;
    const reference = (workerId: string, revision: number) => ({ workerId, revision, snapshotId: randomUUID(), observedAt: iso(-1_000), lastExecutionOutcome: 'completed' }) as never;
    rootOf(root).results = [reference(current.id, 2), reference(older.id, 1)];
    const workers = new Map(card([root, none, current, older], root.id).workers.map((worker) => [worker.runId, worker]));
    expect([none, current, older].map((worker) => [workers.get(worker.id)!.revision, workers.get(worker.id)!.collected])).toEqual([[0, false], [2, true], [2, false]]);
  });

  it('gives a worker its own rung and wait', () => {
    const root = makeRoot({ status: RUN_STATUS.waiting, waits: [makeWorkerWait()] });
    const worker = makeWorker(root, { status: RUN_STATUS.waiting });
    const question = addRequest(root, worker, root);
    worker.waits = [makeWorkerRequestWait({ requestIds: [question.id] })];
    const row = card([root, worker], root.id).workers[0]!;
    expect(row.rung).toBe(deriveAttention(worker).rung);
    expect(row.wait).toMatchObject({ kind: 'workers', detail: { replies: true, recipientRunIds: [root.id] } });
  });
});

describe('tool activity and check progress providers', () => {
  it('sends no tool and a flat heartbeat without a provider', () => {
    const root = makeRoot();
    const shown = card([root], root.id);
    expect(shown.tool).toBeUndefined();
    expect(shown.rate).toEqual(Array.from({ length: 30 }, () => 0));
  });

  it('passes the tracker’s latest tool and rate through', () => {
    const root = makeRoot();
    const rate = Array.from({ length: 30 }, (_, second) => second % 3);
    const tool = { title: 'Edit workers/spawn.ts', toolKind: 'edit' as const, status: activityToolSchema.shape.status.enum.running, startedAt: iso(-2_000) };
    const reads = vi.fn(() => ({ tool, rate }));
    expect(card([root], root.id, { deps: { tools: { read: reads } } })).toMatchObject({ tool, rate });
    expect(reads).toHaveBeenCalledWith(root.id, NOW);
  });

  it('shows no tool for a cancelled worker whose session reports a tool after the cancel', () => {
    const root = makeRoot();
    const worker = makeWorker(root, { status: RUN_STATUS.cancelled });
    const tracker = new ToolActivityTracker({ now: () => NOW });
    const store = Object.assign(new EventEmitter(), { redactText: (text: string) => text, getRun: (id: string) => [root, worker].find((run) => run.id === id) });
    const feed = tracker.attach(store);
    // Cancelled before its first tool; the session's late tool start still reaches the tracker.
    store.emit('run', worker);
    const late = { kind: 'tool' as const, id: 'late', name: 'Bash', toolKind: 'execute' as const, title: 'Ran npm test', status: activityToolSchema.shape.status.enum.running };
    feed.observe(worker.id, { type: 'item.started', item: late });
    feed.observe(root.id, { type: 'item.started', item: { ...late, id: 'root-tool', title: 'Ran ls' } });

    const shown = card([root, worker], root.id, { deps: { tools: tracker } });
    expect(shown.tool?.title).toBe('Ran ls');
    expect(shown.workers[0]).toMatchObject({ runId: worker.id, status: RUN_STATUS.cancelled, rate: Array.from({ length: 30 }, () => 0) });
    expect(shown.workers[0]!.tool).toBeUndefined();
  });

  it('adds a PR wait’s check progress when the registry holds some', () => {
    const wait = makePrWait();
    const root = makeRoot({ status: RUN_STATUS.waiting, waits: [wait] });
    const progress = { checks: [{ name: 'test', bucket: 'pending' as const }], counts: { pass: 3, fail: 0, pending: 1, skipping: 0, cancel: 0 } };
    expect(card([root], root.id).wait).toEqual({ kind: WAIT_KIND.pr, since: wait.registeredAt, deadline: wait.deadline, detail: { number: 12, target: 'checks' } });
    const read = vi.fn((id: string) => (id === wait.id ? progress : undefined));
    expect(card([root], root.id, { deps: { ci: { read } } }).wait)
      .toEqual({ kind: WAIT_KIND.pr, since: wait.registeredAt, deadline: wait.deadline, detail: { number: 12, target: 'checks', ...progress } });
    // The registry learns the wait's project from the snapshot that reads it.
    expect(read).toHaveBeenCalledWith(wait.id, 'shop');
  });
});

describe('the state table', () => {
  const worker = randomUUID();
  const other = randomUUID();
  /** One run per state-table row: its record, and the wait the view must show. */
  const rows: Array<[string, Partial<RunRecord>, unknown]> = [
    ['running', { status: RUN_STATUS.running }, undefined],
    ['needs-you with a question', { status: RUN_STATUS.waiting, waits: [makeHumanWait({ registeredAt: iso(-3_000), questions: [{ id: 'q', header: 'Branch', question: 'Which branch?', options: [] }] as never })] },
      { kind: WAIT_KIND.human, since: iso(-3_000), detail: { question: 'Which branch?', reason: 'question' } }],
    ['needs-you, a plain turn end', { status: RUN_STATUS.waiting }, undefined],
    ['needs-you, Squawk’s no-wait wait', { status: RUN_STATUS.waiting, waits: [makeHumanWait({ source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'], askSeq: 4 })] },
      { kind: WAIT_KIND.human, since: '2026-10-26T00:00:00.000Z', detail: { reason: 'turn-end' } }],
    ['needs-you, Squawk’s budget wait', {
      status: RUN_STATUS.waiting, waits: [makeHumanWait({ source: WAIT_SOURCE.cezar, via: WAIT_VIA.budget, askSeq: 4 })],
      agentInputs: [0, 1, 2].map((n) => ({ id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId: randomUUID(), text: `m${n}`, createdAt: iso(-1_000), ...(n === 2 ? { deliveredAt: iso(0) } : {}) })) as never,
    }, { kind: WAIT_KIND.human, since: '2026-10-26T00:00:00.000Z', detail: { reason: 'budget', queuedMessages: 2 } }],
    ['needs-permission', { status: RUN_STATUS.running, hasPendingPermission: true }, undefined],
    ['waiting-on-workers, one entry', { status: RUN_STATUS.waiting, waits: [makeWorkerWait({ mode: 'all', workerIds: [worker, other], outcomes: [outcome(worker)] as never })] },
      { kind: 'workers', since: '2026-10-26T00:00:00.000Z', deadline: '2026-10-26T00:05:00.000Z', detail: { owed: 1, total: 2, settled: 1, mode: 'all', recipientRunIds: [] } }],
    ['waiting-on-workers, several entries naming one worker', {
      status: RUN_STATUS.waiting,
      waits: [makeWorkerWait({ mode: 'one', workerIds: [worker], registeredAt: iso(-4_000) }), makeWorkerWait({ mode: 'any', workerIds: [worker, other], registeredAt: iso(-1_000), deadline: iso(30_000) })],
    }, { kind: 'workers', since: iso(-4_000), deadline: iso(30_000), detail: { owed: 2, total: 2, settled: 0, recipientRunIds: [] } }],
    ['waiting-on-workers, one shared worker reported', {
      status: RUN_STATUS.waiting,
      waits: [
        makeWorkerWait({ workerIds: [worker], outcomes: [{ workerId: worker, status: RUN_STATUS.done, observedAt: iso(-500) }], registeredAt: iso(-4_000) }),
        makeWorkerWait({ workerIds: [worker, other], outcomes: [{ workerId: worker, status: RUN_STATUS.done, observedAt: iso(-500) }], registeredAt: iso(-1_000), deadline: iso(30_000) }),
      ],
    }, { kind: 'workers', detail: { owed: 1, total: 2, settled: 1 } }],
    ['waiting-on-subagents', { status: RUN_STATUS.waiting, waits: [makeSubagentWait()] },
      { kind: 'subagents', since: '2026-10-26T00:00:00.000Z', deadline: '2026-10-26T00:05:00.000Z', detail: { running: 1 } }],
    ['waiting-for-merge', { status: RUN_STATUS.waiting, waits: [makePrWait({ until: 'merge' })] }, { kind: WAIT_KIND.pr, detail: { number: 12, target: 'merge' } }],
    ['waiting-for-command', { status: RUN_STATUS.waiting, waits: [makeProcessWait({ note: 'npm test' })] }, { kind: WAIT_KIND.process, detail: { pid: 4242, note: 'npm test' } }],
    ['monitoring', { status: RUN_STATUS.waiting, waits: [makeTimerWait({ note: 'check deploy', deadline: iso(60_000) })] },
      { kind: WAIT_KIND.timer, since: '2026-10-26T00:00:00.000Z', deadline: iso(60_000), detail: { wakeAt: iso(60_000), note: 'check deploy' } }],
    ['peer wait', { status: RUN_STATUS.waiting, waits: [makePeerWait({ peerIds: [worker, other] }), makePeerWait({ peerIds: [other], deadline: iso(10_000) })] },
      { kind: 'peers', since: '2026-10-26T00:00:00.000Z', deadline: iso(10_000), detail: { peerRunIds: [worker, other] } }],
    ['usage-limit', { status: RUN_STATUS.waiting, autoResumeAt: iso(600_000) }, { kind: 'usage-limit', detail: { resumeAt: iso(600_000) } }],
    ['waiting-for-capacity, queued', { status: RUN_STATUS.queued }, undefined],
    ['waiting-for-capacity, a resolved wait owes its wake', { status: RUN_STATUS.waiting, waits: [makeTimerWait({ phase: WAIT_PHASE.resolved })] }, undefined],
  ];

  it.each(rows)('%s', (_name, over, wait) => {
    const root = makeRoot(over);
    const shown = card([root], root.id);
    expect(shown.rung).toBe(deriveAttention(root).rung);
    if (wait === undefined) expect(shown.wait).toBeUndefined();
    else expect(shown.wait).toMatchObject(wait as object);
    // The view and the Tasks list agree on what the run waits for.
    expect(shown.wait?.kind).toBe(computeWaitingOn(root)?.kind);
    if (shown.wait?.kind === 'workers') expect(shown.wait.detail.owed).toBe((computeWaitingOn(root) as { count: number }).count);
  });

  it('reaches every rung but unseen', () => {
    const live = (status: RunRecord['status']) => {
      const root = makeRoot({ status });
      return [root, makeWorker(root)];
    };
    const runs = [
      ...rows.map(([, over]) => makeRoot(over)), makeRoot({ status: RUN_STATUS.waiting, waits: [makePrWait()] }),
      ...[RUN_STATUS.failed, RUN_STATUS.review, RUN_STATUS.done, RUN_STATUS.cancelled].flatMap(live),
    ];
    const rungs = new Set(read(runs).tasks.map((task) => task.rung));
    const expected: AttentionRung[] = ['needs-permission', 'failed', 'needs-you', 'needs-review', 'running', 'usage-limit', 'waiting-on-workers',
      'waiting-on-subagents', 'waiting-for-ci', 'waiting-for-merge', 'waiting-for-command', 'monitoring', 'waiting-for-capacity', 'queued', 'done', 'cancelled'];
    expect([...rungs].sort()).toEqual([...expected].sort());
    for (const task of read(runs).tasks) expect(task.rung).toBe(deriveAttention(runs.find((run) => run.id === task.runId)!).rung);
  });

  describe('the three waiting-on-workers rows', () => {
    it('worker outcomes only: the mode of one entry', () => {
      const root = makeRoot({ status: RUN_STATUS.waiting, waits: [makeWorkerWait({ mode: 'all', workerIds: [worker] })] });
      expect(card([root], root.id).wait).toMatchObject({ kind: 'workers', detail: { owed: 1, total: 1, settled: 0, mode: 'all' } });
    });

    it('replies: every open entry names requests; the recipients, each once', () => {
      const root = makeRoot({ status: RUN_STATUS.waiting });
      const peer = makeRoot();
      const workerRun = makeWorker(root);
      const toPeer = addRequest(root, root, peer, { relationship: 'peer' });
      const toWorker = addRequest(root, root, workerRun);
      const again = addRequest(root, root, peer, { relationship: 'peer' });
      root.waits = [makeWorkerRequestWait({ requestIds: [toPeer.id, toWorker.id] }), makeWorkerRequestWait({ requestIds: [again.id] })];
      const wait = card([root, peer, workerRun], root.id).wait;
      expect(wait).toMatchObject({ kind: 'workers', detail: { owed: 3, total: 3, settled: 0, replies: true } });
      expect(wait?.kind === 'workers' && [...wait.detail.recipientRunIds].sort()).toEqual([peer.id, workerRun.id].sort());
      expect(wait?.kind === 'workers' && wait.detail.mode).toBeUndefined();
    });

    it('mixed: no replies flag; the owed count is computeWaitingOn’s', () => {
      const root = makeRoot({ status: RUN_STATUS.waiting });
      const workerRun = makeWorker(root);
      const request = addRequest(root, root, workerRun);
      const answered = addRequest(root, root, workerRun);
      root.waits = [makeWorkerWait({ workerIds: [workerRun.id] }),
        makeWorkerRequestWait({ requestIds: [request.id, answered.id], requestOutcomes: [{ requestId: answered.id, status: 'replied', observedAt: iso(-1_000) }] })];
      const wait = card([root, workerRun], root.id).wait;
      expect(wait).toMatchObject({ kind: 'workers', detail: { owed: 2, total: 3, settled: 1, recipientRunIds: [workerRun.id] } });
      expect(wait?.kind === 'workers' && wait.detail.replies).toBeUndefined();
      expect((computeWaitingOn(root) as { count: number }).count).toBe(2);
    });
  });
});
