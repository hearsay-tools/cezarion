import { productName } from '../home/display.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import type { SubagentWaitEntry, TimerWaitEntry, Wait } from '@open-mercato/cezar-contract/waits';
import { RUN_STATUS, SUBAGENT_STATUS, WAIT_KIND, WAIT_PHASE, WAIT_SOURCE, WAIT_VIA } from '@open-mercato/cezar-contract/test-factories.testkit';
import { RUNNER_IDS, type RunnerId } from '../core/agent-runner.ts';
import { exemptionReasonProblem } from '../core/exemption-reason.testkit.ts';
import { observationClock } from '../core/observation-clock.testkit.ts';
import { HARNESS_ADAPTERS } from '../core/harness-parity-core.testkit.ts';
import { reportsNativeSubagents } from './run/subagent-waits.ts';
import { MAX_AUTO_CONTINUES } from './run.ts';
import { stateOf } from './run-states.ts';
import { NO_WAIT_NUDGE_NOTE } from './turn-end.ts';
import { QUICK_TASK_WORKFLOW } from './types.ts';
import { manager, restart, root, semaphore, store, until, useWorkerWaitFixture } from './worker-wait-core.testkit.ts';
import { SUBAGENT_CRITERIA, SUBAGENT_EXEMPTIONS, type SubagentCriterion } from './waits-subagents-rows.testkit.ts';

/**
 * Squawk's wait on native subagents (hearsay-tools/cezarion#2431) on each runner's own native mock
 * wire: the runner maps a backgrounded child, and the engine parks, wakes and supersedes on what it
 * maps. A runner whose wire cannot carry a row has a named exemption with its reason; the guard
 * below pins each one to the runner having no scenario for it, so the day a mock carries it the
 * exemption fails and the row has to go live.
 */

export { SUBAGENT_CRITERIA, SUBAGENT_EXEMPTIONS };

/** The prompt each runner's mock answers with backgrounded children (Worker A's scenarios). */
const SCENARIO: Partial<Record<RunnerId, string>> = { claude: 'mock:subagent-background', codex: 'mock:subagent-background' };

const exemptionOf = (criterion: SubagentCriterion, runner: RunnerId) => SUBAGENT_EXEMPTIONS.find(entry => entry.criterion === criterion && entry.runner === runner);

function nativeWire(runner: RunnerId) {
  process.env.CEZ_DRY_RUN = '0';
  process.env[HARNESS_ADAPTERS[runner].binEnv] = HARNESS_ADAPTERS[runner].mockBin;
}

const subagentWait = (id: string): SubagentWaitEntry | undefined =>
  store.getRun(id)?.waits?.find((wait): wait is SubagentWaitEntry => wait.kind === WAIT_KIND.subagent && wait.phase === WAIT_PHASE.open);
const settledOf = (id: string, waitId: string): Wait | undefined => store.getRun(id)?.lastWaits?.filter(wait => wait.id === waitId).at(-1);
const nudges = (id: string) => store.readEvents(id).filter(event => event.type === 'note' && String(event.message).startsWith(NO_WAIT_NUDGE_NOTE)).length;
/** Wakes the waits spent: the count less the no-wait nudges a mock's markerless reply earns. */
const wakes = (id: string) => (store.getRun(id)?.automaticWakes ?? 0) - nudges(id);
const wakeInputs = (id: string, waitId: string) => (store.getRun(id)?.agentInputs ?? []).filter(input => input.id === waitId);
/** The grace a child end arms (`SubagentWaits.armGrace`), on a fake clock the cell moves; the
 *  mock runner keeps real time. */
const graceClock = () => observationClock(() => /SubagentWaits\.armGrace/.test(new Error().stack ?? ''));

/** A run parked on the subagent wait; `release()` lets the mock end its children. */
async function parkedOnSubagents(runner: RunnerId, tokens = '') {
  nativeWire(runner);
  // With no monitoring exemptions, a pool member holds exactly one slot; an ordinary park holds none.
  vi.spyOn(semaphore, 'maxMonitoringSessions').mockReturnValue(0);
  const release = join(root, `release-${randomUUID()}`);
  const run = manager.startRun(QUICK_TASK_WORKFLOW, { runner, task: `${SCENARIO[runner]!} ${tokens} parity-release=${release}` });
  await until(() => store.readEvents(run.id).some(event => event.type === 'turn-end'));
  expect(store.getRun(run.id)?.status).toBe(RUN_STATUS.waiting);
  expect(subagentWait(run.id)).toBeDefined();
  expect(semaphore.busy()).toBe(1);
  return { id: run.id, wait: subagentWait(run.id)!, release: () => writeFileSync(release, 'go') };
}

/** The cells of `SUBAGENT_CRITERIA` for each runner in `runners`. */
export function subagentCells(runners: readonly RunnerId[]): void {
  if (!runners.length) return;
  for (const runner of runners) {
    describe(`native subagents on the ${runner} wire (hearsay-tools/cezarion#2431)`, { timeout: 60_000 }, () => {
      useWorkerWaitFixture({ subagentGraceMs: 200 });
      const cell = (criterion: SubagentCriterion, body: () => Promise<void>) => {
        const row = SUBAGENT_CRITERIA.find(entry => entry.id === criterion)!;
        const exempt = exemptionOf(criterion, runner);
        if (exempt) it(`${runner} is exempt from ${criterion} — ${exempt.reason}`, () => { expect(exempt.reason.trim()).not.toBe(''); });
        else it(`${runner} ${criterion} ${row.name}`, body);
      };

      cell('U30', async () => {
        const { id, wait } = await parkedOnSubagents(runner, 'mock:monitoring');
        const run = store.getRun(id)!;
        expect(stateOf(run)).toBe('waiting:subagents');
        expect(deriveAttention(run)).toMatchObject({ rung: 'waiting-on-subagents', label: 'waiting for 1 subagent', pulse: false });
        expect(wait.children).toEqual([expect.objectContaining({ status: SUBAGENT_STATUS.running })]);
        // The monitoring line it ended with opened no timer, and nothing spent a wake.
        expect(run.waits?.filter(entry => entry.kind === WAIT_KIND.timer)).toEqual([]);
        expect(run.automaticWakes ?? 0).toBe(0);
      });

      cell('U31', async () => {
        const { id, wait, release } = await parkedOnSubagents(runner, 'subagent-resume');
        const timer: TimerWaitEntry = { id: randomUUID(), kind: WAIT_KIND.timer, source: WAIT_SOURCE.agent, via: WAIT_VIA.cezar_wait, phase: WAIT_PHASE.open,
          turnId: 'seed', seconds: 600, registeredAt: new Date().toISOString(), deadline: new Date(Date.now() + 600_000).toISOString() };
        store.commitWait(id, timer);
        const turns = store.readEvents(id).filter(event => event.type === 'turn.started').length;
        const grace = graceClock();
        release();
        await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.cancelled);
        expect(settledOf(id, wait.id)).toMatchObject({ result: { reason: 'superseded' } });
        expect(settledOf(id, timer.id)).toMatchObject({ phase: WAIT_PHASE.cancelled });
        await until(() => store.readEvents(id).filter(event => event.type === 'turn.started').length > turns);
        // The runner's own turn cleared the grace, and past it no wake goes.
        expect(grace.pending).toBe(0);
        await grace.advance(200);
        expect(wakeInputs(id, wait.id)).toEqual([]);
        expect(wakes(id)).toBe(0);
      });

      for (const [criterion, status, reads] of [['U32', 'completed', 'completed'], ['U33', 'failed', 'failed'], ['U34', 'stopped', 'cancelled']] as const) {
        cell(criterion, async () => {
          const { id, wait, release } = await parkedOnSubagents(runner, `subagent-status=${status}`);
          release();
          await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.delivered);
          expect(settledOf(id, wait.id)).toMatchObject({ result: { reason: 'settled' }, children: [expect.objectContaining({ status: reads })] });
          expect(wakeInputs(id, wait.id)).toHaveLength(1);
          expect(wakes(id)).toBe(0);
        });
      }

      cell('U35', async () => {
        const { id, wait, release } = await parkedOnSubagents(runner, 'subagent-duplicate');
        const grace = graceClock();
        release();
        await until(() => grace.pending > 0);
        await grace.advance(200);
        await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.delivered && store.getRun(id)?.status === RUN_STATUS.waiting);
        // The wake turn read the whole stream, the second notification included: it armed no
        // second grace, and past one no second wake goes.
        expect(grace.captured).toBe(1);
        await grace.advance(200);
        const subagentWaits = [...store.getRun(id)?.waits ?? [], ...store.getRun(id)?.lastWaits ?? []].filter(entry => entry.kind === WAIT_KIND.subagent);
        expect(subagentWaits.map(entry => entry.id)).toEqual([wait.id]);
        expect(wakes(id)).toBe(0);
      });

      cell('U37', async () => {
        const { id, wait } = await parkedOnSubagents(runner);
        await restart();
        await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.delivered);
        expect(settledOf(id, wait.id)).toMatchObject({ result: { reason: 'interrupted' } });
        expect(wakeInputs(id, wait.id).map(input => input.text)).toEqual([expect.stringContaining(`${productName('Cezar')} restarted, and the 1 native subagent still running`)]);
        expect(wakes(id)).toBe(0);
      });
    });

    describe(`the native subagent deadline on the ${runner} wire (hearsay-tools/cezarion#2431)`, { timeout: 60_000 }, () => {
      useWorkerWaitFixture({ subagentGraceMs: 200, subagentDeadlineMs: 1_500 });
      const exempt = exemptionOf('U36', runner);
      if (exempt) { it(`${runner} is exempt from U36 — ${exempt.reason}`, () => { expect(exempt.reason.trim()).not.toBe(''); }); return; }
      it(`${runner} U36 ${SUBAGENT_CRITERIA.find(entry => entry.id === 'U36')!.name}`, async () => {
        const { id, wait } = await parkedOnSubagents(runner);
        await until(() => settledOf(id, wait.id)?.phase === WAIT_PHASE.delivered);
        expect(settledOf(id, wait.id)).toMatchObject({ result: { reason: 'timeout' } });
        expect(wakes(id)).toBe(1);
        expect(wakes(id)).toBeLessThan(MAX_AUTO_CONTINUES);
      });
    });
  }
}

/** The guard, run once: every runner has its file, and each exemption is a runner with no scenario. */
export function subagentGuard(file: (runner: RunnerId) => string): void {
  describe('native subagent cells (hearsay-tools/cezarion#2431)', () => {
    it('runs every runner\'s subagent cells from its own file', () => {
      for (const runner of RUNNER_IDS) expect(existsSync(new URL(`./${file(runner)}`, import.meta.url)), file(runner)).toBe(true);
    });
    it('exempts a runner from every row exactly when its wire reports no subagents to wait on', () => {
      for (const runner of RUNNER_IDS) {
        const exemptAll = SUBAGENT_CRITERIA.every(({ id }) => exemptionOf(id, runner));
        expect({ runner, scenario: SCENARIO[runner] !== undefined, reports: reportsNativeSubagents(runner) })
          .toEqual({ runner, scenario: !exemptAll, reports: !exemptAll });
      }
      for (const entry of SUBAGENT_EXEMPTIONS) expect(exemptionReasonProblem(entry.reason), `${entry.criterion}/${entry.runner}`).toBeUndefined();
    });
  });
}
