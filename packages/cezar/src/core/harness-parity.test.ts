/**
 * Harness parity — the session and lifecycle matrix.
 *
 * `ui-parity.test.ts` asserts the other axis of the same requirement: that every
 * mapper emits every v2 UI capability, so the GUI degrades per-capability rather
 * than per-backend. This file asserts the rest of the contract in
 * `agent-runner.ts` — session lifecycle, provider-failure surfacing,
 * `sendMessage`, ask routing and park declarations — over the same backends.
 *
 * Spec: `.ai/specs/2026-09-04-harness-parity-matrix.md` (#68). Nine fixes
 * (#2, #3, #4, #5, #6, #46, #48, #53, #54) each repaired a failure mode on one
 * backend that no shared contract covered; every criterion here traces to one of
 * those groups, named in its comment.
 *
 * Two tiers. The seam tier drives each real runner class against that backend's
 * own offline mock. The run tier drives a real `RunManager`, because
 * `ask.requested` comes from the RUNNER for codex and opencode and from
 * `workflows/run.ts` for claude and pi — groups 1, 3 and 6 are only uniform
 * above the seam.
 */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentInputEventSchema, type AgentInput } from '@open-mercato/cezar-contract';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import {
  AGENT_RUN_SPEC_FIELDS,
  RUNNER_IDS,
  type AgentEvent,
  type AgentRunSpec,
  type AgentRunSpecField,
  type ContentBlock,
  type RunnerId,
} from './agent-runner.ts';
import { createRunner } from './runner-factory.ts';
import { appendTurnText } from '../workflows/run.ts';
import { supportsProfiles } from './agent-profiles.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { workerWorkflowHash, type WorkerAccountBinding, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import {
  withOwnedInputRun,
  promptFor,
  driveRun,
  driveSeam,
  lastIndexWhere,
  textEvents,
  exemptionFor,
  HARNESS_ADAPTERS,
  PARITY_EXEMPTIONS,
  PINNED_SESSION_ID,
  type RunObservation,
  type ScenarioName,
  type SeamObservation,
  waitFor,
} from './harness-parity.testkit.ts';

/** One row of the matrix, named once and applied to every harness. */
interface SeamCriterion {
  /** Stable id the exemption table references. */
  readonly id: string;
  readonly name: string;
  readonly scenario: ScenarioName;
  /** Throws when the backend does not satisfy the criterion. */
  readonly assert: (obs: SeamObservation) => void;
}

const sessionEvents = (v1: readonly AgentEvent[]) =>
  v1.filter((e): e is Extract<AgentEvent, { type: 'session' }> => e.type === 'session');

const SEAM_CRITERIA: readonly SeamCriterion[] = [
  {
    // Group 7 — the baseline AgentSession contract, never asserted uniformly.
    id: 'S1',
    name: 'S1 terminates with exactly one v1 done, and it is the last event',
    scenario: 'baseline',
    assert: ({ v1 }) => {
      expect(v1.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(v1.at(-1)?.type).toBe('done');
    },
  },
  {
    // Group 2 / #4 — the OpenCode five-minute cut. The runner used to end the
    // turn from its transport's own response, so undici's 300s headers timeout
    // killed a healthy long turn and cezar parked the run. `hold` acknowledges
    // the prompt, THEN waits before emitting content and its terminal signal:
    // a runner that still derives turn-end from the ack reports it before the
    // content it is supposed to close over.
    id: 'S2',
    name: 'S2 ends the turn on its own terminal signal, after the last content event',
    scenario: 'hold',
    assert: ({ v1, v2 }) => {
      const lastContent = Math.max(
        lastIndexWhere(v1, (e) => e.type === 'text'),
        lastIndexWhere(v1, (e) => e.type === 'tool-result'),
      );
      expect(lastContent).toBeGreaterThanOrEqual(0);
      expect(v1.findIndex((e) => e.type === 'turn-end')).toBeGreaterThan(lastContent);
      expect(v2.filter((e) => e.type === 'turn.completed')).toHaveLength(1);
    },
  },
  {
    // Groups 5 and 6 / #2, #3 — one row on purpose. The damage was never split
    // text as such: a cezar marker assembled across deltas stopped matching its
    // anchored regex, because `appendTurnText` joins v1 `text` events with a
    // newline. So `CEZ:` + `MONITORING` as two events becomes `CEZ:\nMONITORING`
    // and the run parks as "needs you" instead of monitoring.
    //
    // Each mock streams the strongest split its own wire permits: codex, opencode
    // and pi split INSIDE the marker (deltas, growing snapshots, tokens), which
    // only a coalescer can reassemble; claude's stream-json has no deltas, so it
    // sends the marker as its own whole assistant block — the multi-block reply
    // that has to park correctly all the same.
    id: 'S8',
    name: 'S8 assembles split assistant text so a trailing marker still anchors',
    scenario: 'split-text',
    assert: ({ v1 }) => {
      const texts = textEvents(v1);
      // No single event may carry a TORN marker: that is the #2 defect exactly,
      // and it survives the assembled-text check below when a stray later event
      // happens to end the turn with an intact copy.
      for (const text of texts) {
        if (text.includes('CEZ:')) expect(text).toContain('CEZ:MONITORING');
      }
      const assembled = texts.reduce((acc, text) => appendTurnText(acc, text), '');
      expect(assembled).toContain('parity split text');
      // The exact test `workflows/run.ts` applies to decide a monitoring park.
      expect(assembled.trimEnd()).toMatch(/CEZ:MONITORING$/);
    },
  },
  {
    // Group 1 / #53, #54 — a runtime provider rejection used to look like a
    // clean finish, so the orchestrator parked the run as "Needs You" and the
    // user waited on an agent that was never coming back. The rejection has to
    // reach BOTH streams: v1 `error` is what fails the run, v2 `session.error`
    // is what the cockpit renders.
    id: 'S7',
    name: 'S7 surfaces a provider failure as an error on both streams',
    scenario: 'provider-error',
    assert: ({ v1, v2 }) => {
      const errors = v1.filter(
        (e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error',
      );
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]?.message.trim() ?? '').not.toBe('');
      // v2 must signal it too, but the CHANNEL is legitimately per-wire:
      // opencode and pi have a session-level error frame, codex reports a
      // failed turn, and claude only has the result envelope's stop reason.
      // What is uniform — and what #53/#54 were — is that v2 never reports the
      // rejection as a clean end of turn.
      expect(
        v2.some(
          (e) =>
            e.type === 'session.error' ||
            (e.type === 'turn.completed' && e.stopReason === 'error'),
        ),
      ).toBe(true);
      expect(v2.some((e) => e.type === 'turn.completed' && e.stopReason === 'end_turn')).toBe(
        false,
      );
    },
  },
  {
    // Group 4 / #5, #600 — a spawned sub-agent runs in its own child session
    // that emits a full lifecycle over the shared connection. Its terminal
    // signal used to end the PARENT turn, so the parent's remaining work was
    // attributed to a turn cezar had already closed.
    id: 'S9',
    name: 'S9 keeps the parent turn open past a child session terminal signal',
    scenario: 'subagent',
    assert: ({ v1, v2, result }) => {
      // #149: child text stays nested on v2 and never contaminates parent text,
      // including AgentRunResult's fallback buffer and unfinished child deltas.
      const texts = v1.filter((e) => e.type === 'text').map((e) => e.text);
      expect(texts).toHaveLength(1);
      expect(texts[0]).toMatch(/CEZ:MONITORING\s*$/);
      expect(result.text).toBe(texts[0]);
      expect(v2.some((e) => e.type === 'item.completed' && e.item.kind === 'message'
        && e.item.text === 'Child review finished.' && !!e.item.parentItemId)).toBe(true);
      expect(v1.filter((e) => e.type === 'turn-end')).toHaveLength(1);
      const lastText = lastIndexWhere(v1, (e) => e.type === 'text');
      expect(lastText).toBeGreaterThanOrEqual(0);
      // The parent's own trailing text has to land BEFORE its turn-end. Under
      // #600 the child's completion closed the turn first, so it did not.
      expect(v1.findIndex((e) => e.type === 'turn-end')).toBeGreaterThan(lastText);
    },
  },
  {
    // Group 7 — `resumeCommand()` and "open in CLI" need a session id after
    // every run. The two wires differ and both are legitimate: codex, opencode
    // and pi mint their own and echo a v1 `session` event, while claude pins
    // the id cezar supplied (`--session-id`, claude-cli-runner.ts:385) and
    // returns it on the result. What must never happen is neither — that is a
    // run nobody can resume.
    id: 'S3',
    name: 'S3 yields a resumable session id at the seam',
    scenario: 'baseline',
    assert: ({ v1, result }) => {
      const reported = sessionEvents(v1)[0]?.sessionId ?? result.sessionId;
      expect(reported ?? '').not.toBe('');
    },
  },
  {
    // Group 7 — usage telemetry on both streams, not one.
    id: 'S4',
    name: 'S4 reports token usage on both streams',
    scenario: 'baseline',
    assert: ({ v1, v2 }) => {
      expect(v1.some((e) => e.type === 'token-usage' && e.tokensUsed > 0)).toBe(true);
      expect(v2.some((e) => e.type === 'usage.updated')).toBe(true);
    },
  },
  {
    // Group 7 — the pid roots the run's process tree for resource telemetry (#348).
    id: 'S10',
    name: 'S10 exposes the spawned process pid',
    scenario: 'baseline',
    assert: ({ pid }) => {
      expect(typeof pid).toBe('number');
    },
  },
];

/** One row of the run tier. `settled` says when the run has reached the state
 *  the row is about, so a row waits for its own condition rather than a sleep. */
interface RunCriterion {
  readonly id: string;
  readonly name: string;
  readonly scenario: ScenarioName;
  readonly settled: (record: RunObservation['record']) => boolean;
  readonly assert: (obs: RunObservation) => void;
}

const TERMINAL: readonly string[] = ['review', 'done', 'failed', 'cancelled'];

const askEvents = (obs: RunObservation) =>
  obs.events.filter((e) => e.type === 'ask.requested');

const RUN_CRITERIA: readonly RunCriterion[] = [
  {
    // Group 7 — a run whose agent DECLARED completion reaches cezar's review
    // gate, which is a non-attention terminal state (cezar never auto-merges).
    // The scenario has to declare it: a markerless turn-end parks as `waiting`
    // on every backend, and that is correct behaviour, not a defect.
    id: 'R1',
    name: 'R1 takes a declared-complete run to its review gate',
    scenario: 'done',
    settled: (record) => TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(['review', 'done']).toContain(obs.record?.status);
      expect(obs.statuses).not.toContain('waiting');
    },
  },
  {
    // Group 1 / #53, #54 — the row that would have caught both on whichever
    // backend shipped the bug second. `statuses` rather than the final status:
    // the defect was a park, and a run that parked and later failed anyway is
    // still the bug the user saw.
    id: 'R2',
    name: 'R2 fails the run on a provider failure instead of parking it as Needs You',
    scenario: 'provider-error',
    // `waiting` settles too, so the defect fails on the assertion below rather
    // than as an opaque timeout: a parked run is the bug, not a slow one.
    settled: (record) => TERMINAL.includes(record?.status ?? '') || record?.status === 'waiting',
    assert: (obs) => {
      expect(obs.record?.status).toBe('failed');
      expect(obs.statuses).not.toContain('waiting');
    },
  },
  {
    // Group 3 / #6, #473 — an ask has to reach the cockpit as exactly one card
    // and park the run for the user. The two wires differ underneath: codex and
    // opencode have a native question tool their runners map, claude and pi go
    // through the `CEZ:ASK` marker in `workflows/run.ts`. Above the seam that
    // difference must be invisible.
    id: 'R3',
    name: 'R3 parks as waiting and emits exactly one ask card',
    scenario: 'ask',
    settled: (record) => record?.status === 'waiting' || TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(obs.record?.status).toBe('waiting');
      expect(askEvents(obs)).toHaveLength(1);
    },
  },
  {
    // Group 3 — the other half, and the one that hangs a run when it is wrong:
    // a malformed ask must render no card AND still end its turn. A backend
    // that waits forever for an answer to a question nobody can see is the
    // failure this pins; `settled` returning is itself part of the assertion.
    id: 'R4',
    name: 'R4 renders no card for a malformed ask and still ends the turn',
    scenario: 'ask-bad',
    settled: (record) => record?.status === 'waiting' || TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(askEvents(obs)).toEqual([]);
      expect([...TERMINAL, 'waiting']).toContain(obs.record?.status);
    },
  },
  {
    // Group 6 / #48 — a declared park is a non-attention state. The same
    // scenario S8 asserts survives the seam: the cause below, the effect here.
    id: 'R5',
    name: 'R5 parks a declared monitoring turn as running/monitoring, not waiting',
    scenario: 'split-text',
    settled: (record) => record?.activity === 'monitoring' || record?.status === 'waiting',
    assert: (obs) => {
      expect(obs.record?.activity).toBe('monitoring');
      expect(obs.record?.status).toBe('running');
      expect(obs.statuses).not.toContain('waiting');
    },
  },
  {
    // #149: the child message lands before the parent's turn-end, after its marker.
    id: 'R12',
    name: 'R12 keeps monitoring parked when child text follows the parent marker',
    scenario: 'subagent',
    settled: (record) => record?.activity === 'monitoring' || record?.status === 'waiting',
    assert: (obs) => {
      expect(obs.record?.activity).toBe('monitoring');
      expect(obs.record?.status).toBe('running');
      expect(obs.statuses).not.toContain('waiting');
    },
  },
];

/** Criteria driven through `whileOpen` rather than one settled observation. */
const CONTROL_CRITERIA = [
  { id: 'D1', scenario: 'baseline' },
  { id: 'S5', scenario: 'baseline' },
  { id: 'S6', scenario: 'baseline' },
  { id: 'S11', scenario: 'ask' },
  { id: 'S12', scenario: 'hold' },
  { id: 'S13', scenario: 'hold' },
  { id: 'R6', scenario: 'ask' },
  { id: 'R7', scenario: 'ask' },
  { id: 'R8', scenario: 'hold' },
  { id: 'R9', scenario: 'ask-reply-late' },
  { id: 'R10', scenario: 'done' },
  { id: 'R11', scenario: 'baseline' },
] as const;

/**
 * Register one cell. An exempt cell still produces a named test that fails the
 * day the backend gains the thing — see `ExemptionKind` for the two ways that
 * is pinned. Never relax an assertion to accommodate an exemption; delete the
 * exemption instead.
 */
function parityRow(
  backend: RunnerId,
  criterion: SeamCriterion,
  observe: () => Promise<SeamObservation>,
): void {
  const exempt = exemptionFor(criterion.id, backend);
  if (!exempt) {
    it(
      `${backend} ${criterion.name}`,
      async () => {
        criterion.assert(await observe());
      },
      45_000,
    );
    return;
  }
  if (exempt.kind === 'scenario-unconstructible') {
    it(`${backend} is exempt from ${criterion.id} — ${exempt.reason}`, () => {
      // The pin: no prompt is declared, so nothing can drive this row here. Add
      // one and this fails, which is the signal to make the row live.
      expect(HARNESS_ADAPTERS[backend].scenarios[criterion.scenario]).toBeUndefined();
    });
    return;
  }
  it(
    `${backend} is exempt from ${criterion.id} — ${exempt.reason}`,
    async () => {
      const obs = await observe();
      expect(() => criterion.assert(obs)).toThrow();
    },
    45_000,
  );
}

describe('harness parity — seam tier', () => {
  for (const backend of RUNNER_IDS) {
    for (const criterion of SEAM_CRITERIA) {
      parityRow(backend, criterion, () => driveSeam(backend, criterion.scenario));
    }
  }
});

describe('harness parity — seam tier, session control', () => {
  for (const backend of RUNNER_IDS) {
    it(`${backend} S13 auto-end checks a late hold at execution and resumes after the next admitted turn`, async () => {
      let hold = false; let checks = 0;
      await driveSeam(backend, 'hold', {
        sessionOptions: { autoEndAfterFirstTurn: true, shouldAutoEnd: () => { checks++; return !hold; } },
        whileOpen: async (session, { v1 }) => {
          await waitFor(() => v1.some(e => e.type === 'turn-end'));
          // The runner has already armed its timer. The new wait must still veto it.
          hold = true;
          await new Promise(resolve => setTimeout(resolve, 400));
          expect(checks).toBeGreaterThan(0); expect(session.open).toBe(true);
          hold = false;
          await expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo admitted wake' }])).resolves.toBeUndefined();
          await waitFor(() => v1.filter(e => e.type === 'turn-end').length >= 2);
          await session.result;
          expect(session.open).toBe(false); expect(checks).toBeGreaterThan(1);
        },
      });
    }, 45_000);

    it(`${backend} S11 non-human input cannot answer a native or marker ask`, async () => {
      await driveSeam(backend, 'ask', {
        whileOpen: async (session, { v1, v2 }) => {
          await waitFor(() => v2.some(e => e.type === 'ask.requested') || v1.some(e => e.type === 'turn-end'));
          const ends = v1.filter(e => e.type === 'turn-end').length;
          expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo agent steering' }])).toBe(false);
          await new Promise(resolve => setTimeout(resolve, 150));
          expect(v1.filter(e => e.type === 'turn-end')).toHaveLength(ends);
          expect(textEvents(v1).join('\n')).not.toContain('agent steering');
          expect(session.sendMessage([{ type: 'text', text: 'Vitest' }])).toBe(true);
          await waitFor(() => v1.filter(e => e.type === 'turn-end').length > ends);
          await expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo agent steering' }])).resolves.toBeUndefined();
          await waitFor(() => textEvents(v1).some(text => text.includes('agent steering')));
        },
      });
    }, 45_000);

    it(`${backend} S12 non-human input refuses an unsafe turn and can retry at its boundary`, async () => {
      await driveSeam(backend, 'hold', {
        whileOpen: async (session, { v1 }) => {
          expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo retried steering' }])).toBe(false);
          await waitFor(() => v1.some(e => e.type === 'turn-end'));
          await expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo retried steering' }])).resolves.toBeUndefined();
          await waitFor(() => textEvents(v1).some(text => text.includes('retried steering')));
          session.end();
          expect(session.sendAgentMessage([{ type: 'text', text: 'closed' }])).toBe(false);
        },
      });
    }, 45_000);

    // Group 7 — mid-task follow-ups are the whole reason a session outlives a turn.
    it(
      `${backend} S5 accepts a follow-up message and completes a second turn`,
      async () => {
        const obs = await driveSeam(backend, 'baseline', {
          whileOpen: async (session, { v1 }) => {
            await waitFor(() => v1.some((e) => e.type === 'turn-end'));
            expect(session.open).toBe(true);
            expect(session.sendMessage([{ type: 'text', text: 'now the second turn' }])).toBe(true);
            await waitFor(() => v1.filter((e) => e.type === 'turn-end').length >= 2);
          },
        });
        expect(obs.v1.filter((e) => e.type === 'turn-end').length).toBeGreaterThanOrEqual(2);
      },
      45_000,
    );

    // Group 7 / #703 — a teardown cezar asked for is never an agent failure.
    it(
      `${backend} S6 settles result on interrupt without reporting an agent error`,
      async () => {
        const obs = await driveSeam(backend, 'baseline', {
          whileOpen: async (session, { v1 }) => {
            await waitFor(() => v1.some((e) => e.type === 'text'));
            session.interrupt();
          },
        });
        expect(obs.v1.some((e) => e.type === 'error')).toBe(false);
        expect(obs.v2.some((e) => e.type === 'turn.completed' && e.stopReason === 'error')).toBe(
          false,
        );
      },
      45_000,
    );
  }
});

describe('harness parity — run tier', () => {
  for (const backend of RUNNER_IDS) {
    for (const criterion of RUN_CRITERIA) {
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
          const obs = await driveRun(backend, criterion.scenario, criterion.settled);
          if (exempt) expect(() => criterion.assert(obs)).toThrow();
          else criterion.assert(obs);
        },
        60_000,
      );
    }
  }
});

const agentInput = (parentRunId: string, text = '/owned-skill mock:agent-echo parent steering'): AgentInput => ({
  id: randomUUID(), source: 'agent', parentRunId, text, createdAt: new Date().toISOString(),
});

describe('harness parity — owned input run tier', () => {
  for (const backend of RUNNER_IDS) {
    it(`${backend} R6 queues before/during asks and drains only after a human answer`, async () => {
      await withOwnedInputRun(backend, 'ask', async ({ store, manager, repoRoot, runId, parentRunId }) => {
        // A real registry entry must NOT expand agent-originated slash text.
        const skills = join(repoRoot, '.ai/cezar/skills');
        mkdirSync(skills, { recursive: true });
        writeFileSync(join(skills, 'owned-skill.md'), '---\nname: owned-skill\n---\nEXPANDED HUMAN SKILL');
        const first = agentInput(parentRunId);
        const second = agentInput(parentRunId, 'mock:agent-echo second steering');
        expect(manager.steerWorker(runId, first)).toBe('queued');
        expect(store.getRun(runId)?.agentInputs).toEqual([first]);
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'ask.requested'));
        expect(manager.steerWorker(runId, second)).toBe('queued');
        await new Promise(resolve => setTimeout(resolve, 150));
        expect(store.getRun(runId)?.status).toBe('waiting');
        expect(store.getRun(runId)?.agentInputs?.every(input => !input.deliveredAt)).toBe(true);
        expect(store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
        const attributed = store.readEvents(runId).filter(e => e.type === 'agent-input').map(e => agentInputEventSchema.parse(e).input);
        expect(attributed).toEqual([first, second]);
        expect(manager.sendMessage(runId, [{ type: 'text', text: 'Vitest' }])).toBe(true);
        await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('second steering')));
        const texts = store.readEvents(runId).filter(e => e.type === 'text').map(e => e.text).join('\n');
        expect(texts).toContain(first.text);
        expect(texts).not.toContain('EXPANDED HUMAN SKILL');
        expect(store.readEvents(runId).filter(e => e.type === 'user-message').map(e => e.text)).toEqual(['Vitest']);
        expect((manager as unknown as { hasPendingHumanAsk(id: string): boolean }).hasPendingHumanAsk(runId)).toBe(false);
        expect(store.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toHaveLength(1);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        const afterAsk = agentInput(parentRunId, 'mock:agent-echo after ask');
        expect(manager.steerWorker(runId, afterAsk)).toBe('queued');
        await waitFor(() => !!store.getRun(runId)?.agentInputs?.find(input => input.id === afterAsk.id)?.deliveredAt);
      });
    }, 60_000);

    it(`${backend} R7 restart retains pending asks and input; only explicit-answer Continue drains it`, async () => {
      await withOwnedInputRun(backend, 'ask', async fixture => {
        const { runId, parentRunId } = fixture;
        fixture.manager.enqueueOwnedRun(runId);
        await waitFor(() => fixture.store.readEvents(runId).some(e => e.type === 'ask.requested'));
        const input = agentInput(parentRunId);
        expect(fixture.manager.steerWorker(runId, input)).toBe('queued');
        const { store, manager } = await fixture.restart();
        expect(store.getRun(runId)?.status).toBe('waiting');
        expect(store.getRun(runId)?.agentInputs).toEqual([input]);
        expect(manager.continueRun(runId).ok).toBe(false);
        expect(store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
        expect(manager.continueRun(runId, { text: 'Vitest' }).ok).toBe(true);
        await waitFor(() => store.getRun(runId)?.agentInputs?.[0]?.deliveredAt !== undefined);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('parent steering')));
        expect(store.readEvents(runId).filter(e => e.type === 'user-message').map(e => e.text)).toEqual(['Vitest']);
      });
    }, 60_000);

    it(`${backend} refused human delivery retains the ask live and after restart`, async () => {
      await withOwnedInputRun(backend, 'ask', async fixture => {
        const { manager, store, runId, parentRunId } = fixture;
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'ask.requested'));
        const internal = manager as unknown as {
          active: Map<string, { pendingHumanAsk: boolean; session: import('./agent-runner.ts').AgentSession }>;
          hasPendingHumanAsk(id: string): boolean;
        };
        const state = internal.active.get(runId)!;
        const refuse = vi.spyOn(state.session, 'sendMessage').mockReturnValueOnce(false);
        expect(manager.sendMessage(runId, [{ type: 'text', text: 'refused answer' }])).toBe(false);
        refuse.mockRestore();
        expect(state.pendingHumanAsk).toBe(true);
        expect(store.readEvents(runId).filter(e => e.type === 'human-input-delivered')).toEqual([]);
        expect(internal.hasPendingHumanAsk(runId)).toBe(true);
        const input = agentInput(parentRunId);
        expect(manager.steerWorker(runId, input)).toBe('queued');
        const recovered = await fixture.restart();
        expect(recovered.store.getRun(runId)?.status).toBe('waiting');
        expect(recovered.store.getRun(runId)?.agentInputs).toEqual([input]);
        expect(recovered.manager.continueRun(runId).ok).toBe(false);
        expect(recovered.store.readEvents(runId).filter(e => e.type === 'user-message').map(e => e.text))
          .toEqual(['refused answer']);
        expect(recovered.manager.continueRun(runId, { text: 'Vitest' }).ok).toBe(true);
        await waitFor(() => !!recovered.store.getRun(runId)?.agentInputs?.[0]?.deliveredAt);
        const replay = recovered.manager as unknown as { hasPendingHumanAsk(id: string): boolean };
        expect(replay.hasPendingHumanAsk(runId)).toBe(false);
      });
    }, 60_000);

    it(`${backend} R10 accepted input precedes DONE but explicit termination is never prolonged`, async () => {
      for (const stop of ['finish', 'cancel', 'destroy'] as const) {
        await withOwnedInputRun(backend, 'done', async ({ store, manager, runId, parentRunId }) => {
          const accepted = agentInput(parentRunId, 'mock:hold');
          expect(manager.steerWorker(runId, accepted)).toBe('queued');
          manager.enqueueOwnedRun(runId);
          await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.deliveredAt);
          const pending = agentInput(parentRunId);
          expect(manager.steerWorker(runId, pending)).toBe('queued');
          if (stop === 'destroy') {
            const delegation = store.getRun(runId)!.delegation!;
            if (delegation.role !== 'worker') throw new Error('expected worker');
            store.commitDelegation([{ id: runId, delegation: { ...delegation,
              destroy: { requestedAt: new Date().toISOString(), phase: 'requested', remaining: ['process', 'worktree', 'branch'] },
            } }]);
            expect(() => manager.steerWorker(runId, agentInput(parentRunId))).toThrow(/state/i);
          }
          if (stop === 'cancel') manager.cancel(runId);
          else manager.finish(runId);
          await waitFor(() => !manager.isActive(runId));
          expect(store.getRun(runId)?.agentInputs?.[1]).toEqual(pending);
          expect(['review', 'done', 'cancelled']).toContain(store.getRun(runId)?.status);
          expect(store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
        });
      }
    }, 60_000);

    it(`${backend} R13 runs a persisted catalog chain inside the owned worker, check step included (#451)`, async () => {
      const workflowDef = { name: 'review', source: 'file' as const, path: '.ai/cezar/workflows/review.yaml', steps: [
        { id: 'inspect', name: 'Inspect', prompt: '{{task}}', runner: backend },
        // Runs in the worker's own worktree, never the parent checkout.
        { id: 'verify', command: 'test -f a.txt && test "$(git rev-parse --show-toplevel)" = "$PWD" && printf %s "$PWD" > "$CEZ_PARITY_CWD"' },
      ] };
      await withOwnedInputRun(backend, 'done', async ({ store, manager, repoRoot, runId }) => {
        const cwdFile = join(repoRoot, 'check-cwd.txt');
        process.env.CEZ_PARITY_CWD = cwdFile;
        try {
          manager.enqueueOwnedRun(runId);
          await waitFor(() => !manager.isActive(runId), 30_000);
        } finally { delete process.env.CEZ_PARITY_CWD; }
        const run = store.getRun(runId)!;
        expect(run.error).toBeUndefined();
        expect(run.steps.map(step => ({ id: step.id, kind: step.kind, status: step.status }))).toEqual([
          { id: 'inspect', kind: 'agent', status: 'done' }, { id: 'verify', kind: 'check', status: 'done' },
        ]);
        expect(store.readEvents(runId).filter(e => e.type === 'check-output')).toMatchObject([{ stepId: 'verify', exitCode: 0 }]);
        if (run.delegation?.role !== 'worker') throw new Error('expected worker');
        expect(readFileSync(cwdFile, 'utf8')).toBe(run.delegation.workspace.path);
      }, { workflowDef });
    }, 60_000);

    it(`${backend} R14 runs an accepted mixed-runner chain under per-step identity, each step on its own pinned account (#452)`, async () => {
      const other = RUNNER_IDS[(RUNNER_IDS.indexOf(backend) + 1) % RUNNER_IDS.length]!;
      const homes = realpathSync(mkdtempSync(join(tmpdir(), 'cez-parity-accounts-')));
      // What acceptance captures for a default account: a relocated home for the providers that
      // have one (never the developer's real login), a bare provider marker for the rest.
      const binding = (provider: RunnerId): WorkerAccountBinding => {
        if (!supportsProfiles(provider)) return { provider, profileId: 'default' };
        const homePath = join(homes, provider); mkdirSync(homePath, { recursive: true });
        return { provider, profileId: 'default', homePath, ...(provider === 'claude' ? { claudeLayout: { kind: 'relocated' } } : {}) };
      };
      const workflowDef: WorkflowDef = { name: 'mixed', source: 'file', path: '.ai/cezar/workflows/mixed.yaml', steps: [
        { id: 'first', prompt: promptFor(backend, 'done'), runner: backend, agentProfile: 'default' },
        { id: 'second', prompt: promptFor(other, 'done'), runner: other, agentProfile: 'default' },
      ] };
      const identity: WorkerExecutionIdentity = { kind: 'accepted', account: binding(backend), grants: {}, workflowHash: workerWorkflowHash(workflowDef), steps: [
        { stepId: 'first', account: binding(backend), grants: {} }, { stepId: 'second', account: binding(other), grants: {} },
      ] };
      try {
        await withOwnedInputRun(backend, 'done', async ({ store, manager, runId }) => {
          manager.enqueueOwnedRun(runId);
          await waitFor(() => !manager.isActive(runId), 30_000);
          const run = store.getRun(runId)!;
          expect(run.error).toBeUndefined();
          // Each step launched on ITS runner under ITS pinned account; the run-level runner is the first step's.
          expect(run.steps.map(step => ({ id: step.id, status: step.status, backend: step.backend, profileId: step.profileId }))).toEqual([
            { id: 'first', status: 'done', backend, profileId: 'default' }, { id: 'second', status: 'done', backend: other, profileId: 'default' },
          ]);
          expect(run.runner).toBe(backend);
        }, { workflowDef, identity, agentProfile: 'default', extraBackends: [other] });
      } finally { rmSync(homes, { recursive: true, force: true }); }
    }, 60_000);

    it(`${backend} R11 post-send checkpoint failure interrupts and reports failure without dropping input`, async () => {
      await withOwnedInputRun(backend, 'baseline', async ({ store, manager, repoRoot, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        store.flush();
        const tmp = join(repoRoot, '.ai/cezar/runs.json.tmp');
        const failAfterEnqueue = ({ event }: { event: { type: string } }) => {
          if (event.type === 'agent-input') mkdirSync(tmp);
        };
        store.on('event', failAfterEnqueue);
        const input = agentInput(parentRunId, 'mock:hold');
        try {
          expect(manager.steerWorker(runId, input)).toBe('queued');
          await waitFor(() => store.readEvents(runId).some(event => event.type === 'error' && String(event.message).includes('agent input delivery checkpoint failed')));
          expect(store.getRun(runId)?.agentInputs).toEqual([input]);
        } finally {
          store.off('event', failAfterEnqueue);
          rmSync(tmp, { recursive: true, force: true });
        }
        await waitFor(() => !manager.isActive(runId));
        expect(store.getRun(runId)?.status).toBe('failed');
        expect(store.getRun(runId)?.error).toContain('agent input delivery checkpoint failed');
        expect(store.getRun(runId)?.agentInputs).toEqual([input]);
      });
    }, 60_000);

    it(`${backend} R9 continuation asks keep input queued through delayed native reply acknowledgement`, async () => {
      await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, parentRunId }) => {
        manager.enqueueOwnedRun(runId);
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        manager.finish(runId);
        await waitFor(() => !manager.isActive(runId));
        expect(manager.continueRun(runId, { text: promptFor(backend, 'ask-reply-late') }).ok).toBe(true);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'ask.requested'));
        const input = agentInput(parentRunId);
        expect(manager.steerWorker(runId, input)).toBe('queued');
        expect(manager.sendMessage(runId, [{ type: 'text', text: 'Vitest' }])).toBe(true);
        await waitFor(() => store.getRun(runId)?.agentInputs?.[0]?.deliveredAt !== undefined);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes(input.text)));
        expect(store.readEvents(runId).filter(e => e.type === 'user-message').map(e => e.text))
          .toEqual([promptFor(backend, 'ask-reply-late'), 'Vitest']);
      });
    }, 60_000);

    it(`${backend} R8 queued restart/starting inputs persist; disk failure emits and delivers nothing`, async () => {
      await withOwnedInputRun(backend, 'hold', async fixture => {
        const { runId, parentRunId, repoRoot } = fixture;
        fixture.store.flush();
        const tmp = join(repoRoot, '.ai/cezar/runs.json.tmp');
        mkdirSync(tmp);
        try {
          expect(() => fixture.manager.steerWorker(runId, agentInput(parentRunId))).toThrow();
          expect(fixture.store.getRun(runId)?.agentInputs).toBeUndefined();
          expect(fixture.store.readEvents(runId).filter(e => e.type === 'agent-input')).toEqual([]);
        } finally { rmSync(tmp, { recursive: true }); }
        const input = agentInput(parentRunId);
        expect(fixture.manager.steerWorker(runId, input)).toBe('queued');
        const { store, manager } = await fixture.restart();
        const second = agentInput(parentRunId, 'mock:agent-echo during startup');
        expect(manager.steerWorker(runId, second)).toBe('queued');
        await waitFor(() => store.getRun(runId)?.agentInputs?.every(input => !!input.deliveredAt) === true);
        await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes('during startup')));
        expect(store.readEvents(runId).filter(e => e.type === 'user-message')).toEqual([]);
        manager.finish(runId);
        await waitFor(() => !manager.isActive(runId));
        expect(() => manager.steerWorker(runId, agentInput(parentRunId))).toThrow(/state/i);
      });
    }, 60_000);
  }
});

describe('OpenCode durable input acknowledgements', () => {
  it.each(['rejected', 'finished', 'cancelled'] as const)('%s opening answer never checkpoints an unanswered ask', async outcome => {
    await withOwnedInputRun('opencode', 'ask', async fixture => {
      const { runId, parentRunId } = fixture;
      fixture.manager.enqueueOwnedRun(runId);
      await waitFor(() => fixture.store.readEvents(runId).some(e => e.type === 'ask.requested'));
      const input = agentInput(parentRunId);
      expect(fixture.manager.steerWorker(runId, input)).toBe('queued');
      const { store, manager } = await fixture.restart();
      const before = store.readEvents(runId).at(-1)!.seq;
      expect(manager.continueRun(runId, { text: outcome === 'rejected' ? 'mock:reject-agent-post' : 'mock:hold' }).ok).toBe(true);
      if (outcome !== 'rejected') {
        await waitFor(() => store.readEvents(runId).some(e => e.seq > before && e.type === 'turn.started'));
        if (outcome === 'finished') expect(manager.finish(runId)).toBe(true);
        else manager.cancel(runId);
      }
      await waitFor(() => !manager.isActive(runId));
      const events = store.readEvents(runId).filter(e => e.seq > before);
      if (outcome === 'rejected') {
        expect(store.getRun(runId)?.status).toBe('failed');
        expect(events.filter(e => e.type === 'error')).toHaveLength(1);
        expect(events.findIndex(e => e.type === 'error')).toBeLessThan(events.findIndex(e => e.type === 'turn-end'));
      }
      expect(events.filter(e => e.type === 'human-input-delivered')).toEqual([]);
      expect(store.getRun(runId)?.agentInputs).toEqual([input]);
      const recovered = await fixture.restart();
      expect((recovered.manager as unknown as { hasPendingHumanAsk(id: string): boolean }).hasPendingHumanAsk(runId)).toBe(true);
      expect(recovered.manager.continueRun(runId).ok).toBe(false);
      expect(recovered.store.getRun(runId)?.agentInputs).toEqual([input]);
    });
  }, 60_000);

  it.each(['fresh', 'continuation'] as const)('%s late reply acknowledgement plus DONE retries accepted input', async mode => {
    await withOwnedInputRun('opencode', 'baseline', async ({ store, manager, runId, parentRunId }) => {
      const prompt = 'mock:ask-reply-late-done';
      if (mode === 'fresh') store.updateRun(runId, { task: prompt });
      manager.enqueueOwnedRun(runId);
      if (mode === 'continuation') {
        await waitFor(() => store.getRun(runId)?.status === 'waiting');
        manager.finish(runId);
        await waitFor(() => !manager.isActive(runId));
        expect(manager.continueRun(runId, { text: prompt }).ok).toBe(true);
      }
      await waitFor(() => store.readEvents(runId).some(e => e.type === 'ask.requested'));
      const input = agentInput(parentRunId);
      expect(manager.steerWorker(runId, input)).toBe('queued');
      expect(manager.sendMessage(runId, [{ type: 'text', text: 'Vitest' }])).toBe(true);
      await waitFor(() => !!store.getRun(runId)?.agentInputs?.[0]?.deliveredAt);
      await waitFor(() => store.readEvents(runId).some(e => e.type === 'text' && String(e.text).includes(input.text)));
      expect(manager.isActive(runId)).toBe(true);
    });
  }, 60_000);

  it('rejected mid-session human POST remains nonfatal', async () => {
    await withOwnedInputRun('opencode', 'baseline', async ({ store, manager, runId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:reject-agent-post' }])).toBe(true);
      await waitFor(() => store.readEvents(runId).some(e => e.type === 'note' && String(e.message).includes('prompt failed')));
      expect(store.readEvents(runId).filter(e => e.type === 'error')).toEqual([]);
      expect(manager.isActive(runId)).toBe(true);
      manager.finish(runId);
      await waitFor(() => !manager.isActive(runId));
      expect(['done', 'review']).toContain(store.getRun(runId)?.status);
    });
  }, 60_000);

  it.each(['fresh', 'continuation'] as const)('%s rejected agent POST fails without draining more accepted input', async mode => {
    await withOwnedInputRun('opencode', 'baseline', async ({ store, manager, runId, parentRunId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting');
      if (mode === 'continuation') {
        manager.finish(runId);
        await waitFor(() => !manager.isActive(runId));
        expect(manager.continueRun(runId, { text: 'mock:baseline' }).ok).toBe(true);
        await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
      }
      const rejected = agentInput(parentRunId, 'mock:reject-agent-post');
      expect(manager.steerWorker(runId, rejected)).toBe('queued');
      const pending = agentInput(parentRunId);
      expect(manager.steerWorker(runId, pending)).toBe('queued');
      await waitFor(() => store.readEvents(runId).some(e => e.type === 'error'));
      await waitFor(() => !manager.isActive(runId));
      expect(store.getRun(runId)?.status).toBe('failed');
      expect(store.getRun(runId)?.error).toContain('agent input failed');
      expect(store.getRun(runId)?.agentInputs?.[1]).toEqual(pending);
    });
  }, 60_000);
});

describe('harness parity — the matrix itself', () => {
  const allIds = [
    ...SEAM_CRITERIA.map((c) => c.id),
    ...CONTROL_CRITERIA.map((c) => c.id),
    ...RUN_CRITERIA.map((c) => c.id),
  ];
  const scenarioOf = (id: string): ScenarioName => {
    const seam = SEAM_CRITERIA.find((c) => c.id === id);
    if (seam) return seam.scenario;
    const control = CONTROL_CRITERIA.find((c) => c.id === id);
    if (control) return control.scenario;
    const runRow = RUN_CRITERIA.find((c) => c.id === id);
    if (runRow) return runRow.scenario;
    throw new Error(`unknown criterion id "${id}"`);
  };

  // AC #6: a new id in RUNNER_IDS fails here until every row is addressed.
  it('every criterion is a live row or a declared exemption for every runner', () => {
    const missing: string[] = [];
    for (const backend of RUNNER_IDS) {
      for (const id of allIds) {
        const declared = HARNESS_ADAPTERS[backend].scenarios[scenarioOf(id)] !== undefined;
        if (!declared && !exemptionFor(id, backend)) missing.push(`${backend}/${id}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it('every runner id has an adapter', () => {
    for (const backend of RUNNER_IDS) {
      expect(HARNESS_ADAPTERS[backend]?.backend).toBe(backend);
    }
  });

  it('no exemption names a criterion or runner that does not exist', () => {
    for (const exemption of PARITY_EXEMPTIONS) {
      expect(allIds).toContain(exemption.criterion);
      expect(RUNNER_IDS as readonly string[]).toContain(exemption.backend);
      expect(exemption.reason.trim()).not.toBe('');
    }
  });

  it('each exemption kind agrees with whether a scenario prompt is declared', () => {
    for (const exemption of PARITY_EXEMPTIONS) {
      const declared =
        HARNESS_ADAPTERS[exemption.backend].scenarios[scenarioOf(exemption.criterion)] !==
        undefined;
      // A contradictory entry is worse than none: `capability-absent` needs the
      // scenario to be drivable so the inversion means something, and
      // `scenario-unconstructible` claims the opposite.
      expect({ criterion: exemption.criterion, backend: exemption.backend, declared }).toEqual({
        criterion: exemption.criterion,
        backend: exemption.backend,
        declared: exemption.kind === 'capability-absent',
      });
    }
  });

  it('uses no skipped or pending cell — an inapplicable one is a declared exemption', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    expect(source).not.toMatch(/\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(/);
  });
});

// D1: inspect the actual argv/RPC/HTTP boundary of the real runners. Expectations
// come from installed CLI help, generated Codex schemas and OpenCode /doc; see §7.
describe('harness parity — D1 governed native delegation', () => {
  for (const backend of RUNNER_IDS) {
    for (const resume of [false, true]) {
      it(`${backend} restricts verified native delegation on ${resume ? 'Continue' : 'start'} without widening ordinary settings`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-native-wire-'));
        try {
          const launches = [];
          for (const restricted of [false, true]) {
            const path = join(dir, `${restricted}.ndjson`);
            const obs = await driveSeam(backend, 'baseline', { spec: {
              cwd: dir, resume, allowedTools: ['Read', 'Bash'], bashAllowlist: ['git status'],
              systemPrompt: 'Use cezar workers. Native workers are not tracked by cezar.',
              ...(restricted ? { restrictNativeDelegation: true } : {}),
              env: { CEZ_MOCK_ARGS_FILE: path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' },
            } });
            expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
            expect(obs.v1.at(-1)?.type).toBe('done');
            launches.push(readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line)));
          }
          const [ordinary, restricted] = launches;
          if (backend === 'claude' || backend === 'pi') {
            const flag = backend === 'claude' ? '--disallowedTools' : '--exclude-tools';
            const names = backend === 'claude' ? 'Agent,Task' : 'subagent';
            const args = restricted![0] as string[];
            const index = args.indexOf(flag);
            expect(index).toBeGreaterThanOrEqual(0);
            expect(args[index + 1]).toBe(names);
            expect(args.filter((_, i) => i !== index && i !== index + 1)).toEqual(ordinary![0]);
            // Pi has no native delegate primitive: arbitrary custom extension names
            // cannot be discovered as delegation. Preserve unrelated tools/extensions.
            if (backend === 'pi') expect(args).not.toContain('--no-extensions');
          } else if (backend === 'codex') {
            const normal = ordinary!.find(row => row.method === (resume ? 'thread/resume' : 'thread/start'));
            const controlled = restricted!.find(row => row.method === (resume ? 'thread/resume' : 'thread/start'));
            expect(controlled.params.config).toEqual({ 'features.multi_agent': false, 'features.multi_agent_v2': false });
            const { config: _config, ...rest } = controlled.params;
            expect(rest).toEqual(normal.params);
            expect(normal.params).not.toHaveProperty('config');
          } else if (backend === 'cursor') {
            const normal = ordinary!.find(row => row.method === 'initialize');
            const controlled = restricted!.find(row => row.method === 'initialize');
            expect(normal.params.clientCapabilities._meta.subagents).toBe(true);
            expect(controlled.params.clientCapabilities._meta.subagents).toBe(false);
            const normalize = (rows: typeof ordinary) => rows!.filter(row => row.method !== 'initialize');
            expect(normalize(restricted)).toEqual(normalize(ordinary));
          } else {
            const normal = ordinary!.find(row => row.method === 'POST' && row.url === '/session');
            const controlled = restricted!.find(row => row.method === 'POST' && row.url === '/session');
            expect(controlled.body.permission).toEqual([{ permission: 'task', pattern: '*', action: 'deny' }]);
            const { permission: _permission, ...rest } = controlled.body;
            expect(rest).toEqual(normal.body);
            expect(normal.body).not.toHaveProperty('permission');
            // Later prompts must not replace the session rules with a tools map.
            expect(restricted!.filter(row => row.url !== '/session')).toEqual(ordinary!.filter(row => row.url !== '/session'));
            expect(restricted!.filter(row => row.url.includes('prompt_async')).every(row => row.body.tools === undefined)).toBe(true);
          }
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 45000);
    }
  }
});

// ---- AgentRunSpec support declarations (#284) ------------------------------
//
// Every runner declares, per `AgentRunSpec` field, whether it honors the field
// and how (`AgentRunner.specSupport`). These rows hold each declaration against
// the runner's real boundary — the same argv / JSON-RPC / HTTP recordings D1
// reads, plus the first user message where a mock records its stdin — so a
// runner cannot say it maps a field it drops, and cannot quietly start mapping
// one it declared dropped. Codex and OpenCode ignoring `allowedTools` stays
// pinned exactly as long as they declare it (the product decision the
// `AgentRunSpec` caveat in AGENT_PROTOCOL.md records).

/**
 * How one field is observed. `boundary` probes set the field and nothing else
 * between `without` and `with`, so any difference in the recording is that
 * field's own footprint. `process` fields shape the child rather than its
 * input, proven by the recording landing where only an honored `cwd` and `env`
 * could put it. `deadline` is cezar-side, proven by a held turn ending in the
 * runner's own timeout error.
 */
type SpecFieldProbe =
  | { readonly kind: 'boundary'; readonly without: Partial<AgentRunSpec>; readonly with: Partial<AgentRunSpec> }
  | { readonly kind: 'process' }
  | { readonly kind: 'deadline' };

const PROBE_IMAGE: ContentBlock = {
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'cGFyaXR5' },
};

/** One probe per field — the `Record` fails to compile when `AgentRunSpec` grows. */
const SPEC_FIELD_PROBES: Readonly<Record<AgentRunSpecField, SpecFieldProbe>> = {
  systemPrompt: { kind: 'boundary', without: {}, with: { systemPrompt: 'parity probe system prompt' } },
  // Markerless on purpose, so every mock still answers with its default turn.
  userPrompt: { kind: 'boundary', without: {}, with: { userPrompt: 'inspect the working tree, then report' } },
  images: { kind: 'boundary', without: {}, with: { images: [PROBE_IMAGE] } },
  cwd: { kind: 'process' },
  allowedTools: { kind: 'boundary', without: {}, with: { allowedTools: ['Read', 'Grep'] } },
  restrictNativeDelegation: { kind: 'boundary', without: {}, with: { restrictNativeDelegation: true } },
  // Only meaningful next to an allowed `Bash`, so both sides carry it.
  bashAllowlist: {
    kind: 'boundary',
    without: { allowedTools: ['Bash'] },
    with: { allowedTools: ['Bash'], bashAllowlist: ['git status'] },
  },
  additionalDirectories: { kind: 'boundary', without: {}, with: { additionalDirectories: ['/tmp/parity-probe-extra'] } },
  env: { kind: 'process' },
  model: { kind: 'boundary', without: {}, with: { model: 'parity-probe/model-sentinel' } },
  effort: { kind: 'boundary', without: {}, with: { effort: 'xhigh' } },
  timeoutMs: { kind: 'deadline' },
  // A session id is a resume handle on codex, so both sides resume; `resume`
  // alone is a no-op on every runner, which keeps `without` a clean base.
  sessionId: { kind: 'boundary', without: { resume: true }, with: { resume: true, sessionId: PINNED_SESSION_ID } },
  resume: {
    kind: 'boundary',
    without: { sessionId: PINNED_SESSION_ID },
    with: { sessionId: PINNED_SESSION_ID, resume: true },
  },
};

const variantKey = (spec: Partial<AgentRunSpec>): string => JSON.stringify(spec);

/** The mock's own record of what reached it: argv or requests, then stdin where hooked. */
function readRecording(dir: string, name: string): string[] {
  return [`${name}.args.ndjson`, `${name}.stdin.ndjson`].flatMap((file) => {
    const path = join(dir, file);
    return existsSync(path) ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean) : [];
  });
}

/** Env for a probe drive. The recording paths are RELATIVE on purpose: the mock
 *  resolves them against ITS cwd, so a recording that lands in `dir` is
 *  evidence for `cwd` and `env` in one stroke (the `process` probes). */
const probeEnv = (name: string) => ({
  CEZ_MOCK_ARGS_FILE: `${name}.args.ndjson`,
  CEZ_MOCK_STDIN_FILE: `${name}.stdin.ndjson`,
  CEZ_HANDOFF_FILE: '',
  CEZ_TODOS_FILE: '',
});

describe('harness parity — AgentRunSpec support declarations', () => {
  it('every runner id builds its own runner, declaring every AgentRunSpec field with a reason', () => {
    for (const backend of RUNNER_IDS) {
      const runner = createRunner(backend);
      // A fifth id with no factory case falls through to claude; that is not a declaration.
      expect(runner.backend).toBe(backend);
      expect(Object.keys(runner.specSupport).sort()).toEqual([...AGENT_RUN_SPEC_FIELDS].sort());
      for (const field of AGENT_RUN_SPEC_FIELDS) {
        const support = runner.specSupport[field];
        expect(`${backend}/${field}: ${support.honored ? support.via : support.reason}`.trim()).not.toMatch(/: $/);
      }
    }
  });

  it('every AgentRunSpec field has a probe', () => {
    expect(Object.keys(SPEC_FIELD_PROBES).sort()).toEqual([...AGENT_RUN_SPEC_FIELDS].sort());
  });

  for (const backend of RUNNER_IDS) {
    describe(`${backend} declarations against its boundary`, () => {
      let dir = '';
      const recordings = new Map<string, string[]>();
      let deadlineErrors: string[] = [];

      beforeAll(async () => {
        dir = mkdtempSync(join(tmpdir(), `cez-spec-support-${backend}-`));
        const variants = new Map<string, Partial<AgentRunSpec>>();
        for (const probe of Object.values(SPEC_FIELD_PROBES)) {
          if (probe.kind !== 'boundary') continue;
          variants.set(variantKey(probe.without), probe.without);
          variants.set(variantKey(probe.with), probe.with);
        }
        let n = 0;
        for (const [key, spec] of variants) {
          const name = `probe-${n++}`;
          const obs = await driveSeam(backend, 'baseline', {
            spec: { cwd: dir, sessionId: undefined, env: probeEnv(name), ...spec },
          });
          expect(obs.v1.filter((e) => e.type === 'error')).toEqual([]);
          recordings.set(key, readRecording(dir, name));
        }
        // `hold` keeps content ≥250ms behind the prompt, so a 150ms deadline
        // fires first on every wire and the runner reports its own timeout.
        const held = await driveSeam(backend, 'hold', {
          spec: { cwd: dir, timeoutMs: 150, env: probeEnv('deadline') },
        });
        deadlineErrors = held.v1
          .filter((e): e is Extract<AgentEvent, { type: 'error' }> => e.type === 'error')
          .map((e) => e.message);
      }, 120_000);

      afterAll(() => {
        rmSync(dir, { recursive: true, force: true });
      });

      for (const field of AGENT_RUN_SPEC_FIELDS) {
        it(`${backend} does with ${field} what it declares`, () => {
          const declared = createRunner(backend).specSupport[field].honored;
          const probe = SPEC_FIELD_PROBES[field];
          let observed: boolean;
          if (probe.kind === 'boundary') {
            const without = recordings.get(variantKey(probe.without));
            const withField = recordings.get(variantKey(probe.with));
            expect(without?.length ?? 0).toBeGreaterThan(0);
            observed = JSON.stringify(without) !== JSON.stringify(withField);
          } else if (probe.kind === 'process') {
            observed = (recordings.get(variantKey({}))?.length ?? 0) > 0;
          } else {
            observed = deadlineErrors.some((message) => /timed out/.test(message));
          }
          // Both directions: an honored field must leave a footprint, and a
          // declared-dropped field must leave none — that inversion is what
          // keeps codex/opencode `allowedTools` pinned as ignored (AC #3).
          expect({ backend, field, honored: observed }).toEqual({ backend, field, honored: declared });
        });
      }
    });
  }
});
