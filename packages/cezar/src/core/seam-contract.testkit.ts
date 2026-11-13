/**
 * The seam contract suite, rows S36–S42 (hearsay-tools/cezarion#2991).
 *
 * Shared parity rows above the `AgentSession` seam can run on fewer runners only while every runner
 * proves at the seam that it behaves as it declares. These rows drive each real runner class on its
 * own native mock through `driveSeam`, and read the runner's declared facts (`inputDelivery`,
 * `systemPromptOnResume`) instead of runner ids:
 *
 * - S36: agent input is acknowledged at the declared point (`write`, `response`, `model-work`), and
 *   consumption is reported only after that acknowledgement, never at it.
 * - S37: a follow-up turn emits normalized `turn.started` before its content and its turn end.
 * - S38: a human follow-up stays held from `sendMessage` until the turn that carries it has started
 *   or reads it, including when its native turn starts late.
 * - S39: a turn that ends while it holds human input reports the hold, and the session opens the
 *   follow-up turn before it closes, even when it was asked to close after the first turn.
 * - S40, S41: a mid-turn human message is read in the running turn or held for the next one, as
 *   `humanInputAtTurnEnd` declares, when it arrives before (S40) or after (S41) the last model call.
 * - S42: `spec.systemPrompt` reaches every process on a system channel when the runner declares
 *   `resent`, and the opening turn of the thread when it declares `in-thread`.
 * - S43: the session reports every native process it starts while that process runs: the first
 *   as `pid` when `startSession` returns, each later one through `onPidChange`. The worker process
 *   ledger records exactly these pids (worker-reboot, worker-restart).
 * - S44: a provider failure in a turn that a wake opened, or in a turn that runs a while before it
 *   fails, reaches v1 as an `error` before any turn end and v2 as an error, and the session ends
 *   once Squawk interrupts it, as `recordSessionFault` does.
 *
 * A fix to runner lifecycle, input delivery, holds or resume inside a runner class extends these
 * rows, which run on every runner (docs/areas/runners.md).
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect } from 'vitest';
import { createFailureControl } from '../../scripts/mock-failure-control.mjs';
import { inputDeliveryOf, type AgentEvent, type AgentSession, type InputDelivery, type RunnerId } from './agent-runner.ts';
import { driveSeam, PINNED_SESSION_ID, promptFor, seedOpencodeMockSession, waitFor, type DriveSeamOptions, type ScenarioName, type SeamObservation } from './harness-parity-core.testkit.ts';
import { runnersUnderTest } from './runners-under-test.testkit.ts';
import type { UiEvent } from './ui-events.ts';

/** One entry of the merged event stream. A `mark` records a call the row made, or a callback. */
export type ContractEntry = { readonly v1: AgentEvent } | { readonly v2: UiEvent } | { readonly mark: string };

export interface ContractObservation {
  readonly backend: RunnerId;
  readonly delivery: InputDelivery;
  readonly obs: SeamObservation;
  readonly timeline: readonly ContractEntry[];
  /** The timeline position of each mark. */
  readonly at: ReadonlyMap<string, number>;
  /** Session state read at a named moment: `heldAtSend`, `heldAtTurnEnd` (the first turn end),
   *  `ackedWhileStopped`. */
  readonly read: Readonly<Record<string, boolean | undefined>>;
  /** The timeline length when `holdsHumanInput()` first read false after the watched send. */
  readonly released?: number;
  /** S42: the mock's recorded argv/requests and stdin lines. */
  readonly records?: readonly string[];
  readonly systemPromptOnResume?: 'resent' | 'in-thread';
  /** S43: the pids the native mock started, and each pid the session reported with whether it ran then. */
  readonly processes?: { readonly started: readonly number[]; readonly reported: readonly { readonly pid: number; readonly alive: boolean }[]; readonly last?: number };
  readonly variant: string;
}

export interface SeamContractRow {
  readonly id: string;
  readonly name: string;
  readonly scenario: ScenarioName;
  readonly observe: (backend: RunnerId) => Promise<ContractObservation>;
  readonly assert: (observed: ContractObservation) => void;
}

/** The token `scripts/mock-deferred-turn-start.mjs` exports; kept in step with it, as H4 does. */
const DEFERRED_TURN_START = 'mock:deferred-turn-start';
const FOLLOW_UP = 'contract-follow-up';
const SYSTEM_PROMPT = 'contract S42 system prompt';

const isStart = (entry: ContractEntry) => 'v2' in entry && entry.v2.type === 'turn.started';
const isCompleted = (entry: ContractEntry) => 'v2' in entry && entry.v2.type === 'turn.completed';
const isTurnEnd = (entry: ContractEntry) => 'v1' in entry && entry.v1.type === 'turn-end';
const isItem = (entry: ContractEntry) => 'v2' in entry && entry.v2.type.startsWith('item.');
const isV1Content = (entry: ContractEntry) => 'v1' in entry && ['text', 'tool-call', 'tool-result'].includes(entry.v1.type);
const isModelWork = (entry: ContractEntry) => isStart(entry) || isItem(entry);

/** Assistant text an entry carries: a v1 `text`, or a v2 assistant message snapshot. */
function textOf(entry: ContractEntry): string {
  if ('v1' in entry) return entry.v1.type === 'text' ? entry.v1.text : '';
  if (!('v2' in entry)) return '';
  const event = entry.v2;
  if (event.type !== 'item.started' && event.type !== 'item.updated' && event.type !== 'item.completed') return '';
  return event.item.kind === 'message' && event.item.role === 'assistant' ? event.item.text : '';
}
const carries = (marker: string) => (entry: ContractEntry) => textOf(entry).includes(marker);

function indexFrom(timeline: readonly ContractEntry[], match: (entry: ContractEntry) => boolean, from = 0): number {
  for (let index = Math.max(0, from); index < timeline.length; index += 1) if (match(timeline[index]!)) return index;
  return -1;
}
function lastIndexBefore(timeline: readonly ContractEntry[], match: (entry: ContractEntry) => boolean, before: number): number {
  for (let index = Math.min(before, timeline.length) - 1; index >= 0; index -= 1) if (match(timeline[index]!)) return index;
  return -1;
}
function nth(timeline: readonly ContractEntry[], match: (entry: ContractEntry) => boolean, n: number): number {
  let seen = 0;
  for (const [index, entry] of timeline.entries()) if (match(entry) && ++seen === n) return index;
  return -1;
}

/** The normalized turn around a position: its `turn.started` and the `turn.completed` that closes it. */
function turnAround(timeline: readonly ContractEntry[], position: number): { start: number; end: number } {
  const start = lastIndexBefore(timeline, isStart, position + 1);
  return { start, end: indexFrom(timeline, isCompleted, start + 1) };
}

/** Records the merged stream, marks and the session's hold. */
class Recorder {
  readonly timeline: ContractEntry[] = [];
  readonly at = new Map<string, number>();
  readonly read: Record<string, boolean | undefined> = {};
  released: number | undefined;
  session: AgentSession | undefined;
  private watching = false;
  private poll: ReturnType<typeof setInterval> | undefined;
  /** `holdsHumanInput()` at each v1 `turn-end`, read as run.ts reads it there. */
  readonly holdsAtTurnEnd: boolean[] = [];

  readonly onEvent = (entry: { readonly v1: AgentEvent } | { readonly v2: UiEvent }): void => {
    this.timeline.push(entry);
    if (isTurnEnd(entry) && this.session) this.holdsAtTurnEnd.push(this.session.holdsHumanInput());
    this.sample();
  };

  mark(label: string): number {
    this.timeline.push({ mark: label });
    this.at.set(label, this.timeline.length - 1);
    return this.timeline.length - 1;
  }

  /** Send a human message, read the hold right after it, and watch for its release. */
  sendHuman(session: AgentSession, text: string): void {
    this.session = session;
    expect(session.sendMessage([{ type: 'text', text }])).toBe(true);
    this.read.heldAtSend = session.holdsHumanInput();
    this.mark('sent');
    this.watching = true;
    this.sample();
    // A release between two events must still land at its position in the stream.
    this.poll ??= setInterval(() => this.sample(), 2);
  }

  stop(): void {
    if (this.poll) clearInterval(this.poll);
    this.poll = undefined;
  }

  private sample(): void {
    if (this.watching && this.released === undefined && this.session && !this.session.holdsHumanInput()) this.released = this.timeline.length;
  }
}

/** The test's hands on the native mock. No real-time window decides a row's outcome. */
interface MockControl {
  /** Create `CEZ_MOCK_RELEASE_FILE`: a `hold-gated` turn moves on to its content. */
  readonly release: () => void;
  /** Create `CEZ_MOCK_STEER_GATE`: a steering window (steer-tool hold, steer-late or hold tail) closes. */
  readonly openGate: () => void;
  /** Wait until the mock recorded `marker` on its wire (argv, requests or stdin). */
  readonly onWire: (marker: string) => Promise<void>;
}

interface DriveContract {
  readonly scenario: ScenarioName;
  readonly variant: string;
  readonly env?: Record<string, string>;
  readonly spec?: DriveSeamOptions['spec'];
  readonly sessionOptions?: DriveSeamOptions['sessionOptions'];
  /** Gate the scenario's steering windows on `MockControl.openGate`. */
  readonly steerGate?: boolean;
  readonly whileOpen: (session: AgentSession, recorder: Recorder, mock: MockControl) => Promise<void>;
}

/** Drive one runner's native mock with test-controlled gates, a wire recording and a recorder. */
async function driveContract(backend: RunnerId, drive: DriveContract): Promise<ContractObservation> {
  const dir = mkdtempSync(join(tmpdir(), `cez-contract-${backend}-`));
  const releaseFile = join(dir, 'release');
  const gateFile = join(dir, 'steer-gate');
  const wireFiles = [join(dir, 'args.ndjson'), join(dir, 'stdin.ndjson')];
  const wire = () => wireFiles.map(file => existsSync(file) ? readFileSync(file, 'utf8') : '').join('\n');
  const recorder = new Recorder();
  try {
    const obs = await driveSeam(backend, drive.scenario, {
      spec: {
        ...drive.spec,
        env: {
          CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: wireFiles[0]!, CEZ_MOCK_STDIN_FILE: wireFiles[1]!,
          CEZ_MOCK_RELEASE_FILE: releaseFile, ...(drive.steerGate ? { CEZ_MOCK_STEER_GATE: gateFile } : {}), ...drive.env,
        },
      },
      sessionOptions: { ...drive.sessionOptions },
      onEvent: recorder.onEvent,
      whileOpen: async (session) => {
        recorder.session = session;
        try {
          await drive.whileOpen(session, recorder, {
            release: () => writeFileSync(releaseFile, ''),
            openGate: () => writeFileSync(gateFile, ''),
            onWire: marker => waitFor(() => wire().includes(marker)),
          });
        } finally {
          recorder.stop();
        }
      },
    });
    const runner = runnersUnderTest()(backend);
    return {
      backend, delivery: inputDeliveryOf(runner), obs, timeline: recorder.timeline, at: recorder.at,
      read: { heldAtTurnEnd: recorder.holdsAtTurnEnd[0], ...recorder.read },
      variant: drive.variant, systemPromptOnResume: runner.systemPromptOnResume,
      ...(recorder.released === undefined ? {} : { released: recorder.released }),
    };
  } finally {
    recorder.stop();
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Wait until a mid-turn human message is on the mock's wire, when the runner writes it there while
 * the turn runs. An `always-held` runner keeps it until the turn ends, so nothing reaches the wire.
 */
async function deliveredMidTurn(backend: RunnerId, mock: MockControl): Promise<void> {
  if (inputDeliveryOf(runnersUnderTest()(backend)).humanInputAtTurnEnd !== 'always-held') await mock.onWire(FOLLOW_UP);
}

const v1Of = (recorder: Recorder): AgentEvent[] => recorder.timeline.flatMap(entry => 'v1' in entry ? [entry.v1] : []);
const turnStarted = (recorder: Recorder) => recorder.timeline.some(isStart);
const turnEnds = (recorder: Recorder) => v1Of(recorder).filter(event => event.type === 'turn-end').length;

/**
 * Where the follow-up sent at `sentAt` reached the model: the first assistant text that carries its
 * marker. A mock that answers a deferred turn with its ordinary reply (Codex, OpenCode) echoes no
 * marker. The follow-up is then the turn after the opening one: the first turn that starts after both
 * the send and the opening turn's end, since the row sends nothing else.
 */
function followUpAt(timeline: readonly ContractEntry[], sentAt: number): number {
  const echoed = indexFrom(timeline, carries(FOLLOW_UP), sentAt + 1);
  if (echoed >= 0) return echoed;
  const openingEnd = nth(timeline, isCompleted, 1);
  if (openingEnd < 0) return -1;
  const started = indexFrom(timeline, isStart, Math.max(sentAt, openingEnd) + 1);
  return started < 0 ? -1 : indexFrom(timeline, entry => isItem(entry) || isV1Content(entry), started + 1);
}

/** The follow-up reached the model, and the normalized turn that carries it completed. */
function carrierSettled(recorder: Recorder): boolean {
  const carrier = followUpAt(recorder.timeline, recorder.at.get('sent') ?? 0);
  return carrier >= 0 && turnAround(recorder.timeline, carrier).end >= 0;
}

/** A compact stream for a failure message. */
export function describeTimeline(timeline: readonly ContractEntry[]): string {
  return timeline.map((entry, index) => {
    if ('mark' in entry) return `${index} mark ${entry.mark}`;
    if ('v1' in entry) return `${index} v1 ${entry.v1.type}${entry.v1.type === 'text' ? ` ${JSON.stringify(entry.v1.text.slice(0, 40))}` : ''}`;
    return `${index} v2 ${entry.v2.type}${textOf(entry) ? ` ${JSON.stringify(textOf(entry).slice(0, 40))}` : ''}`;
  }).join('\n');
}

// ---- S36: acknowledgement ------------------------------------------------------------------------

const ACK_IDS = ['contract-S36-running', 'contract-S36-stopped'] as const;

/** The runner reported agent input `id` unread: at a turn end, or on its own. */
const reportedUnread = (timeline: readonly ContractEntry[], id: string) => timeline.some(entry => 'v1' in entry &&
  ((entry.v1.type === 'turn-end' && !!entry.v1.unconsumedInputIds?.includes(id)) || (entry.v1.type === 'input-unconsumed' && entry.v1.inputIds.includes(id))));

async function observeAcknowledgement(backend: RunnerId): Promise<ContractObservation> {
  const consumed: string[] = [];
  let recorder: Recorder | undefined;
  return driveContract(backend, {
    scenario: 'hold-gated', variant: 'acknowledgement',
    sessionOptions: { onAgentInputConsumed: ids => { for (const id of ids) { consumed.push(id); recorder?.mark(`consumed:${id}`); } } },
    whileOpen: async (session, rec, mock) => {
      recorder = rec;
      const delivery = inputDeliveryOf(runnersUnderTest()(backend));
      const steer = delivery.mode === 'steer';
      const send = (id: string) => session.sendAgentMessage([{ type: 'text', text: `mock:agent-echo ${id}` }], [id]);
      const acknowledged = (id: string, ack: Promise<void>) => ack.then(() => { rec.mark(`ack:${id}`); });
      await waitFor(() => turnStarted(rec));
      if (steer) {
        // S12 owns admission: startup may refuse once (Codex has no thread yet); the running turn admits.
        let first: false | Promise<void> = false;
        await waitFor(() => {
          first = send(ACK_IDS[0]);
          return first !== false;
        });
        rec.mark(`sent:${ACK_IDS[0]}`);
        await acknowledged(ACK_IDS[0], first as unknown as Promise<void>);
        // A stopped native process can neither read the wire nor answer it: only a local write
        // can acknowledge input while it is stopped.
        const pid = session.pid;
        expect(pid).toBeTypeOf('number');
        process.kill(pid!, 'SIGSTOP');
        let second: false | Promise<void> = false;
        try {
          second = send(ACK_IDS[1]);
          rec.mark(`sent:${ACK_IDS[1]}`);
          expect(second).not.toBe(false);
          const ack = acknowledged(ACK_IDS[1], second as Promise<void>);
          if (delivery.acknowledgement === 'write') {
            // bound: a write acknowledges with the process stopped; the assertion reports one that waits.
            await Promise.race([ack, new Promise(resolve => setTimeout(resolve, 10_000))]);
          } else {
            // bound: proves a response-acknowledged input stays unacknowledged while its process is
            // stopped. A stopped process cannot answer at any load, so the observed time decides only
            // how long the row looks, never whether a correct runner passes.
            await new Promise(resolve => setTimeout(resolve, 300));
          }
          rec.read.ackedWhileStopped = rec.at.has(`ack:${ACK_IDS[1]}`);
        } finally {
          process.kill(pid!, 'SIGCONT');
        }
        await second;
        mock.release();
      } else {
        mock.release();
        await waitFor(() => turnEnds(rec) >= 1);
        const ack = send(ACK_IDS[0]);
        rec.mark(`sent:${ACK_IDS[0]}`);
        expect(ack).not.toBe(false);
        await acknowledged(ACK_IDS[0], ack as Promise<void>);
      }
      const sent = ACK_IDS.filter(id => rec.at.has(`sent:${id}`));
      const reported = (id: string) => consumed.includes(id) || reportedUnread(rec.timeline, id);
      if (delivery.consumption === 'unobservable') {
        // Nothing reports the read: the input's own turn ending is the last signal.
        await waitFor(() => turnEnds(rec) >= 2);
        return;
      }
      // bound: an observable runner reports each input read or unread; a missing report fails the row.
      await waitFor(() => sent.every(reported) && turnEnds(rec) >= 1, 10_000).catch(() => undefined);
    },
  });
}

function assertAcknowledgement({ delivery, timeline, at, read }: ContractObservation): void {
  const trace = `\n${describeTimeline(timeline)}`;
  const sent = ACK_IDS.filter(id => at.has(`sent:${id}`));
  expect(sent.length).toBeGreaterThan(0);
  for (const id of sent) {
    const sentAt = at.get(`sent:${id}`)!;
    const ackAt = at.get(`ack:${id}`);
    expect(ackAt, `${id} acknowledged${trace}`).toBeDefined();
    const between = timeline.slice(sentAt + 1, ackAt);
    if (delivery.acknowledgement === 'model-work') expect(between.some(isStart), `${id} acknowledged at model work${trace}`).toBe(true);
    else expect(between.filter(isModelWork), `${id} acknowledged before model work${trace}`).toEqual([]);
    const consumedAt = at.get(`consumed:${id}`);
    if (delivery.consumption === 'unobservable') expect(consumedAt, `${id} consumption is unobservable${trace}`).toBeUndefined();
    // An observable runner reports every input it accepted: read, or unread.
    else if (consumedAt === undefined) expect(reportedUnread(timeline, id), `${id} reported read or unread${trace}`).toBe(true);
    // Consumption is the model's read: it follows the acknowledgement and a native frame after it.
    else {
      expect(consumedAt, `${id} consumed after its acknowledgement${trace}`).toBeGreaterThan(ackAt!);
      expect(timeline.slice(ackAt! + 1, consumedAt).some(entry => !('mark' in entry)), `${id} consumed on a native frame${trace}`).toBe(true);
    }
  }
  if (delivery.mode === 'steer') {
    expect(sent).toEqual([...ACK_IDS]);
    expect(read.ackedWhileStopped, `acknowledged while the native process was stopped${trace}`).toBe(delivery.acknowledgement === 'write');
  }
}

// ---- S37: turn start -----------------------------------------------------------------------------

async function observeTurnStart(backend: RunnerId): Promise<ContractObservation> {
  return driveContract(backend, {
    scenario: 'hold', variant: 'follow-up',
    whileOpen: async (session, rec) => {
      await waitFor(() => turnEnds(rec) >= 1);
      // The deferred token holds the follow-up's native turn start 800 ms after its prompt.
      rec.sendHuman(session, `${FOLLOW_UP} ${DEFERRED_TURN_START}`);
      await waitFor(() => carrierSettled(rec) && turnEnds(rec) >= 2);
    },
  });
}

function assertTurnStart({ timeline }: ContractObservation): void {
  const trace = `\n${describeTimeline(timeline)}`;
  const firstCompleted = nth(timeline, isCompleted, 1);
  const firstTurnEnd = nth(timeline, isTurnEnd, 1);
  expect(firstCompleted).toBeGreaterThanOrEqual(0);
  const started = indexFrom(timeline, isStart, firstCompleted + 1);
  expect(started, `the follow-up turn starts${trace}`).toBeGreaterThan(firstCompleted);
  const content = [indexFrom(timeline, isItem, firstCompleted + 1), indexFrom(timeline, isV1Content, firstTurnEnd + 1)].filter(index => index >= 0);
  expect(content.length, `the follow-up turn has content${trace}`).toBeGreaterThan(0);
  for (const index of content) expect(index, `content follows turn.started${trace}`).toBeGreaterThan(started);
  expect(nth(timeline, isCompleted, 2), `turn.completed follows turn.started${trace}`).toBeGreaterThan(started);
  expect(nth(timeline, isTurnEnd, 2), `turn-end follows turn.started${trace}`).toBeGreaterThan(started);
}

// ---- S38: held human input until its turn starts --------------------------------------------------

const HELD_VARIANTS = {
  // The follow-up arrives while the turn runs; its native turn starts late.
  'mid-turn': `${FOLLOW_UP} ${DEFERRED_TURN_START}`,
  // H5's ordering: Pi and OMP acknowledge the steer inside the running turn, after its last model call.
  'late-ack': `${FOLLOW_UP} ${DEFERRED_TURN_START}:late-ack`,
  // The turn already ended: the follow-up opens the next turn, whose native start is late.
  idle: `${FOLLOW_UP} ${DEFERRED_TURN_START}`,
  // Sent while the session still starts, before its opening turn has started.
  startup: `${FOLLOW_UP} ${DEFERRED_TURN_START}`,
} as const;

async function observeHeld(backend: RunnerId, variant: keyof typeof HELD_VARIANTS): Promise<ContractObservation> {
  return driveContract(backend, {
    scenario: 'hold-gated', variant,
    whileOpen: async (session, rec, mock) => {
      if (variant === 'startup') {
        rec.sendHuman(session, HELD_VARIANTS[variant]);
        mock.release();
        await waitFor(() => carrierSettled(rec));
        return;
      }
      await waitFor(() => turnStarted(rec));
      if (variant === 'idle') {
        mock.release();
        await waitFor(() => turnEnds(rec) >= 1);
        rec.sendHuman(session, HELD_VARIANTS[variant]);
      } else {
        rec.sendHuman(session, HELD_VARIANTS[variant]);
        // H5's ordering needs the steer admitted while the turn is open, so the turn waits for it.
        // A plain follow-up may reach the mock before or after the turn ends: the hold starts at
        // sendMessage either way, so the arrival order cannot change this row's outcome.
        if (variant === 'late-ack') await deliveredMidTurn(backend, mock);
        mock.release();
      }
      await waitFor(() => carrierSettled(rec));
    },
  });
}

function assertHeld({ timeline, at, read, released }: ContractObservation): void {
  const trace = `\n${describeTimeline(timeline)}`;
  expect(read.heldAtSend, `held as soon as sendMessage admits it${trace}`).toBe(true);
  const carrier = followUpAt(timeline, at.get('sent')!);
  expect(carrier, `the follow-up reached the model${trace}`).toBeGreaterThan(at.get('sent')!);
  const turn = turnAround(timeline, carrier);
  expect(released, `the hold released${trace}`).toBeDefined();
  // (a) and (b): no release before the normalized turn that carries the input has started, and
  // none after that turn ended.
  expect(released!, `held until the carrying turn started${trace}`).toBeGreaterThan(turn.start);
  expect(released!, `released by the end of the carrying turn${trace}`).toBeLessThanOrEqual(turn.end + 1);
}

// ---- S39: held input never dropped at finish ------------------------------------------------------

async function observeFinish(backend: RunnerId): Promise<ContractObservation> {
  return driveContract(backend, {
    scenario: 'hold-gated', variant: 'auto-end',
    // The session is asked to close after its first turn, as a finished step is.
    sessionOptions: { autoEndAfterFirstTurn: true },
    whileOpen: async (session, rec, mock) => {
      await waitFor(() => turnStarted(rec));
      // Before or after the turn ends, the follow-up was sent while it ran, so it is held at that end.
      rec.sendHuman(session, `${FOLLOW_UP} ${DEFERRED_TURN_START}`);
      mock.release();
      // bound: the session closes on its own; the assertion reports a follow-up it dropped.
      await session.result.catch(() => undefined);
    },
  });
}

function assertFinish({ timeline, at, read }: ContractObservation): void {
  const trace = `\n${describeTimeline(timeline)}`;
  const firstTurnEnd = nth(timeline, isTurnEnd, 1);
  expect(firstTurnEnd).toBeGreaterThanOrEqual(0);
  const carrier = followUpAt(timeline, at.get('sent')!);
  expect(carrier, `the held follow-up reached the model before the session closed${trace}`).toBeGreaterThan(at.get('sent')!);
  if (carrier < firstTurnEnd) return;
  // Unread at the turn end: the hold reports it, and the follow-up runs in a turn of its own.
  expect(read.heldAtTurnEnd, `held at the turn end${trace}`).toBe(true);
  const turn = turnAround(timeline, carrier);
  expect(turn.start, `the follow-up opened its own turn${trace}`).toBeGreaterThan(nth(timeline, isCompleted, 1));
  expect(turn.end, `the follow-up turn completed${trace}`).toBeGreaterThan(carrier);
}

// ---- S40, S41: humanInputAtTurnEnd matches the wire -----------------------------------------------

async function observeTiming(backend: RunnerId, timing: 'early' | 'late'): Promise<ContractObservation> {
  return driveContract(backend, {
    scenario: timing === 'early' ? 'steer-tool' : 'steer-late', variant: timing, steerGate: true,
    whileOpen: async (session, rec, mock) => {
      // Early: while the turn's tool runs, before its last model call. Late: after its final text.
      // Either window stays open until the mock has the message, so no timer decides which it is.
      await waitFor(() => v1Of(rec).some(event => event.type === (timing === 'early' ? 'tool-call' : 'text')));
      rec.sendHuman(session, `${FOLLOW_UP} mock:agent-echo`);
      await deliveredMidTurn(backend, mock);
      mock.openGate();
      await waitFor(() => carrierSettled(rec) && turnEnds(rec) >= 1);
    },
  });
}

function assertTiming({ delivery, timeline, at, read, variant }: ContractObservation): void {
  const trace = `\n${describeTimeline(timeline)}`;
  const declared = delivery.humanInputAtTurnEnd;
  const readInTurn = declared === 'never-held' || (declared === 'held-when-late' && variant === 'early');
  const carrier = followUpAt(timeline, at.get('sent')!);
  expect(carrier, `the message reached the model${trace}`).toBeGreaterThan(at.get('sent')!);
  const firstCompleted = nth(timeline, isCompleted, 1);
  expect({ declared, readInTurn: carrier < firstCompleted, heldAtTurnEnd: read.heldAtTurnEnd })
    .toEqual({ declared, readInTurn, heldAtTurnEnd: !readInTurn });
  if (!readInTurn) expect(turnAround(timeline, carrier).start, `the held message opened the next turn${trace}`).toBeGreaterThan(firstCompleted);
}

// ---- S42: systemPromptOnResume matches the wire ---------------------------------------------------

async function observeSystemPrompt(backend: RunnerId, resume: boolean): Promise<ContractObservation> {
  const dir = mkdtempSync(join(tmpdir(), `cez-contract-${backend}-prompt-`));
  const files = [join(dir, 'args.ndjson'), join(dir, 'stdin.ndjson')] as const;
  try {
    // OpenCode resumes a session its server already holds; without one it takes the 404 fallback.
    if (resume && backend === 'opencode') seedOpencodeMockSession(files[0]);
    const observed = await driveContract(backend, {
      scenario: 'baseline', variant: resume ? 'resume' : 'fresh',
      env: { CEZ_MOCK_ARGS_FILE: files[0], CEZ_MOCK_STDIN_FILE: files[1] },
      // Codex resumes the thread its mock knows by id (S14).
      spec: { systemPrompt: SYSTEM_PROMPT, resume, sessionId: resume && backend === 'codex' ? 'th_mock_1' : PINNED_SESSION_ID },
      whileOpen: async (_session, rec) => { await waitFor(() => turnEnds(rec) >= 1); },
    });
    const records = files.flatMap(file => existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean) : []);
    return { ...observed, records };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertSystemPrompt({ backend, records = [], systemPromptOnResume, variant }: ContractObservation): void {
  const userPrompt = promptFor(backend, 'baseline');
  const carrying = records.filter(record => record.includes(SYSTEM_PROMPT));
  const trace = `\n${records.join('\n')}`;
  expect(carrying.length, `${variant} wire carries spec.systemPrompt${trace}`).toBeGreaterThan(0);
  if (systemPromptOnResume === 'resent') {
    // A system channel outside the conversation, which every process receives again.
    expect(carrying.filter(record => record.includes(userPrompt)), `resent: outside the opening turn${trace}`).toEqual([]);
  } else {
    // Prepended to the opening user turn, which the native thread keeps for a resume.
    expect(carrying.some(record => record.indexOf(SYSTEM_PROMPT) < record.indexOf(userPrompt)), `in-thread: prepended to the opening turn${trace}`).toBe(true);
  }
}

// ---- S43: every native process reported ---------------------------------------------------------

/** Whether a process with this pid runs now. */
function running(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code === 'EPERM'; }
}

async function observeProcesses(backend: RunnerId): Promise<ContractObservation> {
  const dir = mkdtempSync(join(tmpdir(), `cez-contract-${backend}-pids-`));
  const pidFile = join(dir, 'pids');
  const reported: { pid: number; alive: boolean }[] = [];
  const report = (pid: number | undefined) => { if (pid !== undefined) reported.push({ pid, alive: running(pid) }); };
  let last: number | undefined;
  try {
    const observed = await driveContract(backend, {
      scenario: 'hold', variant: 'processes', env: { CEZ_MOCK_PID_FILE: pidFile },
      sessionOptions: { onPidChange: report },
      whileOpen: async (session, rec) => {
        // As Squawk reads it: right after startSession returns (workflows/run/input-receipts.ts).
        report(session.pid);
        await waitFor(() => turnEnds(rec) >= 1);
        // A follow-up turn: a runner that starts a process per turn (Cursor print) starts another.
        rec.sendHuman(session, `${FOLLOW_UP} mock:agent-echo`);
        await waitFor(() => carrierSettled(rec) && turnEnds(rec) >= 2);
        last = session.pid;
      },
    });
    const started = existsSync(pidFile) ? readFileSync(pidFile, 'utf8').split('\n').filter(Boolean).map(Number) : [];
    return { ...observed, processes: { started, reported, ...(last === undefined ? {} : { last }) } };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertProcesses({ processes, timeline }: ContractObservation): void {
  const trace = `\n${JSON.stringify(processes)}\n${describeTimeline(timeline)}`;
  const { started = [], reported = [], last } = processes ?? {};
  expect(started.length, `the native mock started${trace}`).toBeGreaterThan(0);
  const pids = new Set(reported.map(entry => entry.pid));
  for (const pid of started) expect(pids.has(pid), `native process ${pid} reported${trace}`).toBe(true);
  for (const entry of reported) expect(entry.alive, `process ${entry.pid} ran when it was reported${trace}`).toBe(true);
  // Between turns a runner that starts a process per turn (Cursor print) runs none, so `pid` is unset.
  if (last !== undefined) expect(last, `pid names the last reported process${trace}`).toBe(reported.at(-1)?.pid);
}

// ---- S44: provider failure in a wake turn ---------------------------------------------------------

/** The opening prompt of the continuation a timer wake starts (workflows/waits-parity.testkit.ts). */
const WAKE_OPENING = 'Resume to receive the queued timer result.';
const FAILURE_VARIANTS = ['wake', 'gated'] as const;

async function observeProviderFailure(backend: RunnerId, variant: typeof FAILURE_VARIANTS[number]): Promise<ContractObservation> {
  const dir = mkdtempSync(join(tmpdir(), `cez-contract-${backend}-failure-`));
  const files = [join(dir, 'args.ndjson'), join(dir, 'stdin.ndjson')] as const;
  // `wake`: every continuation's opening prompt fails, as `persistentWakeFailure` does. `gated`: the
  // failing turn runs until the test releases it, as `gatedProviderFailure` does.
  const control = createFailureControl(dir, variant === 'wake' ? { mode: 'persistent', opening: WAKE_OPENING, failure: 'provider' } : { mode: 'gated-once' });
  try {
    if (variant === 'wake' && backend === 'opencode') seedOpencodeMockSession(files[0]);
    return await driveContract(backend, {
      scenario: variant === 'wake' ? 'baseline' : 'provider-error-controlled', variant,
      env: { CEZ_MOCK_FAILURE_CONTROL: control.path, CEZ_MOCK_ARGS_FILE: files[0], CEZ_MOCK_STDIN_FILE: files[1] },
      // A wake resumes the native session with its opening prompt (S14, S42).
      spec: variant === 'wake' ? { userPrompt: `${WAKE_OPENING} ${FOLLOW_UP}`, resume: true, sessionId: backend === 'codex' ? 'th_mock_1' : PINNED_SESSION_ID } : {},
      whileOpen: async (session, rec) => {
        if (variant === 'gated') {
          await waitFor(control.held);
          rec.mark('released');
          control.release();
        }
        await waitFor(() => v1Of(rec).some(event => event.type === 'error'));
        // Squawk interrupts a session on its first error (workflows/run/session-events.ts).
        rec.mark('interrupt');
        session.interrupt();
        // bound: the session must end after the interrupt; one that does not fails the test's timeout.
        await session.result.catch(() => undefined);
        rec.mark('ended');
      },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function assertProviderFailure({ timeline, at }: ContractObservation): void {
  const trace = `\n${describeTimeline(timeline)}`;
  const error = indexFrom(timeline, entry => 'v1' in entry && entry.v1.type === 'error');
  expect(error, `v1 error${trace}`).toBeGreaterThanOrEqual(0);
  const event = timeline[error] as { v1: Extract<AgentEvent, { type: 'error' }> };
  expect(event.v1.message.trim(), `the error names its cause${trace}`).not.toBe('');
  // run.ts ignores every event after the first error: a turn end before it would settle the turn as clean.
  expect(lastIndexBefore(timeline, isTurnEnd, error), `no turn end before the error${trace}`).toBe(-1);
  const v2Error = (entry: ContractEntry) => 'v2' in entry && (entry.v2.type === 'session.error' || (entry.v2.type === 'turn.completed' && entry.v2.stopReason === 'error'));
  expect(timeline.some(v2Error), `v2 reports the failure${trace}`).toBe(true);
  expect(timeline.some(entry => 'v2' in entry && entry.v2.type === 'turn.completed' && entry.v2.stopReason === 'end_turn'), `no clean v2 turn end${trace}`).toBe(false);
  expect(at.get('ended'), `the session ended after the interrupt${trace}`).toBeGreaterThan(at.get('interrupt')!);
}

export const SEAM_CONTRACT_ROWS: readonly SeamContractRow[] = [
  {
    id: 'S36', scenario: 'hold-gated', observe: observeAcknowledgement, assert: assertAcknowledgement,
    name: 'S36 acknowledges agent input at its declared point and reports consumption only after it',
  },
  {
    id: 'S37', scenario: 'hold', observe: observeTurnStart, assert: assertTurnStart,
    name: 'S37 starts a follow-up turn before its content and its turn end',
  },
  ...(Object.keys(HELD_VARIANTS) as (keyof typeof HELD_VARIANTS)[]).map(variant => ({
    id: 'S38', scenario: 'hold-gated' as const, observe: (backend: RunnerId) => observeHeld(backend, variant), assert: assertHeld,
    name: `S38 holds a human follow-up until the turn that carries it starts (${variant})`,
  })),
  {
    id: 'S39', scenario: 'hold-gated', observe: observeFinish, assert: assertFinish,
    name: 'S39 reports human input held at a turn end and runs it before the session closes',
  },
  {
    id: 'S40', scenario: 'steer-tool', observe: (backend: RunnerId) => observeTiming(backend, 'early'), assert: assertTiming,
    name: 'S40 reads or holds a human message sent before the last model call as humanInputAtTurnEnd declares',
  },
  {
    id: 'S41', scenario: 'steer-late', observe: (backend: RunnerId) => observeTiming(backend, 'late'), assert: assertTiming,
    name: 'S41 reads or holds a human message sent after the last model call as humanInputAtTurnEnd declares',
  },
  ...([false, true] as const).map(resume => ({
    id: 'S42', scenario: 'baseline' as const, observe: (backend: RunnerId) => observeSystemPrompt(backend, resume), assert: assertSystemPrompt,
    name: `S42 carries spec.systemPrompt as systemPromptOnResume declares (${resume ? 'resume' : 'fresh'})`,
  })),
  {
    id: 'S43', scenario: 'hold', observe: observeProcesses, assert: assertProcesses,
    name: 'S43 reports every native process it starts while that process runs',
  },
  ...FAILURE_VARIANTS.map(variant => ({
    // Both variants raise the failure control's provider error; the wake drives a baseline prompt.
    id: 'S44', scenario: 'provider-error-controlled' as const,
    observe: (backend: RunnerId) => observeProviderFailure(backend, variant), assert: assertProviderFailure,
    name: `S44 fails a ${variant === 'wake' ? 'wake continuation' : 'running'} turn on a provider error before any turn end, and ends once interrupted`,
  })),
];
