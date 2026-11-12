import { afterEach, expect, vi } from 'vitest';
import { WAIT_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import type { CezarWaitRequestInput, CiWait, CiWaitResult, Wait } from '@open-mercato/cezar-contract';
import type { RunnerId } from '../core/agent-runner.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity.testkit.ts';
import { CiWatcherSupervisor } from '../ci-wait/supervisor.ts';
import { acquireCiResources } from '../ci-wait/resources.ts';
import { manager, root, semaphore, store, until, useWorkerWaitFixture, work, toolGenerationOf } from './worker-wait.testkit.ts';
import { observationClock } from '../core/observation-clock.testkit.ts';
import { fireCapturedTimer, timed, type TimedWait } from './waits.testkit.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { ciNativeMessages, toolCall } from './waits-parity.testkit.ts';

// hearsay-tools/cezarion#1233: shared setup for the waits-wake-*.test.ts files, which pin how
// resolved waits wake a run beside a pending question, what every delivered turn ends with, and
// which parks hold a slot. The runner wires, store and scheduler are real; only GitHub is controlled.

/** The fixture every waits-wake file runs under: worker-wait's, with nudges answered by a card. */
export function useWaitsWakeFixture(): void {
  useWorkerWaitFixture({ nudgeReply: 'card', acquireCiResources });
  afterEach(() => vi.restoreAllMocks());
}

export const prUrl = (n: number) => `https://github.com/acme/repo/pull/${n}`;
export const pr = prUrl(12);
const passed = (headSha: string): CiWaitResult => ({ outcome: 'passed', headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: false });

/** GitHub per PR number: each watch settles when the test says so. */
export function github() {
  const watches = new Map<number, (result: CiWaitResult) => void>();
  vi.spyOn(CiWatcherSupervisor.prototype, 'resolve').mockImplementation(async (url: string) =>
    ({ prUrl: url, repository: 'acme/repo', prNumber: Number(url.split('/').pop()), headSha: 'a'.repeat(40) }));
  vi.spyOn(CiWatcherSupervisor.prototype, 'watch').mockImplementation((wait: CiWait) =>
    new Promise<CiWaitResult>(resolve => { watches.set(wait.prNumber, resolve); }));
  return { settle: (n = 12) => watches.get(n)!(passed('a'.repeat(40))) };
}

export function nativeWire(runner: RunnerId) {
  process.env.CEZ_DRY_RUN = '0';
  process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
  process.env.CEZ_MOCK_ARGS_FILE = join(root, 'args');
  process.env.CEZ_MOCK_STDIN_FILE = join(root, 'stdin');
}

export const session = () => [...work.liveSessions].find(session => session.open)!;
export function wakeRetryClock() {
  const delays: number[] = [];
  const clock = observationClock(delay => {
    if (delay === undefined || !/\bat (?:[^ (\n]+\.)?backoff \(/.test(new Error().stack ?? '')) return false;
    delays.push(delay);
    return true;
  });
  return Object.assign(clock, { delays });
}
export async function pump() {
  await semaphore.release();
  await Promise.all([...work.pending].filter(([, label]) => label === 'pump').map(([task]) => task));
}
export async function openWait(id: string, request: CezarWaitRequestInput): Promise<TimedWait> {
  const tools = manager.cezarToolHandlers(id, toolGenerationOf(id));
  const registered = await tools.registerWait(request, 'cezar_wait', new AbortController().signal);
  if (!('wait' in registered)) throw Error('registration refused');
  return timed(registered.wait);
}
/** A Claude run parked on the timers its first turn registered through `cezar_wait`, in order.
 *  Nothing human is open, so a baseline turn's no-wait nudge never interferes (hearsay-tools/cezarion#1234).
 *  Live sessions only: a scheduler continuation quotes the task, and the mock would call the tools again. */
export async function parkedOnTimers<const T extends readonly { seconds: number; note: string }[]>(...timers: T) {
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: timers.map(timer => toolCall('cezar_wait', { kind: WAIT_KIND.timer, ...timer })).join(' '), runner: 'claude' });
  await until(() => store.getRun(run.id)?.status === 'waiting' && store.getRun(run.id)?.waits?.length === timers.length);
  const waits = timers.map(timer => structuredClone(store.getRun(run.id)!.waits!.find(wait => wait.kind === 'timer' && wait.note === timer.note)!)) as { [K in keyof T]: Wait };
  return { run, waits };
}
export const fireTimer = (waitId: string) => fireCapturedTimer(waitId);
export const turnStarted = (id: string) => store.readEvents(id).some(event => event.type === 'turn.started');
export const turnEnds = (id: string) => store.readEvents(id).filter(event => event.type === 'turn-end').length;
export const asks = (id: string) => store.readEvents(id).filter(event => event.type === 'ask.requested');
export const waitById = (id: string, waitId: string) => store.getRun(id)?.waits?.find(wait => wait.id === waitId);
export const settled = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(wait => wait.id === waitId);
export const prompted = (runner: RunnerId, text: string) => ciNativeMessages(runner, root).filter(prompt => prompt.includes(text));
export const label = (id: string) => deriveAttention(store.getRun(id)!).label;
export const answered = (id: string, askSeq: number) => store.readEvents(id).some(event => event.type === 'human-input-delivered' && event.askSeq === askSeq);
export const flushMicrotasks = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };
export const FOOTER_END = 'Call cezar_cancel_wait for any you no longer need.';
export const notes = (id: string, text: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).includes(text));

/** A portable question parked beside an open CI wait registered during its turn. */
export async function questionBesideCi(runner: RunnerId) {
  nativeWire(runner);
  const release = join(root, 'ask-release');
  process.env.CEZ_MOCK_RELEASE_FILE = release;
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS[runner].scenarios['hold-cezar-ask']!, runner });
  await until(() => turnStarted(run.id));
  const ci = await openWait(run.id, { kind: WAIT_KIND.pr, pr, timeout_seconds: 600 });
  writeFileSync(release, '');
  await until(() => asks(run.id).length === 1 && store.getRun(run.id)?.status === 'waiting');
  expect(waitById(run.id, ci.id)?.phase).toBe('open');
  expect(label(run.id)).toBe('needs you');
  return { run, ci, askSeq: asks(run.id)[0]!.seq };
}

/** A timer owed by a run whose session is closed: its wake is a scheduler continuation. The
 *  baseline task, quoted in that continuation's opening prompt, starts no scenario of its own. */
export async function timerOwedWithoutSession() {
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { task: HARNESS_ADAPTERS.claude.scenarios.baseline!, runner: 'claude' });
  await until(() => store.getRun(run.id)?.status === 'waiting');
  const timer = await openWait(run.id, { kind: WAIT_KIND.timer, seconds: 60, note: 'owed' });
  session().end();
  await until(() => !manager.isActive(run.id));
  return { run, timer };
}
