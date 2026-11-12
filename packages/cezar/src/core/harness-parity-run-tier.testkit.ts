import { RUN_STATUS, WAIT_KIND, WAIT_PHASE } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { TimerWaitEntry } from '@open-mercato/cezar-contract';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import { expect } from 'vitest';
import { testHome } from '../home/test-home.testkit.ts';
import type { RunStore } from '../runs/store.ts';
import { IDLE_TIMEOUT_MS, type RunManager } from '../workflows/run.ts';
import { WorkspaceSemaphore } from '../workspace/semaphore.ts';
import { exemptionFor, HARNESS_ADAPTERS, type ScenarioName } from './harness-parity-core.testkit.ts';
import type { Cells, HarnessRegistrar } from './harness-parity-registrar.testkit.ts';
import { RUN_ROWS } from './harness-parity-rows.testkit.ts';
import { observationClock } from './observation-clock.testkit.ts';
import { driveRun, driveUnavailableProvider, type RunObservation } from './workflow-parity-core.testkit.ts';

/** The run tier's row cells (R1–R17, R126–R128) and the run drive the run-level parts share. */

/** One row of the run tier. `settled` says when the run has reached the state
 *  the row is about, so a row waits for its own condition rather than a sleep. */
export interface RunCriterion {
  readonly id: string;
  readonly name: string;
  readonly scenario: ScenarioName;
  readonly timeoutMs?: number;
  readonly settled: (record: RunObservation['record']) => boolean;
  readonly assert: (obs: RunObservation) => void;
}

export const TERMINAL: readonly string[] = ['review', 'done', 'failed', 'cancelled'];

const askEvents = (obs: RunObservation) =>
  obs.events.filter((e) => e.type === 'ask.requested');

/** The open timer wait a declared park registered: a cezar_wait timer, or a monitoring timer. Since
 *  the lifecycle markers went (hearsay-tools/cezarion#2397) every scenario parks through cezar_wait;
 *  `waiting` with an open timer reads as monitoring (hearsay-tools/cezarion#1233). */
export const openTimerWait = (run?: { waits?: readonly unknown[] | undefined } | null): TimerWaitEntry | undefined =>
  (run?.waits as TimerWaitEntry[] | undefined)?.find(wait => wait.kind === WAIT_KIND.timer && wait.phase === WAIT_PHASE.open);
export const timerWakeOf = (run?: { waits?: readonly unknown[] | undefined } | null): string | undefined => openTimerWait(run)?.deadline;

/** Drive the native run with owned capacity and only its idle timer frozen. */
export function driveObservedRun(
  backend: Parameters<typeof driveRun>[0], scenario: Parameters<typeof driveRun>[1],
  settled: Parameters<typeof driveRun>[2], timeout: number,
  observe: (context: { store: RunStore; manager: RunManager; runId: string; repoRoot: string; idle: ReturnType<typeof observationClock>; semaphore: WorkspaceSemaphore }) => Promise<void>,
  options: NonNullable<Parameters<typeof driveRun>[5]> = {},
) {
  let repoRoot = '';
  let idle: ReturnType<typeof observationClock>;
  const semaphore = new WorkspaceSemaphore({ home: testHome() });
  return driveRun(backend, scenario, settled, timeout, context => observe({ ...context, repoRoot, idle, semaphore }), {
    ...options, semaphore,
    beforeStart: context => {
      repoRoot = context.repoRoot;
      idle = observationClock(delay => delay === IDLE_TIMEOUT_MS && /armIdleTimer/.test(new Error().stack ?? ''));
      options.beforeStart?.(context);
    },
    beforeCleanup: () => { idle?.restore(); options.beforeCleanup?.(); },
  });
}

/** Settle on the hold or a terminal status; a hold that settles as `failed` fails the assertion. */
const providerHold = () => ({
  settled: (record: RunObservation['record']) => TERMINAL.includes(record?.status ?? '') || record?.status === 'waiting',
});

/**
 * The provider-error hold (hearsay-tools/squawk#3337): the run waits with a retry time and its error
 * kept, and is never `failed` on the way. Its lifecycle line names the error class and the first
 * attempt, and its retry time is the first back-off delay (1 minute) after the turn failed, read
 * against the hold's lifecycle line.
 */
function assertProviderHold(obs: RunObservation, label: string): void {
  expect(obs.statuses).not.toContain('failed');
  expect(obs.record).toMatchObject({ status: RUN_STATUS.waiting, autoResumeReason: 'provider-error' });
  expect(obs.record?.autoResumeAt).toBeDefined();
  expect(obs.record?.error?.trim()).toBeTruthy();
  const holds = obs.events.filter(event => event.type === 'lifecycle' && String(event.message).startsWith('provider error ('));
  expect(holds).toHaveLength(1);
  expect(String(holds[0]!.message)).toMatch(new RegExp(`^provider error \\(${label}: .+\\) — retrying automatically at .+ \\(attempt 1 of 12\\)$`));
  // Measured from the hold's own lifecycle line, written with the hold, so host load does not move it.
  const delay = Date.parse(obs.record!.autoResumeAt!) - Date.parse(String(holds[0]!.ts));
  expect(delay).toBeGreaterThan(55_000);
  expect(delay).toBeLessThanOrEqual(60_000);
}

const RUN_CELLS: Cells<typeof RUN_ROWS, RunCriterion> = {
  R17: {
    // hearsay-tools/squawk#3337: an unavailable provider holds the run and retries it. Codex keeps
    // its turn open and emits retryable errors (#550) until its no-progress bound ends the turn;
    // the other wires answer 503 at once.
    timeoutMs: 75_000,
    ...providerHold(),
    assert: obs => {
      assertProviderHold(obs, 'provider server error');
      if (obs.record?.runner === 'codex') {
        expect(obs.record.error).toContain('Connection failed: error sending request');
        expect(obs.events).toContainEqual(expect.objectContaining({
          type: 'session.error', fatal: false,
          message: 'Reconnecting... 2/5 — stream disconnected before completion: invalid peer certificate: UnknownIssuer',
        }));
      }
    },
  },
  R126: { ...providerHold(), assert: obs => assertProviderHold(obs, 'rate limit') },
  R127: { ...providerHold(), assert: obs => assertProviderHold(obs, 'model endpoint not found') },
  R128: { ...providerHold(), assert: obs => assertProviderHold(obs, 'credit balance') },
  R1: {
    // Group 7 — a run whose agent DECLARED completion reaches Squawk's review
    // gate, which is a non-attention terminal state (Squawk never auto-merges).
    // The scenario has to declare it: a markerless turn-end parks as `waiting`
    // on every backend, and that is correct behaviour, not a defect.
    settled: (record) => TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(['review', 'done']).toContain(obs.record?.status);
      expect(obs.statuses).not.toContain('waiting');
    },
  },
  R2: {
    // Group 1 / #53, #54 — the row that would have caught both on whichever
    // backend shipped the bug second. The scenario is a request the provider rejects as invalid
    // (HTTP 400): no retry can succeed, so the run fails rather than holding (hearsay-tools/squawk#3337). `statuses` rather than the final status:
    // the defect was a park, and a run that parked and later failed anyway is
    // still the bug the user saw.
    // `waiting` settles too, so the defect fails on the assertion below rather
    // than as an opaque timeout: a parked run is the bug, not a slow one.
    settled: (record) => TERMINAL.includes(record?.status ?? '') || record?.status === 'waiting',
    assert: (obs) => {
      expect(obs.record?.status).toBe('failed');
      expect(obs.statuses).not.toContain('waiting');
    },
  },
  R3: {
    // Group 3 / #6, #473 — an ask has to reach the cockpit as exactly one card
    // and park the run for the user. The two wires differ underneath: codex and
    // opencode have native asks their runners map; claude, pi, omp and cursor call
    // cezar_ask, whose human wait `workflows/run.ts` opens. Above the seam that
    // difference must be invisible.
    settled: (record) => record?.status === 'waiting' || TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(obs.record?.status).toBe('waiting');
      expect(askEvents(obs)).toHaveLength(1);
    },
  },
  R4: {
    // Group 3 — the other half, and the one that hangs a run when it is wrong:
    // a malformed ask must render no card AND still end its turn. A backend
    // that waits forever for an answer to a question nobody can see is the
    // failure this pins; `settled` returning is itself part of the assertion.
    settled: (record) => record?.status === 'waiting' || TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(askEvents(obs)).toEqual([]);
      expect([...TERMINAL, 'waiting']).toContain(obs.record?.status);
    },
  },
  R5: {
    // Group 6 / #48 — a declared park is a non-attention state: a cezar_wait timer parks
    // the run as monitoring, never as Needs You.
    settled: (record) => record?.status === 'waiting',
    assert: (obs) => {
      // hearsay-tools/cezarion#1233: `waiting` plus an open timer reads as monitoring.
      expect(obs.record).toMatchObject({ status: RUN_STATUS.waiting });
      expect(timerWakeOf(obs.record)).toBeDefined();
      expect(deriveAttention(obs.record!).label).toBe('monitoring');
    },
  },
  R12: {
    // #149: the child message lands before the parent's turn-end, after its cezar_wait.
    settled: (record) => record?.status === 'waiting',
    assert: (obs) => {
      expect(obs.record).toMatchObject({ status: RUN_STATUS.waiting });
      expect(timerWakeOf(obs.record)).toBeDefined();
      expect(deriveAttention(obs.record!).label).toBe('monitoring');
    },
  },
};
export const RUN_CRITERIA: readonly RunCriterion[] = RUN_ROWS.map(row => ({ ...row, ...RUN_CELLS[row.id] }));

export function runRows({ runners, it }: HarnessRegistrar, criteria: readonly RunCriterion[]): void {
  for (const backend of runners) {
    for (const criterion of criteria) {
      const exempt = exemptionFor(criterion.id, backend);
      if (exempt?.kind === 'scenario-unconstructible') {
        it(`${backend} is exempt from ${criterion.id} — ${exempt.reason}`, () => {
          expect(HARNESS_ADAPTERS[backend].scenarios[criterion.scenario]).toBeUndefined();
        });
        continue;
      }
      it(
        exempt
          ? `${backend} is exempt from ${criterion.id} — ${exempt.reason}`
          : `${backend} ${criterion.name}`,
        async () => {
          const drive = criterion.id === 'R17' ? driveUnavailableProvider : driveRun;
          const obs = await drive(backend, criterion.scenario, criterion.settled, criterion.timeoutMs);
          if (exempt) expect(() => criterion.assert(obs)).toThrow();
          else criterion.assert(obs);
        },
        (criterion.timeoutMs ?? 55_000) + 5_000,
      );
    }
  }
}
