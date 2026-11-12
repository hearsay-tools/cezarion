import { WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';

import { expect, vi } from 'vitest';

import type { CiWait, CiWaitResult } from '@open-mercato/cezar-contract';
import { manager, parent, store, until, toolGenerationOf } from './worker-wait-claude.testkit.ts';
import { timed, fireCapturedTimer, type TimedWait } from './waits.testkit.ts';

// Tool transport is exercised by adapter parity; lifecycle tests control only the CI supervisor.
const hoistedResource = vi.hoisted(() => ({ supervisor: {} }));
export const externalResource = hoistedResource;
vi.mock('../ci-wait/resources.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../ci-wait/resources.ts')>();
  return { acquireCiResources: (workspace: object) => {
    const resources = original.acquireCiResources(workspace);
    const current = () => 'resolve' in hoistedResource.supervisor
      ? hoistedResource.supervisor as Pick<typeof resources.supervisor, 'resolve' | 'watch' | 'close'>
      : resources.supervisor;
    return { ...resources, supervisor: {
      resolve: (...args: Parameters<typeof resources.supervisor.resolve>) =>
        current().resolve(...args),
      watch: (...args: Parameters<typeof resources.supervisor.watch>) =>
        current().watch(...args),
      close: () => current().close(),
    } };
  } };
});

export const pr = 'https://github.com/acme/repo/pull/12';
export const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };
export const success = (): CiWaitResult => ({ outcome: 'passed', headSha: identity.headSha, observedAt: new Date().toISOString(), checks: [], totalChecks: 1, truncated: true });

// hearsay-tools/cezarion#1233: CI waits live in the run's wait list; a parked one is an open wait
// on a `waiting` run.
export const ciWaitOf = (id: string) => store.getRun(id)?.waits?.find(entry => entry.kind === 'pr');
export const lastCiWaitOf = (id: string) => [...(store.getRun(id)?.lastWaits ?? [])].reverse().find(entry => entry.kind === 'pr');
export const parked = (id: string) => ciWaitOf(id)?.phase === 'open' && store.getRun(id)?.status === 'waiting';

/** Control only external GitHub; RunManager, store, scheduler and runner wire stay real. */
export function github() {
  let settle!: (result: CiWaitResult) => void;
  let signal: AbortSignal | undefined;
  const result = new Promise<CiWaitResult>(resolve => { settle = resolve; });
  const supervisor = { resolve: async () => identity, watch: async (_wait: CiWait, abort: AbortSignal) => { signal = abort; return result; }, close() {} };
  externalResource.supervisor = supervisor;
  return { settle, aborted: () => signal?.aborted };
}

export async function register(id: string) {
  return timed(await manager.registerWait(id, { kind: WAIT_KIND.pr, pr, timeout_seconds: 30 }, 'cezar_wait', generationOf(id)));
}

// hearsay-tools/cezarion#1233: the wait list holds several CI and timer waits at once; each
// resolves, is cancelled or is recovered on its own.
export const generationOf = toolGenerationOf;
export const prUrl = (n: number) => `https://github.com/acme/repo/pull/${n}`;
export const registerPr = async (id: string, n: number, timeout = 30) =>
  timed(await manager.registerWait(id, { kind: WAIT_KIND.pr, pr: prUrl(n), timeout_seconds: timeout }, 'cezar_wait', generationOf(id)));
export const registerTimer = async (id: string, seconds = 60, note?: string) =>
  timed(await manager.registerWait(id, { kind: WAIT_KIND.timer, seconds, ...(note === undefined ? {} : { note }) }, 'cezar_wait', generationOf(id)));
export const waitById = (id: string, waitId: string) => store.getRun(id)?.waits?.find((entry): entry is TimedWait => entry.id === waitId && entry.kind !== 'human');
export const settledById = (id: string, waitId: string) => store.getRun(id)?.lastWaits?.find(entry => entry.id === waitId);
export const inputsFor = (id: string, waitId: string) => store.getRun(id)?.agentInputs?.filter(input => input.id === waitId) ?? [];
export const fireTimer = fireCapturedTimer;
export const timerFired = (waitId: string, note: string) =>
  `Timer ${waitId} fired: ${note}. Continue toward the task goal; register another wait if you are still waiting.`;
export const flushMicrotasks = async () => { for (let n = 0; n < 5; n++) await Promise.resolve(); };

/** External GitHub per PR number: each watch settles on its own; a gate holds every lookup. */
export function githubByPr(lookupGate?: Promise<void>) {
  const watches = new Map<number, { settle(result: CiWaitResult): void; signal: AbortSignal }>();
  const supervisor = {
    resolve: async (url: string) => { await lookupGate; return { ...identity, prUrl: url, prNumber: Number(url.split('/').pop()) }; },
    watch: (wait: CiWait, signal: AbortSignal) => new Promise<CiWaitResult>(resolve => { watches.set(wait.prNumber, { settle: resolve, signal }); }),
    close() {},
  };
  externalResource.supervisor = supervisor;
  return { settle: (n: number) => watches.get(n)!.settle(success()), aborted: (n: number) => watches.get(n)?.signal.aborted };
}

/** A root parked on Squawk's no-wait human wait: its turn took the no-wait nudge and answered it in
 *  plain text, one automatic wake (hearsay-tools/cezarion#1234). The agent's first wait replaces it. */
export async function waitingParent() {
  const run = await parent(); await until(() => store.getRun(run.id)?.status === 'waiting');
  return run;
}

/** Delivery starts a wake turn. Read its final list after the no-wait reply has settled. */
export async function expectNoWaitHumanWait(id: string) {
  await until(() => store.getRun(id)?.waits?.some(wait => wait.kind === WAIT_KIND.human && wait.via === WAIT_VIA['no-wait']) === true);
  expect(store.getRun(id)?.waits).toEqual([expect.objectContaining({
    kind: WAIT_KIND.human, source: WAIT_SOURCE.cezar, via: WAIT_VIA['no-wait'], phase: WAIT_PHASE.open, askSeq: expect.any(Number),
  })]);
}

