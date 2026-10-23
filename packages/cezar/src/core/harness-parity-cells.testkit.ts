import { createApp } from '../server/server.ts';
import { apiRequest } from '../server/loopback-request.testkit.ts';
/**
 * Harness parity — the session and lifecycle matrix.
 *
 * `ui-parity.test.ts` asserts the other axis of the same requirement: that every
 * mapper emits every v2 UI capability, so the GUI degrades per-capability rather
 * than per-backend. These cells assert the rest of the contract in
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
 * `ask.requested` comes from the RUNNER for codex, opencode and cursor and from
 * `workflows/run.ts` for claude and pi — groups 1, 3 and 6 are only uniform
 * above the seam.
 *
 * `describeHarnessParity` defines every cell. `harness-parity.test.ts` runs the
 * matrix guard and the single-runner cells, and each `harness-<runner>-parity.test.ts`
 * runs one runner's cells (hearsay-tools/cezarion#1288).
 */
import { TranscriptFactsQueue } from '../runs/transcript-facts-queue.ts';
import { historyPaths } from '../runs/history-file.ts';
import { MONITORING_TURN_CRITERIA, MONITORING_ACK_CRITERIA, MONITORING_ORDER_CRITERIA } from '../workflows/monitoring-turn.testkit.ts';
import { WAIT_CRITERIA } from '../workflows/waits-parity.testkit.ts';
import { monitoringTimerOf, monitoringWakeOf } from '../workflows/waits.testkit.ts';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, mkdirSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentInputEventSchema } from '@open-mercato/cezar-contract/events';
import { deriveAttention } from '@open-mercato/cezar-contract/attention';
import type { AgentInput } from '@open-mercato/cezar-contract';
import { fileURLToPath } from 'node:url';
import type { UiEvent } from './ui-events.ts';
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
import { inputDeliveryOf } from './agent-runner.ts';
import { agentTmpDir, resolveAgentTmpDir } from '../runs/agent-tmpdir.ts';
import { appendTurnText } from '../workflows/run.ts';
import * as gitWorktree from '../git-worktree.ts';
import { cleanupCheckpoint, seedSettledFamily } from '../workflows/delegation-reconcile.testkit.ts';
import { supportsProfiles } from './agent-profiles.ts';
import { allowedToolsForStep, plannedWorkflow, skillTaskSteps, type WorkflowDef } from '../workflows/types.ts';
import { workerWorkflowHash, type WorkerAccountBinding, type WorkerExecutionIdentity } from '../delegation/execution-identity.ts';
import {
  withOwnedInputRun,
  withSkillParentRun,
  promptFor,
  driveRun,
  driveSeam,
  lastIndexWhere,
  textEvents,
  exemptionFor,
  HARNESS_ADAPTERS,
  SHUTDOWN_CRITERIA,
  MODEL_REFUSAL_CRITERIA,
  PERMISSION_CRITERIA,
  WORKFLOW_TIMEOUT_CRITERIA,
  NO_PROGRESS_CRITERIA,
  AUTONOMOUS_CRITERIA,
  FINAL_MESSAGE_CRITERIA,
  WORKER_PROGRESS_WAIT_CRITERIA,
  WORKFLOW_ASK_CRITERIA,
  FOLLOWUP_CRITERIA,
  ANSWER_DELIVERY_CRITERIA,
  SKILL_RESUME_CRITERIA,
  SKILL_PROVISION_CRITERIA,
  WORKTREE_SETUP_CRITERIA,
  PARITY_EXEMPTIONS,
  PINNED_SESSION_ID,
  seedOpencodeMockSession,
  type RunObservation,
  type ScenarioName,
  type SeamObservation,
  waitFor,
} from './harness-parity.testkit.ts';
import { blockRunWrites, crashStore, muteLockedDatabaseLogs, readPersistedRuns, seedRuns, hasPendingAsk } from '../runs/run-store.testkit.ts';
import { RunStore, type RunRecord } from '../runs/store.ts';
import { createFixtureManager, drainFixtureManagers } from '../workflows/fixture-cleanup.testkit.ts';

/** One row of the matrix, named once and applied to every harness. */
interface SeamCriterion<T = SeamObservation> {
  /** Stable id the exemption table references. */
  readonly id: string;
  readonly name: string;
  readonly scenario: ScenarioName;
  /** Throws when the backend does not satisfy the criterion. */
  readonly assert: (obs: T) => void;
}

const sessionEvents = (v1: readonly AgentEvent[]) =>
  v1.filter((e): e is Extract<AgentEvent, { type: 'session' }> => e.type === 'session');

const SEAM_CRITERIA: readonly SeamCriterion[] = [
  {
    // hearsay-tools/cezarion#832: restored history must not silently cross workflow steps.
    id: 'S21',
    name: 'S21 warns about unexpected startup history without failing the turn',
    scenario: 'auto-resumed',
    assert: ({ v1, v2, result, failure }) => {
      const warnings = v2.filter(event => event.type === 'session.error');
      expect(warnings).toEqual([{
        type: 'session.error', fatal: false,
        message: expect.stringMatching(/restored.*4.*autoResume/),
      }]);
      expect(v1.filter(event => event.type === 'note')).toEqual([
        { type: 'note', message: warnings[0]!.message },
      ]);
      expect(v1.some(event => event.type === 'error')).toBe(false);
      expect(failure).toBeUndefined();
      expect(result.text).not.toBe('');
      expect(v1.filter(event => event.type === 'done')).toHaveLength(1);
      expect(v2).toContainEqual(expect.objectContaining({ type: 'turn.completed', stopReason: 'end_turn' }));
      expect(v2.indexOf(warnings[0]!)).toBeLessThan(v2.findIndex(event => event.type === 'turn.completed'));
    },
  },
  {
    // hearsay-tools/cezarion#872: a start racing its predecessor's teardown exits before listening.
    id: 'S25',
    name: 'S25 retries a backend server that exits before listening once and completes the turn',
    scenario: 'serve-start-exit',
    assert: ({ v1, v2, result, failure }) => {
      expect(failure).toBeUndefined();
      expect(v1.filter(event => event.type === 'error')).toEqual([]);
      const retries = v1.filter(event => event.type === 'note' && /exited before listening .*retrying once/.test(event.message));
      expect(retries).toHaveLength(1);
      const retry = v1.indexOf(retries[0]!);
      expect(v1.findIndex(event => event.type === 'session')).toBeGreaterThan(retry);
      expect(v1.filter(event => event.type === 'turn-end')).toHaveLength(1);
      expect(v1.filter(event => event.type === 'done')).toHaveLength(1);
      expect(result.text).not.toBe('');
      expect(v2).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
    },
  },
  {
    id: 'S20',
    name: 'S20 reports missing executables through its existing failure channel without starting a turn',
    scenario: 'missing-binary',
    assert: ({ backend, v1, failure, pid }) => {
      // ENOENT precedes the backend wire. Runners retain their existing event
      // and/or rejected-result channels; none may look like a successful turn.
      expect(pid).toBeUndefined();
      const errors = v1.filter(event => event.type === 'error');
      expect(errors.length).toBeLessThanOrEqual(1);
      if (backend === 'opencode') {
        expect(errors).toHaveLength(1);
        expect(failure).toBeDefined();
        expect(errors[0]!.message).toBe(failure!.message);
        expect(v1.some(event => event.type === 'done' || event.type === 'turn-end')).toBe(false);
      }
      const diagnostics = [...errors.map(event => event.message), ...(failure ? [failure.message] : [])];
      expect(diagnostics.length).toBeGreaterThan(0);
      for (const message of diagnostics) expect(message).toMatch(/PATH|install/i);
      expect(v1.some(event => event.type === 'turn-end' || event.type === 'text')).toBe(false);
      const done = v1.findIndex(event => event.type === 'done');
      if (done >= 0) expect(v1.findIndex(event => event.type === 'error')).toBeGreaterThanOrEqual(0);
      if (done >= 0) expect(v1.findIndex(event => event.type === 'error')).toBeLessThan(done);
    },
  },
  {
    id: 'S18',
    name: 'S18 reports one actionable crash before terminal boundaries when the opening prompt is unacknowledged',
    scenario: 'crash-stderr-pre-ack',
    assert: ({ v1 }) => {
      const errors = v1.filter(e => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('Error: write EPIPE');
      expect(errors[0]!.message).toMatch(/(?:code 1|\(1\))/);
      const errorIndex = v1.findIndex(e => e.type === 'error');
      for (const [index, event] of v1.entries()) {
        if (event.type === 'turn-end' || event.type === 'done') expect(index).toBeGreaterThan(errorIndex);
      }
      expect(v1.filter(e => e.type === 'turn-end').length).toBeLessThanOrEqual(1);
      expect(v1.filter(e => e.type === 'done').length).toBeLessThanOrEqual(1);
    },
  },
  {
    id: 'S19',
    name: 'S19 drains late crash stderr without waiting indefinitely for inherited pipes',
    scenario: 'crash-stderr-held-pipe',
    assert: ({ v1, elapsedMs }) => {
      expect(elapsedMs).toBeLessThan(4_000); // Descendant keeps both pipes open for 5s.
      const errors = v1.filter(e => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('Error: write EPIPE');
      expect(v1.filter(e => e.type === 'note').map(e => e.message).join('\n')).toContain('late buffered crash diagnostic');
    },
  },
  {
    id: 'S17',
    name: 'S17 keeps clean exits and requested signal teardown successful despite stderr',
    scenario: 'shutdown-stderr',
    assert: ({ v1 }) => {
      expect(v1.filter(e => e.type === 'error')).toEqual([]);
      expect(v1.filter(e => e.type === 'done')).toHaveLength(1);
      expect(v1.filter(e => e.type === 'turn-end')).toHaveLength(1);
      expect(v1.at(-1)?.type).toBe('done');
      expect(v1.filter(e => e.type === 'note').map(e => e.message).join('\n')).not.toContain('harmless shutdown diagnostic');
    },
  },
  {
    id: 'S15',
    name: 'S15 preserves actionable crash stderr and full available diagnostics after malformed native output',
    scenario: 'crash-stderr',
    assert: ({ v1 }) => {
      const errors = v1.filter(e => e.type === 'error');
      expect(errors).toHaveLength(1);
      const message = errors.at(-1)!.message;
      expect(message).toContain('Error: write EPIPE');
      expect(message).toMatch(/(?:code 1|\(1\))/);
      expect(message).not.toContain('Node.js');
      expect(message).not.toContain(' |  | ');
      expect(message.length).toBeLessThan(650);
      expect(v1.filter(e => e.type === 'done').length).toBeLessThanOrEqual(1);
      expect(v1.filter(e => e.type === 'turn-end').length).toBeLessThanOrEqual(1);
      if (message.startsWith('pi CLI')) {
        expect(v1.some(e => e.type === 'note' && e.message.includes('skipped unparseable RPC line'))).toBe(true);
      }
      const notes = v1.filter(e => e.type === 'note').map(e => e.message).join('\n');
      expect(notes).toContain('at afterWriteDispatched (node:internal/stream_base_commons:159:15)');
      expect(notes).toContain("errno: -32,\n  code: 'EPIPE',\n  syscall: 'write',");
      expect(notes).toContain("diagnostic: '" + 'x'.repeat(700) + "'");
      expect(notes).toContain('Node.js v24.20.0');
    },
  },
  {
    id: 'S16',
    name: 'S16 preserves single-line stderr and nonzero exit codes',
    scenario: 'crash-stderr-single',
    assert: ({ v1 }) => {
      const errors = v1.filter(e => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors.at(-1)!.message).toContain('authentication unavailable');
      expect(errors.at(-1)!.message).toMatch(/(?:code 7|\(7\))/);
    },
  },
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
    // cursor and pi split INSIDE the marker (deltas, growing snapshots, tokens), which
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
      // failed turn (as does cursor), and claude only has the result envelope's stop reason.
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
    assert: ({ backend, v1, v2, result }) => {
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
      // hearsay-tools/cezarion#833: OMP's child message_end must contribute spend without
      // changing the shared parent/child lifecycle contract above. Other native wires keep
      // their existing aggregate telemetry; these literals describe the OMP mock's calls.
      if (backend === 'omp') {
        expect(result.tokensUsed).toBe(60);
        expect(v1.filter(event => event.type === 'cost').map(event => event.usd)).toEqual([0.001, 0.002]);
        expect(v2.filter(event => event.type === 'usage.updated').at(-1)).toMatchObject({
          usage: { input: 30, output: 15, total: 149, cacheRead: 100, cacheWrite: 4 }, costUsd: 0.003,
        });
        expect(v2.filter(event => event.type === 'turn.completed')).toEqual([
          expect.objectContaining({ usage: { input: 30, output: 15, total: 149, cacheRead: 100, cacheWrite: 4 }, costUsd: 0.003 }),
        ]);
      }
    },
  },
  {
    // Group 7 — `resumeCommand()` and "open in CLI" need a session id after
    // every run. The two wires differ and both are legitimate: codex, opencode
    // cursor and pi mint their own and echo a v1 `session` event, while claude pins
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
  readonly timeoutMs?: number;
  readonly settled: (record: RunObservation['record']) => boolean;
  readonly assert: (obs: RunObservation) => void;
}

const TERMINAL: readonly string[] = ['review', 'done', 'failed', 'cancelled'];

const askEvents = (obs: RunObservation) =>
  obs.events.filter((e) => e.type === 'ask.requested');

const RUN_CRITERIA: readonly RunCriterion[] = [
  {
    // #550: Codex keeps its turn open and emits retryable errors; other wires
    // use their native provider rejection. Every runner must leave running.
    id: 'R17',
    name: 'R17 bounds an unavailable provider and preserves its failure reason',
    scenario: 'provider-unavailable',
    timeoutMs: 75_000,
    settled: record => TERMINAL.includes(record?.status ?? '') || record?.status === 'waiting',
    assert: obs => {
      expect(obs.record?.status).toBe('failed');
      expect(obs.statuses).not.toContain('waiting');
      expect(obs.record?.error?.trim()).toBeTruthy();
      if (obs.record?.runner === 'codex') {
        expect(obs.record.error).toContain('Connection failed: error sending request');
        expect(obs.events).toContainEqual(expect.objectContaining({
          type: 'session.error', fatal: false,
          message: 'Reconnecting... 2/5 — stream disconnected before completion: invalid peer certificate: UnknownIssuer',
        }));
      }
    },
  },
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
    // opencode and cursor have native asks their runners map; claude and pi go
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
    // #548: an earlier prose mention must not consume the real final-line ASK.
    id: 'R18',
    name: 'R18 resolves a final-line ASK after prose mentions the marker',
    scenario: 'ask-snapshot',
    settled: (record) => record?.status === 'waiting' || TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(obs.record?.status).toBe('waiting');
      expect(askEvents(obs)).toHaveLength(1);
      expect(obs.events.some(e => e.type === 'note' && String(e.message).includes('structured question ignored'))).toBe(false);
      expect(obs.events.some(e => e.type === 'text' && String(e.text).includes('Using the CEZ:ASK structured question format instead:'))).toBe(true);
      expect(obs.events.some(e => e.type === 'text' && String(e.text).includes('\nCEZ:ASK {'))).toBe(false);
    },
  },
  {
    // #548: code spans and quoted logs alone are prose, never rejected ASK.
    id: 'R19',
    name: 'R19 leaves quoted ASK examples as plain text without a rejection',
    scenario: 'ask-prose',
    settled: (record) => record?.status === 'waiting' || TERMINAL.includes(record?.status ?? ''),
    assert: (obs) => {
      expect(obs.record?.status).toBe('waiting');
      expect(askEvents(obs)).toHaveLength(0);
      expect(obs.events.some(e => e.type === 'note' && String(e.message).includes('structured question ignored'))).toBe(false);
      expect(obs.events.some(e => e.type === 'text' && String(e.text).includes('> CEZ:ASK {not valid json'))).toBe(true);
    },
  },
  {
    // Group 6 / #48 — a declared park is a non-attention state. The same
    // scenario S8 asserts survives the seam: the cause below, the effect here.
    id: 'R5',
    name: 'R5 parks a declared monitoring turn on an open monitoring timer, not as a plain wait',
    scenario: 'split-text',
    settled: (record) => record?.status === 'waiting',
    assert: (obs) => {
      // hearsay-tools/cezarion#1233: `waiting` plus an open timer reads as monitoring.
      expect(obs.record).toMatchObject({ status: 'waiting' });
      expect(monitoringWakeOf(obs.record)).toBeDefined();
      expect(deriveAttention(obs.record!).label).toBe('monitoring');
    },
  },
  {
    // #149: the child message lands before the parent's turn-end, after its marker.
    id: 'R12',
    name: 'R12 keeps monitoring parked when child text follows the parent marker',
    scenario: 'subagent',
    settled: (record) => record?.status === 'waiting',
    assert: (obs) => {
      expect(obs.record).toMatchObject({ status: 'waiting' });
      expect(monitoringWakeOf(obs.record)).toBeDefined();
      expect(deriveAttention(obs.record!).label).toBe('monitoring');
    },
  },
];

/** Criteria driven through `whileOpen` rather than one settled observation. */
const CONTROL_CRITERIA = [
  // hearsay-tools/cezarion#1380: workflows/resume-diagnostics-parity.test.ts.
  { id: 'R85', scenario: 'provider-error' },
  { id: 'R86', scenario: 'done' },
  { id: 'R87', scenario: 'done' },
  { id: 'R88', scenario: 'provider-error' },
  { id: 'R89', scenario: 'provider-error' },
  { id: 'R90', scenario: 'done' },
  { id: 'R91', scenario: 'done' },
  { id: 'D1', scenario: 'baseline' },
  // hearsay-tools/cezarion#1284: a forked skill starts no native subagent in a restricted session.
  { id: 'D2', scenario: 'forked-skill' },
  { id: 'S5', scenario: 'baseline' },
  { id: 'S6', scenario: 'baseline' },
  { id: 'S11', scenario: 'ask' },
  { id: 'S12', scenario: 'hold' },
  { id: 'S13', scenario: 'hold' },
  { id: 'S14', scenario: 'baseline' },
  { id: 'R44', scenario: 'skill-warning' },
  { id: 'R45', scenario: 'skill-warning' },
  { id: 'R46', scenario: 'provider-error' },
  { id: 'R6', scenario: 'ask' },
  { id: 'R7', scenario: 'ask' },
  { id: 'R8', scenario: 'hold' },
  { id: 'R9', scenario: 'ask-reply-late' },
  { id: 'R10', scenario: 'done' },
  { id: 'R11', scenario: 'baseline' },
  { id: 'R15', scenario: 'subagent-after-park' },
  // #961: hook items never move run state, mid-turn or after the park.
  { id: 'R77', scenario: 'hook-after-park' },
  { id: 'R16', scenario: 'ask-snapshot' },
  { id: 'R20', scenario: 'baseline' },
  { id: 'R21', scenario: 'baseline' },
  { id: 'R22', scenario: 'baseline' },
  { id: 'R23', scenario: 'ask' },
  // harness-autosave.test.ts drives both cleanup paths with native runner wires.
  { id: 'R24', scenario: 'baseline' },
  { id: 'R25', scenario: 'baseline' },
  // hearsay-tools/cezarion#934: harness-autosave-settlement.test.ts, independent writer guard.
  { id: 'R61', scenario: 'provider-error' },
  { id: 'R62', scenario: 'provider-error' },
  { id: 'R63', scenario: 'baseline' },
  { id: 'R64', scenario: 'ask-snapshot' },
  { id: 'R65', scenario: 'baseline' },
  { id: 'R66', scenario: 'baseline' },
  // hearsay-tools/cezarion#958: final autosave beside unrelated worktree process churn.
  { id: 'R67', scenario: 'baseline' },
  { id: 'R68', scenario: 'baseline' },
  // hearsay-tools/cezarion#1004: harness-autosave-branch.test.ts, run-finalize and turn-end
  // saves leave work on an agent-checked-out branch uncommitted and report it in the handoff;
  // R79 also reports a periodic commit that leaves the closing turn-end flush clean.
  { id: 'R78', scenario: 'baseline' },
  { id: 'R79', scenario: 'baseline' },
  // hearsay-tools/cezarion#994: workflows/ci-wait-failure-parity.test.ts,
  // failed fresh/continued CI attempts retain history through scheduler recovery.
  { id: 'R72', scenario: 'provider-error' },
  { id: 'R73', scenario: 'provider-error' },
  // Nonfinal CI recovery retains failure history and runs the tail/check retries, including restart.
  { id: 'R74', scenario: 'provider-error' },
  { id: 'R75', scenario: 'provider-error' },
  { id: 'R76', scenario: 'provider-error' },
  { id: 'R26', scenario: 'ask-resume' },
  // workflows/ci-wait-refusal.test.ts: settled worker wake, private CI IPC, then delivery.
  { id: 'R27', scenario: 'hold' },
  // hearsay-tools/cezarion#1225: cancel/destroy releases the same-turn wait slot.
  { id: 'R80', scenario: 'hold' },
  // workflows/ci-wait-conflict-parity.test.ts: real gh metadata, atomic input, native wake.
  { id: 'R81', scenario: 'baseline' },
  { id: 'R82', scenario: 'baseline' },
  { id: 'R83', scenario: 'baseline' },
  { id: 'R84', scenario: 'baseline' },
  // hearsay-tools/cezarion#1399: workflows/ci-wait-rerun-parity.test.ts keeps
  // partial green pending during a rerun, including recovery without a session.
  { id: 'R85', scenario: 'baseline' },
  // hearsay-tools/cezarion#1440: query retry through native wake, fresh and recovered.
  { id: 'R92', scenario: 'baseline' },
  { id: 'R28', scenario: 'baseline' },
  { id: 'R29', scenario: 'baseline' },
  { id: 'R30', scenario: 'baseline' },
  { id: 'R31', scenario: 'baseline' },
  { id: 'R32', scenario: 'baseline' },
  { id: 'R33', scenario: 'baseline' },
  { id: 'R34', scenario: 'baseline' },
  // R35 covers both preview serve (#781) and stop/restart (#803) discovery on every native wire.
  { id: 'R35', scenario: 'baseline' },
  // core/ci-tools.test.ts (hearsay-tools/cezarion#1233): `cezar_wait` and `cezar_cancel_wait`
  // reach the session's handlers through each native wire, fresh and resumed.
  { id: 'U0', scenario: 'baseline' },
  // #399: shared monitoring instructions on each native prompt channel.
  { id: 'R36', scenario: 'baseline' },
  { id: 'R37', scenario: 'baseline' },
  { id: 'R38', scenario: 'split-text' },
  { id: 'R39', scenario: 'split-text' },
  { id: 'R40', scenario: 'baseline' },
  { id: 'R41', scenario: 'done' },
  { id: 'R42', scenario: 'baseline' },
  // workflows/worker-reboot-parity.test.ts and worker-location-evidence.test.ts: native exit/Continue,
  // independent reboot proof, legacy location uncertainty, readable vs unreadable holders, cleanup retries
  // and parent Finish.
  { id: 'R43', scenario: 'baseline' },
  // workflows/worker-restart-parity.test.ts: same-boot exit proof, mixed-holder polling and bounded cleanup locks.
  { id: 'R47', scenario: 'baseline' },
  // worker-restart-parity.test.ts: cold terminal starting-proof facts readiness.
  { id: 'R60', scenario: 'baseline' },
  // #779: Continue on a run only runs.db holds, through both ActiveRun construction sites.
  { id: 'R48', scenario: 'done' },
  // #779: restart still repairs a cancelled root's stale Finish intent, so Continue is not refused.
  { id: 'R49', scenario: 'done' },
  // #779 plan step 3: a headless open beside the owner leaves its parked run alone.
  { id: 'R50', scenario: 'ask' },
  // #779 plan step 3: adopting a dead owner's mid-turn run for a control resumes nothing; Continue does.
  { id: 'R51', scenario: 'hold' },
  // #779: Stop on a dead owner's mid-turn run ends it cancelled, not interrupted, and starts nothing.
  { id: 'R52', scenario: 'hold' },
  { id: 'PR1', scenario: 'multi-pr-refs' },
  { id: 'PR2', scenario: 'multi-pr-refs' },
] as const;

/**
 * Register one cell. An exempt cell still produces a named test that fails the
 * day the backend gains the thing — see `ExemptionKind` for the two ways that
 * is pinned. Never relax an assertion to accommodate an exemption; delete the
 * exemption instead.
 */
function parityRow<T = SeamObservation>(
  backend: RunnerId,
  criterion: SeamCriterion<T>,
  observe: () => Promise<T>,
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

// Group 8 — #505: agent input reaches a running turn and its reading is reported.
interface InputObservation {
  readonly obs: SeamObservation;
  readonly consumed: readonly string[];
  readonly consumedBeforeTurnEnd: boolean;
  readonly unconsumed: readonly string[];
}
async function observeInput(backend: RunnerId, scenario: ScenarioName, id: string): Promise<InputObservation> {
  const consumed: string[] = [];
  let consumedBeforeTurnEnd = false;
  let seenTurnEnd = false;
  const obs = await driveSeam(backend, scenario, {
    sessionOptions: { onAgentInputConsumed: ids => { consumed.push(...ids); if (!seenTurnEnd) consumedBeforeTurnEnd = true; } },
    whileOpen: async (session, { v1 }) => {
      const firstTurnEnd = () => { seenTurnEnd ||= v1.some(e => e.type === 'turn-end'); return seenTurnEnd; };
      await waitFor(() => v1.some(e => (scenario === 'steer-tool' ? e.type === 'tool-call' : e.type === 'text')) || firstTurnEnd());
      let ack: false | Promise<void> = false;
      const text = `mock:agent-echo parity ${id}`;
      await waitFor(() => (ack = session.sendAgentMessage([{ type: 'text', text }], [id])) !== false || firstTurnEnd());
      if (ack) await ack;
      await waitFor(() => firstTurnEnd());
      // Late input is read by a follow-on turn or reported; OpenCode reports after a grace window.
      const reported = () => v1.some(e => (e.type === 'turn-end' && !!e.unconsumedInputIds?.length) || e.type === 'input-unconsumed');
      await waitFor(() => consumed.includes(id) || reported(), 6_000).catch(() => undefined);
    },
  });
  const unconsumed = obs.v1.flatMap(e => e.type === 'input-unconsumed' ? [...e.inputIds]
    : e.type === 'turn-end' ? [...(e.unconsumedInputIds ?? [])] : []);
  return { obs, consumed, consumedBeforeTurnEnd, unconsumed };
}
const INPUT_CRITERIA: readonly SeamCriterion<InputObservation>[] = [
  {
    id: 'I1',
    name: 'I1 admits agent input mid-turn and reports it read before that turn ends',
    scenario: 'steer-tool',
    assert: ({ obs, consumed, consumedBeforeTurnEnd }) => {
      expect(consumed).toEqual(['parity-I1']);
      expect(consumedBeforeTurnEnd).toBe(true);
      expect(obs.v1.filter(e => e.type === 'turn-end')).toHaveLength(1);
    },
  },
  {
    id: 'I2',
    name: 'I2 reports accepted input the finished turn never read',
    scenario: 'steer-late',
    assert: ({ unconsumed, consumed }) => {
      expect(unconsumed).toEqual(['parity-I2']);
      expect(consumed).toEqual([]);
    },
  },
];
// hearsay-tools/cezarion#1235 (PR #1291 CI): OpenCode can answer steered input in a follow-on run
// that starts after the turn's idle. Input posted in that gap opened its own turn, the follow-on
// run's idle closed it, and the input's own run then surfaced nothing. Every wire answers input
// posted right after a turn that took a steer in a turn of its own.
interface FollowOnObservation {
  readonly obs: SeamObservation;
  readonly consumed: readonly string[];
  readonly observable: boolean;
}
const FOLLOW_ON_STEERED = 'parity-I6-steered';
const FOLLOW_ON_NEXT = 'parity-I6-next';
/** The echo of `id` reached the run, and a turn end followed it. */
const answeredInItsTurn = (v1: readonly AgentEvent[], id: string) => {
  const at = v1.findIndex(e => e.type === 'text' && e.text.includes(`parity ${id}`));
  return at >= 0 && v1.slice(at).some(e => e.type === 'turn-end');
};
async function observeFollowOn(backend: RunnerId): Promise<FollowOnObservation> {
  const consumed: string[] = [];
  const obs = await driveSeam(backend, 'steer-tool', {
    // The OpenCode mock answers steers in a follow-on run 300 ms after the idle; other mocks ignore it.
    spec: { env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: '', CEZ_MOCK_OPENCODE_FOLLOW_ON_MS: '300' } },
    sessionOptions: { onAgentInputConsumed: ids => { consumed.push(...ids); } },
    whileOpen: async (session, { v1 }) => {
      const turnEnded = () => v1.some(e => e.type === 'turn-end');
      const submit = async (id: string) => {
        let ack: false | Promise<void> = false;
        await waitFor(() => (ack = session.sendAgentMessage([{ type: 'text', text: `mock:agent-echo parity ${id}` }], [id])) !== false);
        if (ack) await ack;
      };
      await waitFor(() => v1.some(e => e.type === 'tool-call') || turnEnded());
      await submit(FOLLOW_ON_STEERED);
      await waitFor(turnEnded);
      await submit(FOLLOW_ON_NEXT);
      // bound: the red case never answers; the assertion below reports what arrived instead.
      await waitFor(() => answeredInItsTurn(v1, FOLLOW_ON_NEXT), 10_000).catch(() => undefined);
    },
  });
  return { obs, consumed, observable: inputDeliveryOf(createRunner(backend)).consumption === 'observable' };
}
const FOLLOW_ON_CRITERION: SeamCriterion<FollowOnObservation> = {
  id: 'I6',
  name: 'I6 answers input posted right after a turn that took a steer in a turn of its own',
  scenario: 'steer-tool',
  assert: ({ obs, consumed, observable }) => {
    expect(obs.failure).toBeUndefined();
    expect(answeredInItsTurn(obs.v1, FOLLOW_ON_NEXT)).toBe(true);
    if (observable) expect([...consumed].sort()).toEqual([FOLLOW_ON_NEXT, FOLLOW_ON_STEERED]);
  },
};

// #723: use the real RunManager on both event-handler construction paths.
async function continueDiagnosticRun(backend: RunnerId, prompt: string): Promise<RunObservation> {
  return driveRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
    async ({ store, manager, runId }) => {
      const internal = manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> };
      const timer = internal.active.get(runId)?.idleTimer as NodeJS.Timeout & { _onTimeout(): void };
      expect(timer).toBeDefined();
      timer._onTimeout();
      await waitFor(() => !manager.isActive(runId));
      expect(manager.continueRun(runId, { text: prompt }).ok).toBe(true);
      await waitFor(() => TERMINAL.includes(store.getRun(runId)?.status ?? ''), 30_000);
    });
}

/** Flush until `runId` has left the store's memory; false if it never does. */
async function leavesMemory(store: RunStore, runId: string): Promise<boolean> {
  try {
    await waitFor(() => { store.flush(); return !store.heldIds().includes(runId); }, 10_000);
    return true;
  } catch {
    return false;
  }
}

const agentInput = (parentRunId: string, text = '/owned-skill mock:agent-echo parent steering'): AgentInput => ({
  id: randomUUID(), source: 'agent', parentRunId, text, createdAt: new Date().toISOString(),
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
  cezarTools: { kind: 'boundary', without: {}, with: { cezarTools: { name: 'cezar_ci_probe', command: 'node', args: ['/installed/ci-wait/mcp.js'] } } },
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
  // Both sides resume a missing id so OpenCode takes the 404 fallback; the
  // field is the opening prompt of that fresh session only.
  resumeFallbackSystemPrompt: {
    kind: 'boundary',
    without: { resume: true, sessionId: PINNED_SESSION_ID },
    with: { resume: true, sessionId: PINNED_SESSION_ID, resumeFallbackSystemPrompt: 'parity probe resume fallback system prompt' },
  },
};

const variantKey = (spec: Partial<AgentRunSpec>): string => JSON.stringify(spec);
const fieldVariants = (backend: RunnerId, field: AgentRunSpecField, probe: Extract<SpecFieldProbe, { kind: 'boundary' }>) =>
  backend === 'cursor' && field === 'sessionId'
    ? { kind: 'boundary' as const, without: {}, with: probe.with }
    : probe;

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

// ---- the pending request's lifecycle (hearsay-tools/cezarion#1266, P3–P8) --------------------

type PermissionRequestedEvent = Extract<UiEvent, { type: 'permission.requested' }>;
type StoredEvent = Record<string, unknown>;
const joinedText = (events: readonly StoredEvent[]) => events.filter(event => event.type === 'text').map(event => event.text).join('');
const permissionResolutionsOf = (events: readonly StoredEvent[]) => events.filter(event => event.type === 'permission.resolved');

/** Registers the exemption cell when there is one; P1's shape for every lifecycle criterion. */
function permissionExemption(id: string, backend: RunnerId, scenario: ScenarioName): boolean {
  const exemption = exemptionFor(id, backend);
  if (!exemption) return false;
  it(`${backend} ${id} exemption — ${exemption.reason}`, () => {
    expect(exemption.kind).toBe('scenario-unconstructible');
    expect(HARNESS_ADAPTERS[backend].scenarios[scenario]).toBeUndefined();
  });
  return true;
}

/** A fresh `CEZ_MOCK_RELEASE_FILE` path; the mock waits for the file before its next step. */
async function withRelease<T>(body: (release: string) => Promise<T>): Promise<T> {
  const dir = mkdtempSync(join(tmpdir(), 'cez-permission-'));
  try { return await body(join(dir, 'release')); } finally { rmSync(dir, { recursive: true, force: true }); }
}

function answerThroughRoute(repoRoot: string, store: RunStore, manager: Parameters<typeof createApp>[0]['manager'], runId: string,
  request: StoredEvent, optionId: string): Promise<Response> {
  return apiRequest(createApp({ repoRoot, store, manager, version: 'test' }), `/api/v1/runs/${runId}/permissions`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ requestId: request.requestId, optionId }),
  });
}

const optionPicked = (request: StoredEvent, pick: string) =>
  (request.options as Array<{ id: string; label: string }>).find(option => option.label.toLowerCase().includes(pick))!;

const RETIREMENTS = [
  { id: 'P3', scenario: 'approval-resolved', text: 'Native approval settled without a cockpit answer.' },
  { id: 'P4', scenario: 'approval-turn-end', text: 'Turn ended with the approval still pending.' },
] as const;

export const harnessParityFile = (backend: RunnerId): string => `harness-${backend}-parity.test.ts`;

// Each runner's cells run from their own `harness-<runner>-parity.test.ts`: one file runs serially,
// and every runner's cells in one file outgrew Squeal's 600 s per-file cap (hearsay-tools/cezarion#1288).
// `harness-parity.test.ts` runs the matrix guard and the single-runner cells.
export function describeHarnessParity(scope: RunnerId | 'once'): void {
  const runners: RunnerId[] = scope === 'once' ? [] : [scope];
  // Vitest fails a suite with no test, so a describe that holds only runner cells is not registered
  // in the once file.
  const describeRunners = (name: string, body: () => void): void => {
    if (scope !== 'once') describe(name, body);
  };

  describeRunners('harness parity — seam tier', () => {
    for (const backend of runners) {
      for (const criterion of SEAM_CRITERIA) {
        parityRow(backend, criterion, () => driveSeam(backend, criterion.scenario));
      }
    }
  });

  describeRunners('harness parity — input delivery (#505)', () => {
    for (const backend of runners) {
      it(`${backend} I0 declares its input delivery`, () => {
        expect(['steer', 'boundary']).toContain(inputDeliveryOf(createRunner(backend)).mode);
      });
      for (const criterion of INPUT_CRITERIA) {
        parityRow(backend, criterion, () => observeInput(backend, criterion.scenario, `parity-${criterion.id}`));
      }
      parityRow(backend, FOLLOW_ON_CRITERION, () => observeFollowOn(backend));
    }
  });

  describe('harness parity — recoverable skill diagnostics (hearsay-tools/cezarion#723, hearsay-tools/cezarion#1265)', () => {
    for (const backend of runners) {
      for (const continuation of [false, true]) {
        const id = continuation ? 'R45' : 'R44';
        parityRow<RunObservation>(backend, {
          id, name: `${id} ${continuation ? 'continued' : 'fresh'} skill warnings preserve successful completion`, scenario: 'skill-warning',
          assert: obs => {
            expect(['review', 'done']).toContain(obs.record?.status);
            expect(obs.record?.error).toBeFalsy();
            expect(obs.events.filter(e => e.type === 'error')).toEqual([]);
            for (const root of ['.claude', '.agents']) {
              expect(obs.events).toContainEqual(expect.objectContaining({ type: 'note',
                message: `opencode: optional skill skipped: Failed to parse skill /home/agent/${root}/skills/pen-design/SKILL.md. Check that the skill file and any symlink target are readable; repair or reinstall the skill.`,
              }));
            }
            expect(obs.events).toContainEqual(expect.objectContaining({ type: 'note',
              message: 'opencode: optional skill skipped: /home/agent/.agents/skills/bad4/SKILL.md has invalid YAML frontmatter (unexpected end of the stream within a double quoted scalar at line 6, column 1: ^). Fix the frontmatter between the --- lines, for example by quoting values that contain a colon or a quote, or remove the skill.',
            }));
            expect(obs.events.filter(e => e.type === 'turn.completed').every(e => e.stopReason === 'end_turn')).toBe(true);
            expect(obs.events.some(e => e.type === 'turn.completed')).toBe(true);
          },
        }, () => continuation ? continueDiagnosticRun(backend, promptFor(backend, 'skill-warning'))
          : driveRun(backend, 'skill-warning', record => TERMINAL.includes(record?.status ?? '')));
      }
      it(`${backend} R46 continued provider failures stay fatal and actionable`, async () => {
        const obs = await continueDiagnosticRun(backend, promptFor(backend, 'provider-error'));
        expect(obs.record?.status).toBe('failed');
        expect(obs.record?.error?.trim()).toBeTruthy();
        expect(obs.events).toContainEqual(expect.objectContaining({ type: 'error' }));
      }, 45_000);
    }
    if (scope === 'once') {
      const fatalDetail: Record<string, string> = {
        'unscoped-provider-failure': 'restoring service',
        'scoped-skill-failure': '/skills/required/SKILL.md',
        'scoped-frontmatter-failure': '/skills/bad4/SKILL.md: Failed to parse YAML frontmatter',
      };
      for (const continuation of [false, true]) for (const [scenario, detail] of Object.entries(fatalDetail)) {
        it(`opencode ${continuation ? 'continued' : 'fresh'} ${scenario} remains fatal`, async () => {
          const prompt = `mock:${scenario}`;
          const obs = continuation ? await continueDiagnosticRun('opencode', prompt)
            : await driveRun('opencode', { prompt }, record => TERMINAL.includes(record?.status ?? ''));
          expect(obs.record?.status).toBe('failed');
          expect(obs.record?.error).toContain('provider');
          expect(obs.record?.error).toContain(detail);
        }, 45_000);
      }
    }
  });

  // #779: only the live set is in memory. A finished run is read back from runs.db; Continue loads
  // it into the held set (the `continue` pin), `runContinuation` pins it through the same `activate`
  // helper `execute` uses, and it leaves memory again once the continuation settles.
  describeRunners('harness parity — Continue on a finished run (#779)', () => {
    for (const backend of runners) {
      parityRow<{ pins: string[]; left: boolean; heldWhileContinuing: boolean; leftAgain: boolean; obs: RunObservation }>(backend, {
        id: 'R48', name: 'R48 Continue loads a finished run into memory and lets it go after it settles', scenario: 'done',
        assert: ({ pins, left, heldWhileContinuing, leftAgain, obs }) => {
          expect(left).toBe(true);
          expect(heldWhileContinuing).toBe(true);
          expect(leftAgain).toBe(true);
          // `execute` pins the first execution, then Continue's admission and `runContinuation`.
          expect(pins).toEqual(['active', 'continue', 'active']);
          expect(TERMINAL).toContain(obs.record?.status);
          expect(obs.record?.steps.map((step) => step.id)).toContain('continue-1');
        },
      }, async () => {
        const pins: string[] = [];
        let left = false, heldWhileContinuing = false, leftAgain = false;
        const obs = await driveRun(backend, 'done', record => TERMINAL.includes(record?.status ?? ''), 30_000,
          async ({ store, manager, runId }) => {
            await waitFor(() => !manager.isActive(runId));
            left = await leavesMemory(store, runId);
            expect(manager.continueRun(runId, { text: promptFor(backend, 'done') }).ok).toBe(true);
            heldWhileContinuing = store.heldIds().includes(runId);
            await waitFor(() => TERMINAL.includes(store.getRun(runId)?.status ?? '') && !manager.isActive(runId), 30_000);
            leftAgain = await leavesMemory(store, runId);
          },
          { beforeStart: ({ store }) => {
            const pin = store.pin.bind(store);
            store.pin = (id, holder) => { pins.push(holder); return pin(id, holder); };
          } });
        return { pins, left, heldWhileContinuing, leftAgain, obs };
      });
    }
  });

  // #779: older controllers could cancel a root and leave its Finish intent on the record. Restart
  // repairs that in the delegation sweep, which since #779 reaches only what `open` loads; a finished
  // root the sweep missed would be refused by every Continue ("parent finish is pending") for good.
  describeRunners('harness parity — restart repairs a stale root Finish intent (#779)', () => {
    for (const backend of runners) {
      parityRow<{ repaired: boolean; left: boolean; continued: { ok: boolean; error?: string }; final: RunRecord | undefined }>(backend, {
        id: 'R49', name: "R49 restart clears a cancelled root's stale Finish intent and Continue resumes it", scenario: 'done',
        assert: ({ repaired, left, continued, final }) => {
          expect(continued).toEqual({ ok: true });
          expect(repaired).toBe(true);
          expect(left).toBe(true);
          expect(TERMINAL).toContain(final?.status);
          expect(final?.steps.map((step) => step.id)).toContain('continue-1');
        },
      }, async () => {
        let repaired = false, left = false;
        let continued: { ok: boolean; error?: string } = { ok: false };
        let final: RunRecord | undefined;
        await driveRun(backend, 'done', record => TERMINAL.includes(record?.status ?? ''), 30_000,
          async ({ store, manager, runId }) => {
            await waitFor(() => !manager.isActive(runId));
            const repoRoot = manager['repoRoot'] as string;
            const dataDir = join(repoRoot, '.ai/cezar');
            store.flush();
            const records = readPersistedRuns(dataDir);
            await drainFixtureManagers(repoRoot);
            store.close();
            // The snapshot an older controller left: cancelled, intent still on it, no conversation.
            seedRuns(dataDir, records.map((record) => record.id !== runId ? record : { ...record, status: 'cancelled',
              delegation: { role: 'root', permissions: [], receipts: [], finishRequestedAt: new Date().toISOString() } }));
            const rebooted = RunStore.open(dataDir, { keepLive: true });
            const recovered = createFixtureManager(rebooted, repoRoot);
            try {
              await recovered.recover();
              const root = rebooted.getRun(runId)?.delegation;
              repaired = root?.role === 'root' && root.finishRequestedAt === undefined;
              left = await leavesMemory(rebooted, runId);
              continued = recovered.continueRun(runId, { text: promptFor(backend, 'done') });
              if (continued.ok) await waitFor(() => TERMINAL.includes(rebooted.getRun(runId)?.status ?? '') && !recovered.isActive(runId), 30_000);
              final = structuredClone(rebooted.getRun(runId));
            } finally {
              await drainFixtureManagers(repoRoot);
              rebooted.close();
            }
          });
        return { repaired, left, continued, final };
      });
    }
  });

  // #779 plan step 3: `serve` and a headless `cez run` open one runs.db. A headless open (no
  // keepLive) settled every live row as interrupted and saved it, so the owner's parked run — whose
  // row only the owner's whole-file saves used to put back — loaded `failed` at the next restart and
  // its question could no longer be answered there. A run another live process claims is left alone.
  describeRunners('harness parity — a second process leaves a parked run to its owner (#779)', () => {
    for (const backend of runners) {
      parityRow<{ afterHeadless: string | undefined; afterRestart: string | undefined; answered: { ok: boolean; error?: string }; final: RunRecord | undefined }>(backend, {
        id: 'R50', name: 'R50 a headless open beside the owner leaves its parked run waiting, and a restart still answers it', scenario: 'ask',
        assert: ({ afterHeadless, afterRestart, answered, final }) => {
          expect(afterHeadless).toBe('waiting');
          expect(afterRestart).toBe('waiting');
          expect(answered).toEqual({ ok: true });
          expect(TERMINAL).toContain(final?.status);
        },
      }, async () => {
        let afterHeadless: string | undefined, afterRestart: string | undefined;
        let answered: { ok: boolean; error?: string } = { ok: false };
        let final: RunRecord | undefined;
        await driveRun(backend, 'ask', record => record?.status === 'waiting', 30_000,
          async ({ store, manager, runId }) => {
            const repoRoot = manager['repoRoot'] as string;
            const dataDir = join(repoRoot, '.ai/cezar');
            store.flush();
            // A headless `cez run` opens the project and exits while the owner still runs.
            RunStore.open(dataDir).close();
            afterHeadless = readPersistedRuns(dataDir).find((record) => record.id === runId)?.status;
            // The owner exits: its store closes first, so nothing its manager does from here on
            // reaches runs.db, then its session ends as a dead process's would. A new owner recovers.
            store.close();
            await drainFixtureManagers(repoRoot);
            const rebooted = RunStore.open(dataDir, { keepLive: true });
            const recovered = createFixtureManager(rebooted, repoRoot);
            try {
              await recovered.recover();
              afterRestart = rebooted.getRun(runId)?.status;
              answered = recovered.continueRun(runId, { text: promptFor(backend, 'done') });
              if (answered.ok) await waitFor(() => TERMINAL.includes(rebooted.getRun(runId)?.status ?? '') && !recovered.isActive(runId), 30_000);
              final = structuredClone(rebooted.getRun(runId));
            } finally {
              await drainFixtureManagers(repoRoot);
              rebooted.close();
            }
          });
        return { afterHeadless, afterRestart, answered, final };
      });
    }
  });

  // #779 plan step 3: a control (archive, Stop, Continue…) on a run whose owning process died adopts
  // it first. Adopting settles it — nothing is resumed behind the user's back, whichever runner it
  // used — and Continue is the one control that starts its agent again, on its own session.
  describeRunners('harness parity — adopting a dead owner\'s run mid-turn (#779)', () => {
    for (const backend of runners) {
      parityRow<{ adopted: boolean; startedByAdoption: string[]; settled: RunRecord | undefined; continued: { ok: boolean; error?: string }; startedByContinue: string[]; resumed: RunRecord | undefined }>(backend, {
        id: 'R51', name: 'R51 adopting a dead owner\'s run mid-turn starts no agent, and Continue resumes it', scenario: 'hold',
        assert: ({ adopted, startedByAdoption, settled, continued, startedByContinue, resumed }) => {
          expect(adopted).toBe(true);
          expect(startedByAdoption).toEqual([]);
          expect(settled).toMatchObject({ status: 'failed', error: expect.stringContaining('interrupted') });
          expect(continued).toEqual({ ok: true });
          // Continue resumes the session the dead owner opened, through the one continuation path.
          expect(startedByContinue).toEqual(['runContinuation']);
          expect(resumed?.steps.map((step) => step.id)).toContain('continue-1');
        },
      }, async () => {
        let adopted = false;
        const startedByAdoption: string[] = [], startedByContinue: string[] = [];
        let settled: RunRecord | undefined, resumed: RunRecord | undefined;
        let continued: { ok: boolean; error?: string } = { ok: false };
        // Mid-turn, with the session the owner opened recorded: what a restart would resume.
        await driveRun(backend, 'hold', record => record?.status === 'running' && record.steps.some((step) => step.sessionId !== undefined), 30_000,
          async ({ store, manager, runId }) => {
            const repoRoot = manager['repoRoot'] as string;
            const dataDir = join(repoRoot, '.ai/cezar');
            store.flush();
            // This cockpit was already running beside the owner, which then crashed mid-session.
            const cockpit = RunStore.open(dataDir, { keepLive: true });
            try {
              manager.dispose();
              crashStore(store);
              await drainFixtureManagers(repoRoot);
              const recovered = createFixtureManager(cockpit, repoRoot);
              const engine = recovered as unknown as Record<'execute' | 'runContinuation', (...args: unknown[]) => Promise<unknown>>;
              let adopting = true;
              for (const name of ['execute', 'runContinuation'] as const) {
                const real = engine[name].bind(recovered);
                engine[name] = (...args) => { (adopting ? startedByAdoption : startedByContinue).push(name); return real(...args); };
              }
              adopted = await recovered.adoptOrphanedRun(runId);
              await new Promise((resolve) => setTimeout(resolve, 300));
              adopting = false;
              settled = structuredClone(cockpit.getRun(runId));
              continued = recovered.continueRun(runId, { text: promptFor(backend, 'done') });
              if (continued.ok) await waitFor(() => startedByContinue.length > 0, 30_000);
              resumed = structuredClone(cockpit.getRun(runId));
            } finally {
              await drainFixtureManagers(repoRoot);
              cockpit.close();
            }
          });
        return { adopted, startedByAdoption, settled, continued, startedByContinue, resumed };
      });
    }
  });

  // #779: Stop is the control an adoption carries out itself. The run it stops ends cancelled, as an
  // accepted Stop always reads, rather than interrupted, whichever runner it used; nothing starts.
  describeRunners('harness parity — Stop on a dead owner\'s run mid-turn (#779)', () => {
    for (const backend of runners) {
      parityRow<{ adopted: boolean; started: string[]; stopped: RunRecord | undefined }>(backend, {
        id: 'R52', name: 'R52 Stop on a dead owner\'s run mid-turn ends it cancelled and starts no agent', scenario: 'hold',
        assert: ({ adopted, started, stopped }) => {
          expect(adopted).toBe(true);
          expect(started).toEqual([]);
          expect(stopped).toMatchObject({ status: 'cancelled' });
          expect(stopped?.error).toBeUndefined();
          expect(stopped?.stopping).toBeUndefined();
          expect(stopped?.steps.some((step) => step.status === 'running' || step.status === 'waiting')).toBe(false);
        },
      }, async () => {
        let adopted = false;
        const started: string[] = [];
        let stopped: RunRecord | undefined;
        await driveRun(backend, 'hold', record => record?.status === 'running' && record.steps.some((step) => step.sessionId !== undefined), 30_000,
          async ({ store, manager, runId }) => {
            const repoRoot = manager['repoRoot'] as string;
            const dataDir = join(repoRoot, '.ai/cezar');
            store.flush();
            const cockpit = RunStore.open(dataDir, { keepLive: true });
            try {
              manager.dispose();
              crashStore(store);
              await drainFixtureManagers(repoRoot);
              const recovered = createFixtureManager(cockpit, repoRoot);
              const engine = recovered as unknown as Record<'execute' | 'runContinuation', (...args: unknown[]) => Promise<unknown>>;
              for (const name of ['execute', 'runContinuation'] as const) {
                const real = engine[name].bind(recovered);
                engine[name] = (...args) => { started.push(name); return real(...args); };
              }
              adopted = await recovered.adoptOrphanedRun(runId, { stop: true });
              await new Promise((resolve) => setTimeout(resolve, 300));
              stopped = structuredClone(cockpit.getRun(runId));
            } finally {
              await drainFixtureManagers(repoRoot);
              cockpit.close();
            }
          });
        return { adopted, started, stopped };
      });
    }
  });

  describeRunners('harness parity — seam tier, session control', () => {
    for (const backend of runners) {
      // #708: permission discovery at startup must not break any runner's fresh,
      // resumed or subsequent human turns. Codex's native wire enforces Baseline;
      // other adapters exercise their own unchanged permissions and delivery.
      for (const resume of [false, true]) {
        it(`${backend} S14 ${resume ? 'resumes' : 'starts'} and completes repeated human messages under provider policy`, async () => {
          const obs = await driveSeam(backend, 'baseline', {
            spec: { resume, ...(backend === 'codex' ? { sessionId: 'th_mock_1' } : {}), env: { MOCK_CODEX_REQUIREMENTS: JSON.stringify({ allowedSandboxModes: ['read-only', 'workspace-write'] }), CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } },
            whileOpen: async (session, { v1 }) => {
              for (let count = 1; count <= 3; count++) {
                await waitFor(() => v1.filter(e => e.type === 'turn-end').length >= count);
                if (count < 3) expect(session.sendMessage([{ type: 'text', text: `mock:agent-echo human follow-up ${count}` }])).toBe(true);
              }
            },
          });
          expect(obs.v1.filter(e => e.type === 'turn-end')).toHaveLength(3);
          expect(obs.v1.filter(e => e.type === 'error')).toEqual([]);
          expect(obs.v1.filter(e => e.type === 'note' && e.message.includes('disallowed'))).toEqual([]);
          expect(textEvents(obs.v1).join('')).toContain('human follow-up 2');
        }, 30_000);
      }

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

      // #505: a `steer` runner admits non-human input mid-turn; a `boundary` runner refuses
      // it until the turn ends. Either way the input is eventually read, and a closed session refuses.
      it(`${backend} S12 non-human input follows the runner's declared delivery mode`, async () => {
        const steer = inputDeliveryOf(createRunner(backend)).mode === 'steer';
        await driveSeam(backend, 'hold', {
          whileOpen: async (session, { v1 }) => {
            let busy = session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo retried steering' }]);
            if (steer) {
              // Startup may refuse (codex has no thread yet); the running turn then admits it.
              if (busy === false) await waitFor(() => (busy = session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo retried steering' }])) !== false);
              expect(v1.some(e => e.type === 'turn-end')).toBe(false);
              await expect(busy).resolves.toBeUndefined();
            } else {
              expect(busy).toBe(false);
              await waitFor(() => v1.some(e => e.type === 'turn-end'));
              await expect(session.sendAgentMessage([{ type: 'text', text: 'mock:agent-echo retried steering' }])).resolves.toBeUndefined();
            }
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

  describeRunners('harness parity — run tier', () => {
    for (const backend of runners) {
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
            const obs = await driveRun(backend, criterion.scenario, criterion.settled, criterion.timeoutMs);
            if (exempt) expect(() => criterion.assert(obs)).toThrow();
            else criterion.assert(obs);
          },
          (criterion.timeoutMs ?? 55_000) + 5_000,
        );
      }
    }
  });

  // #121/#401: release native child frames only AFTER the manager has parked.
  // Waiting for the final wire-derived event prevents a green test that returned
  // before the late frames were read. OpenCode discards closed child scopes;
  // its passive usage barrier proves those frames crossed the SSE transport.
  describeRunners('harness parity — late child attention', () => {
    for (const backend of runners) {
      const exempt = exemptionFor('R15', backend);
      if (exempt) {
        it(`${backend} is exempt from R15 — ${exempt.reason}`, () => {
          expect(exempt.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].scenarios['subagent-after-park']).toBeUndefined();
        });
        continue;
      }
      it(`${backend} R15 keeps its monitoring wake after post-park child items`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-post-park-'));
        const release = join(dir, 'release');
        try {
          await driveRun(backend, { prompt: `${promptFor(backend, 'subagent-after-park')} parity-release=${release}` },
            record => record?.status === 'waiting', 30_000,
            async ({ store, runId }) => {
              expect(store.getRun(runId)).toMatchObject({ status: 'waiting' });
              const wake = monitoringWakeOf(store.getRun(runId));
              expect(wake).toBeDefined();
              const before = store.readEvents(runId).length;
              const changes: Array<{ status: string; monitoringWakeAt?: string }> = [];
              const recordChange = (record: NonNullable<RunObservation['record']>) => {
                if (record.id === runId) changes.push({ status: record.status, monitoringWakeAt: monitoringWakeOf(record) });
              };
              store.on('run', recordChange);
              try {
                writeFileSync(release, 'go');
                await waitFor(() => store.readEvents(runId).slice(before).some(event =>
                  backend === 'opencode'
                    ? event.type === 'usage.updated' && (event.usage as { total?: number } | undefined)?.total === 424242
                    : JSON.stringify(event).includes('Post-park child update processed.')));
                expect({ ...store.getRun(runId), monitoringWakeAt: monitoringWakeOf(store.getRun(runId)) }).toMatchObject({ status: 'waiting', monitoringWakeAt: wake });
                for (const change of changes) expect(change).toEqual({ status: 'waiting', monitoringWakeAt: wake });
                const after = store.readEvents(runId).slice(before);
                expect(after.some(event => event.type === 'turn.started')).toBe(false);
                const childItems = (backend === 'opencode' ? store.readEvents(runId).slice(0, before) : after)
                  .filter(event => event.type.startsWith('item.') && event.item && (event.item as { parentItemId?: string }).parentItemId);
                expect(childItems.length).toBeGreaterThan(0);
                if (backend === 'opencode') expect(after.some(event => event.type.startsWith('item.'))).toBe(false);
              } finally { store.off('run', recordChange); }
            });
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 60_000);
    }
  });

  // #961: native hook frames reach the event log and nothing else. A hook that
  // completes after the run parked (Squeal's async `waiter`) must neither wake the
  // run, move its wake time, nor open a turn; the mid-turn hook must not end one.
  describeRunners('harness parity — hooks never move run state', () => {
    for (const backend of runners) {
      const exempt = exemptionFor('R77', backend);
      if (exempt) {
        it(`${backend} is exempt from R77 — ${exempt.reason}`, () => {
          expect(exempt.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].scenarios['hook-after-park']).toBeUndefined();
        });
        continue;
      }
      it(`${backend} R77 keeps a parked run parked through mid-turn and late hook items`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-hook-park-'));
        const release = join(dir, 'release');
        try {
          await driveRun(backend, { prompt: `${promptFor(backend, 'hook-after-park')} parity-release=${release}` },
            record => record?.status === 'waiting', 30_000,
            async ({ store, runId }) => {
              expect(store.getRun(runId)).toMatchObject({ status: 'waiting' });
              const wake = monitoringWakeOf(store.getRun(runId));
              expect(wake).toBeDefined();
              const before = store.readEvents(runId).length;
              const changes: Array<{ status: string; monitoringWakeAt?: string }> = [];
              const recordChange = (record: NonNullable<RunObservation['record']>) => {
                if (record.id === runId) changes.push({ status: record.status, monitoringWakeAt: monitoringWakeOf(record) });
              };
              store.on('run', recordChange);
              try {
                writeFileSync(release, 'go');
                await waitFor(() => store.readEvents(runId).slice(before).some(event => JSON.stringify(event).includes('Late hook processed.')));
                expect({ ...store.getRun(runId), monitoringWakeAt: monitoringWakeOf(store.getRun(runId)) }).toMatchObject({ status: 'waiting', monitoringWakeAt: wake });
                for (const change of changes) expect(change).toEqual({ status: 'waiting', monitoringWakeAt: wake });
                expect(store.readEvents(runId).slice(before).some(event => event.type === 'turn.started')).toBe(false);
                const hooks = store.readEvents(runId)
                  .filter(event => event.type === 'item.completed' && (event.item as { kind?: string } | undefined)?.kind === 'hook')
                  .map(event => (event.item as { id: string }).id);
                expect(hooks).toHaveLength(2);
                expect(new Set(hooks).size).toBe(2);
              } finally { store.off('run', recordChange); }
            });
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 60_000);
    }
  });

  // #134/#401: use native completed-message frames, not an injected UiEvent or
  // fake runner. Current wires couple that snapshot to v1; the named exemptions
  // are pinned in the inverse direction, in addition to the actual park/card.
  describeRunners('harness parity — stored assistant ASK', () => {
    for (const backend of runners) {
      const exempt = exemptionFor('R16', backend);
      it(exempt ? `${backend} is exempt from R16 v2-only ASK — ${exempt.reason}` : `${backend} R16 parks an ASK present only on its stored v2 message`, async () => {
        const seam = await driveSeam(backend, 'ask-snapshot');
        const snapshots = seam.v2.flatMap(event => event.type === 'item.completed'
          && event.item.kind === 'message' && event.item.role === 'assistant' && !event.item.parentItemId
          ? [event.item.text] : []);
        const marker = snapshots.find(text => text.includes('CEZ:ASK'));
        expect(marker).toBeDefined();
        expect(seam.v1.some(event => event.type === 'turn-end')).toBe(true);
        // Assert this exact absent capability, not "some assertion threw": a
        // broken mock or missing v2 snapshot cannot pass as a wire exemption.
        const v1HasMarker = textEvents(seam.v1).some(text => text.includes('CEZ:ASK'));
        if (exempt) {
          expect(exempt.kind).toBe('capability-absent');
          expect(v1HasMarker).toBe(true);
          expect(textEvents(seam.v1).join('\n')).toContain(marker);
        } else {
          expect(v1HasMarker).toBe(false);
        }
        const run = await driveRun(backend, 'ask-snapshot', record => record?.status === 'waiting' || TERMINAL.includes(record?.status ?? ''));
        expect(run.record).toMatchObject({ status: 'waiting', waits: expect.arrayContaining([expect.objectContaining({ kind: 'human', phase: 'open' })]) });
        expect(monitoringWakeOf(run.record)).toBeUndefined();
        expect(askEvents(run)).toHaveLength(1);
        expect(askEvents(run)[0]?.questions).toMatchObject([{ header: 'Library', question: 'Which test library?' }]);
        expect(run.events.some(event => event.type === 'item.completed' && JSON.stringify(event.item).includes('CEZ:ASK'))).toBe(true);
      }, 60_000);
    }
  });

  // #398: a native answer's turn boundary must not ask the human to prompt again.
  // R6 deliberately tests markerless owned-input draining; it cannot prove completion.
  describeRunners('harness parity — answer to completion run tier', () => {
    for (const backend of runners) {
      const exempt = exemptionFor('R26', backend);
      if (exempt) {
        it(`${backend} is exempt from R26 — ${exempt.reason}`, () => {
          expect(exempt.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].askResumeCases).toEqual([]);
          expect(HARNESS_ADAPTERS[backend].scenarios['ask-resume']).toBeUndefined();
        });
        continue;
      }
      for (const ask of HARNESS_ADAPTERS[backend].askResumeCases) {
        it(`${backend} R26 completes after ${ask.kind} without another needs-you park`, async () => {
          await withOwnedInputRun(backend, ask.scenario, async ({ store, manager, runId }) => {
            manager.enqueueOwnedRun(runId);
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            expect(hasPendingAsk(store, runId)).toBe(true);
            // Check the real ask card too: relabelling the question fixture as a
            // plan fixture must not silently remove create_plan coverage.
            const expectedHeader = ask.kind === 'cursor/create_plan' ? 'Plan'
              : ask.kind === 'cursor/ask_question' ? 'Tests' : 'Library';
            expect(store.readEvents(runId).find(event => event.type === 'ask.requested')?.questions)
              .toMatchObject([{ header: expectedHeader }]);
            const statuses: string[] = [];
            const recordStatus = (run: { id: string; status: string }) => {
              if (run.id === runId) statuses.push(run.status);
            };
            store.on('run', recordStatus);
            try {
              expect(manager.sendMessage(runId, [{ type: 'text', text: ask.answer }])).toBe(true);
              expect(store.getRun(runId)?.status).toBe('running');
              // The synchronous delivery checkpoint precedes the unpark.
              statuses.length = 0;
              await waitFor(() => !manager.isActive(runId) || statuses.includes('waiting'));
              expect(statuses).not.toContain('waiting');
              expect(store.getRun(runId)?.status).toBe('done');
              expect(store.getRun(runId)?.steps[0]?.status).toBe('done');
              expect(hasPendingAsk(store, runId)).toBe(false);
            } finally {
              store.off('run', recordStatus);
            }
            const events = store.readEvents(runId);
            expect(events.filter(event => event.type === 'ask.requested')).toHaveLength(1);
            expect(events.filter(event => event.type === 'user-message').map(event => event.text)).toEqual([ask.answer]);
            expect(events.filter(event => event.type === 'human-input-delivered')).toHaveLength(1);
          });
        }, 45_000);
      }
    }
  });

  describeRunners('harness parity — owned input run tier', () => {
    for (const backend of runners) {
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
          const askSeq = store.readEvents(runId).find(e => e.type === 'ask.requested')!.seq;
          expect(manager.steerWorker(runId, second)).toBe('queued');
          await new Promise(resolve => setTimeout(resolve, 150));
          expect(store.getRun(runId)?.status).toBe('waiting');
          // #505: input queued before the session opened steers into the opening turn on a
          // `steer` runner; input accepted while the ask is pending never reaches the session.
          const steer = inputDeliveryOf(createRunner(backend)).mode === 'steer';
          expect(!!store.getRun(runId)?.agentInputs?.find(input => input.id === first.id)?.deliveredAt).toBe(steer);
          expect(store.getRun(runId)?.agentInputs?.find(input => input.id === second.id)?.deliveredAt).toBeUndefined();
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
          // The answer retired this ask; the answered turn's end may raise Cezar's fallback question
          // on the idle worker (hearsay-tools/cezarion#1301), which is a new one.
          expect(store.transcriptFacts(runId).pendingAsk?.seq).not.toBe(askSeq);
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
          const joins = vi.spyOn(TranscriptFactsQueue.prototype, 'join');
          let recovered: Awaited<ReturnType<typeof fixture.restart>>;
          try {
            recovered = await fixture.restart(dataDir => {
              for (const id of [parentRunId, runId]) rmSync(historyPaths(dataDir, id).facts, { force: true });
              joins.mockClear();
            });
            expect(joins).not.toHaveBeenCalled();
          } finally { joins.mockRestore(); }
          const { store, manager } = recovered!;
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
          const askSeq = store.readEvents(runId).find(e => e.type === 'ask.requested')!.seq;
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
          // #505: input can land mid-turn, so delivery no longer implies the answering turn
          // ended; the answer's durable checkpoint is still that turn's end.
          await waitFor(() => recovered.store.readEvents(runId).some(e => e.type === 'human-input-delivered'));
          // The answer retired this ask; the answered turn's end may raise Cezar's fallback question
          // on the idle worker (hearsay-tools/cezarion#1301), which is a new one.
          expect(recovered.store.transcriptFacts(runId).pendingAsk?.seq).not.toBe(askSeq);
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

      it(`${backend} R42 spawns from a skill-driven parent without inheriting its skill on the native wire (#778)`, async () => {
        const name = 'skill-inheritance';
        await withSkillParentRun(backend, probeEnv(name), async ({ store, manager, repoRoot, runId }) => {
          const parentRecording = readRecording(repoRoot, name).join('\n');
          expect(parentRecording).toContain('Selected skill: /parent-skill');
          expect(parentRecording).toContain('PARENT SKILL BODY 778');
          expect(parentRecording).toContain('parent extra');
          await waitFor(() => !manager.isActive(runId), 30_000);
          const worker = store.getRun(runId)!;
          expect(worker.error).toBeUndefined();
          expect(worker.steps.map(step => ({ id: step.id, status: step.status }))).toEqual([{ id: 'task', status: 'done' }]);
          if (worker.delegation?.role !== 'worker') throw new Error('expected worker');
          const childRecording = readRecording(worker.delegation.workspace.path, name).join('\n');
          expect(childRecording).toContain('parent extra');
          expect(childRecording).not.toContain('Selected skill: /parent-skill');
          expect(childRecording).not.toContain('PARENT SKILL BODY 778');
          expect(worker.systemPrompt).toBe('parent extra');
        });
      }, 60_000);

      it(`${backend} R41 runs a --skill worker with the skill in its system prompt and no parent skill (#778)`, async () => {
        const workflowDef = plannedWorkflow(skillTaskSteps('worker-skill').map(step => ({ ...step, runner: backend })));
        const identity: WorkerExecutionIdentity = { kind: 'internal', workflowHash: workerWorkflowHash(workflowDef) };
        const name = 'worker-skill';
        await withOwnedInputRun(backend, 'done', async ({ store, manager, repoRoot, runId, parentRunId }) => {
          const skillsDir = join(repoRoot, '.ai/cezar/skills');
          mkdirSync(skillsDir, { recursive: true });
          writeFileSync(join(skillsDir, 'worker-skill.md'), 'WORKER SKILL BODY');
          store.updateRun(parentRunId, { systemPrompt: 'Selected skill: /parent-skill\nPARENT SKILL BODY\nparent extra' });
          store.updateRun(runId, { systemPrompt: 'parent extra' });
          manager.enqueueOwnedRun(runId);
          await waitFor(() => !manager.isActive(runId), 30_000);
          const run = store.getRun(runId)!;
          expect(run.error).toBeUndefined();
          expect(run.steps.map(step => ({ id: step.id, status: step.status }))).toEqual([{ id: 'task', status: 'done' }]);
          if (run.delegation?.role !== 'worker') throw new Error('expected worker');
          // Read the backend mock's argv/requests and stdin in the worker's own cwd.
          // Normalized events cannot prove that the skill reached the provider.
          const recording = readRecording(run.delegation.workspace.path, name).join('\n');
          expect(recording).toContain('WORKER SKILL BODY');
          expect(recording).toContain('parent extra');
          expect(recording).not.toContain('Selected skill: /parent-skill');
        }, { workflowDef, identity, env: probeEnv(name) });
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
          let unblock: (() => void) | undefined;
          const failAfterEnqueue = ({ event }: { event: { type: string } }) => {
            if (event.type === 'agent-input') unblock ??= blockRunWrites(join(repoRoot, '.ai/cezar'));
          };
          store.on('event', failAfterEnqueue);
          const input = agentInput(parentRunId, 'mock:hold');
          const unmute = muteLockedDatabaseLogs();
          try {
            expect(manager.steerWorker(runId, input)).toBe('queued');
            await waitFor(() => store.readEvents(runId).some(event => event.type === 'error' && String(event.message).includes('agent input delivery checkpoint failed')));
            expect(store.getRun(runId)?.agentInputs).toEqual([input]);
          } finally {
            store.off('event', failAfterEnqueue);
            unblock?.();
            unmute();
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
          // The idle worker's park may already be Cezar's fallback question (hearsay-tools/cezarion#1301):
          // wait for the continuation's own ask.
          const asked = store.readEvents(runId).filter(e => e.type === 'ask.requested').length;
          expect(manager.continueRun(runId, { text: promptFor(backend, 'ask-reply-late') }).ok).toBe(true);
          await waitFor(() => store.readEvents(runId).filter(e => e.type === 'ask.requested').length > asked);
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
          const unblock = blockRunWrites(join(repoRoot, '.ai/cezar'));
          try {
            expect(() => fixture.manager.steerWorker(runId, agentInput(parentRunId))).toThrow();
            expect(fixture.store.getRun(runId)?.agentInputs).toBeUndefined();
            expect(fixture.store.readEvents(runId).filter(e => e.type === 'agent-input')).toEqual([]);
          } finally { unblock(); }
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

  if (scope === 'once') {
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
          // #505: the queued message steers into the answering turn right behind the answer,
          // so it may carry a delivery receipt; the input itself is unchanged and never lost.
          const withoutReceipts = (inputs: AgentInput[] | undefined) => inputs?.map(({ deliveredAt: _d, consumedAt: _c, awaitingRead: _a, ...rest }) => rest);
          expect(withoutReceipts(store.getRun(runId)?.agentInputs)).toEqual([input]);
          // hearsay-tools/cezarion#1260: Finish closes the question it never saw answered, without a
          // delivery; a rejected answer or a Stop leaves it for an explicit answer.
          const askSeq = store.readEvents(runId).find(e => e.type === 'ask.requested')!.seq;
          expect(events.filter(e => e.type === 'human-ask-closed')).toEqual(outcome === 'finished' ? [expect.objectContaining({ askSeq, reason: 'finish' })] : []);
          const recovered = await fixture.restart();
          expect((recovered.manager as unknown as { hasPendingHumanAsk(id: string): boolean }).hasPendingHumanAsk(runId)).toBe(outcome !== 'finished');
          if (outcome !== 'finished') expect(recovered.manager.continueRun(runId).ok).toBe(false);
          expect(withoutReceipts(recovered.store.getRun(runId)?.agentInputs)).toEqual([input]);
        });
      }, 60_000);

      it.each(['fresh', 'continuation'] as const)('%s late reply acknowledgement plus DONE retries accepted input', async mode => {
        await withOwnedInputRun('opencode', 'baseline', async ({ store, manager, runId, parentRunId }) => {
          const prompt = 'mock:ask-reply-late-done';
          if (mode === 'fresh') store.updateRun(runId, { task: prompt });
          manager.enqueueOwnedRun(runId);
          let asked = 0;
          if (mode === 'continuation') {
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            manager.finish(runId);
            await waitFor(() => !manager.isActive(runId));
            // The idle worker's park may already be Cezar's fallback question (hearsay-tools/cezarion#1301).
            asked = store.readEvents(runId).filter(e => e.type === 'ask.requested').length;
            expect(manager.continueRun(runId, { text: prompt }).ok).toBe(true);
          }
          await waitFor(() => store.readEvents(runId).filter(e => e.type === 'ask.requested').length > asked);
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
  }

  if (scope === 'once') {
    describe('harness parity — the matrix itself', () => {
      const allIds = [
        ...SHUTDOWN_CRITERIA.map(c => c.id),
    ...MODEL_REFUSAL_CRITERIA.map(c => c.id),
        ...PERMISSION_CRITERIA.map(c => c.id),
        ...MONITORING_TURN_CRITERIA.map(c => c.id),
        ...MONITORING_ACK_CRITERIA.map(c => c.id),
        ...MONITORING_ORDER_CRITERIA.map(c => c.id),
        ...WAIT_CRITERIA.map(c => c.id),
        ...WORKFLOW_ASK_CRITERIA.map(c => c.id),
        ...FOLLOWUP_CRITERIA.map(c => c.id),
        ...ANSWER_DELIVERY_CRITERIA.map(c => c.id),
        ...SKILL_RESUME_CRITERIA.map(c => c.id),
        ...SKILL_PROVISION_CRITERIA.map(c => c.id),
        ...WORKTREE_SETUP_CRITERIA.map(c => c.id),
        ...AUTONOMOUS_CRITERIA.map(c => c.id),
        ...FINAL_MESSAGE_CRITERIA.map(c => c.id),
        ...WORKER_PROGRESS_WAIT_CRITERIA.map(c => c.id),
        ...NO_PROGRESS_CRITERIA.map(c => c.id),
        ...WORKFLOW_TIMEOUT_CRITERIA.map((c) => c.id),
        ...SEAM_CRITERIA.map((c) => c.id),
        ...INPUT_CRITERIA.map((c) => c.id),
        FOLLOW_ON_CRITERION.id,
        ...CONTROL_CRITERIA.map((c) => c.id),
        ...RUN_CRITERIA.map((c) => c.id),
      ];
      const scenarioOf = (id: string): ScenarioName => {
        const permission = PERMISSION_CRITERIA.find(c => c.id === id);
        if (permission) return permission.scenario;
        const refusal = MODEL_REFUSAL_CRITERIA.find(c => c.id === id);
    if (refusal) return refusal.scenario;
    const shutdown = SHUTDOWN_CRITERIA.find(c => c.id === id);
        if (shutdown) return shutdown.scenario;
        const monitor = [...MONITORING_TURN_CRITERIA, ...MONITORING_ACK_CRITERIA, ...MONITORING_ORDER_CRITERIA].find(c => c.id === id);
        if (monitor) return monitor.scenario;
        const wait = WAIT_CRITERIA.find(c => c.id === id);
        if (wait) return wait.scenario;
        const ask = WORKFLOW_ASK_CRITERIA.find(c => c.id === id);
        if (ask) return ask.scenario;
        const followup = FOLLOWUP_CRITERIA.find(c => c.id === id);
        if (followup) return followup.scenario;
        const answerDelivery = ANSWER_DELIVERY_CRITERIA.find(c => c.id === id);
        if (answerDelivery) return answerDelivery.scenario;
        const skillResume = SKILL_RESUME_CRITERIA.find(c => c.id === id);
        if (skillResume) return skillResume.scenario;
        const skillProvision = SKILL_PROVISION_CRITERIA.find(c => c.id === id);
        if (skillProvision) return skillProvision.scenario;
        const worktreeSetup = WORKTREE_SETUP_CRITERIA.find(c => c.id === id);
        if (worktreeSetup) return worktreeSetup.scenario;
        const autonomous = AUTONOMOUS_CRITERIA.find(c => c.id === id);
        if (autonomous) return autonomous.scenario;
        const workerProgress = WORKER_PROGRESS_WAIT_CRITERIA.find(c => c.id === id);
        if (workerProgress) return workerProgress.scenario;
        const finalMessage = FINAL_MESSAGE_CRITERIA.find(c => c.id === id);
        if (finalMessage) return finalMessage.scenario;
        const inactivity = NO_PROGRESS_CRITERIA.find(c => c.id === id);
        if (inactivity) return inactivity.scenario;
        const timeout = WORKFLOW_TIMEOUT_CRITERIA.find(c => c.id === id);
        if (timeout) return timeout.scenario;
        const seam = SEAM_CRITERIA.find((c) => c.id === id) ?? INPUT_CRITERIA.find((c) => c.id === id) ?? (id === FOLLOW_ON_CRITERION.id ? FOLLOW_ON_CRITERION : undefined);
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
            const declared = HARNESS_ADAPTERS[backend]?.scenarios[scenarioOf(id)] !== undefined;
            if (!declared && !exemptionFor(id, backend)) missing.push(`${backend}/${id}`);
          }
        }
        expect(missing).toEqual([]);
      });

      it('R26 enumerates each runner ask path with a live prompt or a named exemption', () => {
        // Independent wire inventory: deleting an adapter variant must fail this
        // guard, even when another ask kind still exercises the same backend.
        const expectedKinds: Record<RunnerId, readonly string[]> = {
          claude: ['CEZ:ASK'],
          codex: ['item/tool/requestUserInput'],
          opencode: ['question.asked'],
          pi: ['CEZ:ASK'],
          cursor: ['CEZ:ASK'],
          omp: ['CEZ:ASK'],
        };
        for (const backend of RUNNER_IDS) {
          const cases = HARNESS_ADAPTERS[backend]?.askResumeCases;
          expect(cases).toBeDefined();
          if (exemptionFor('R26', backend)) continue;
          expect(cases.map(ask => ask.kind)).toEqual(expectedKinds[backend]);
          expect(cases.length).toBeGreaterThan(0);
          expect(new Set(cases.map(ask => ask.kind)).size).toBe(cases.length);
          expect(cases.some(ask => ask.scenario === 'ask-resume')).toBe(true);
          for (const ask of cases) {
            expect(ask.kind.trim()).not.toBe('');
            expect(ask.answer.trim()).not.toBe('');
            expect(promptFor(backend, ask.scenario).trim()).not.toBe('');
          }
        }
      });

      it('protocol and matrix prose name runners without a counted roster', () => {
        const countedRunners = /\b(?:[2-9]\d*|1\d+|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s+(?:(?:real|offline|native|supported|existing|unrelated|passing|per-runner|wire)\s+)*(?:runners?|backends?|mocks?|mock selectors|test files)\b/gi;
        for (const path of ['AGENT_PROTOCOL.md', '.ai/specs/2026-09-04-harness-parity-matrix.md',
          'packages/cezar/src/core/harness-parity.test.ts', 'packages/cezar/src/core/harness-parity-cells.testkit.ts',
          'packages/cezar/src/core/harness-parity.testkit.ts']) {
          const source = readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
          expect(source.match(countedRunners) ?? [], path).toEqual([]);
        }
      });

      it('runs every runner\'s cells from its own file', () => {
        for (const backend of RUNNER_IDS) expect(existsSync(new URL(`./${harnessParityFile(backend)}`, import.meta.url)), backend).toBe(true);
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
        for (const url of [new URL(import.meta.url), new URL('../workflows/worker-parent-attention.test.ts', import.meta.url), new URL('../workflows/monitoring-turn.test.ts', import.meta.url), new URL('./skill-resume-parity.test.ts', import.meta.url)]) {
          const source = readFileSync(url, 'utf8');
          expect(source).not.toMatch(/\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(/);
        }
      });
    });
  }

  // D1: inspect the actual argv/RPC/HTTP boundary of the real runners. Expectations
  // come from installed CLI help, generated Codex schemas and OpenCode /doc; see §7.
  describe('harness parity — D1 governed native delegation', () => {
    for (const backend of runners) {
      for (const resume of [false, true]) {
        it(`${backend} restricts verified native delegation on ${resume ? 'Continue' : 'start'} without widening ordinary settings`, async () => {
          const dir = mkdtempSync(join(tmpdir(), 'cez-native-wire-'));
          try {
            const launches = [];
            for (const restricted of [false, true]) {
              const path = join(dir, `${restricted}.ndjson`);
              if (backend === 'opencode' && resume) seedOpencodeMockSession(path);
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
              const names = backend === 'claude' ? 'Agent,Task,Workflow' : 'subagent';
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
            } else if (backend === 'omp') {
              // A static `--config` overlay denies `task`; the tool list was already narrowed by
              // the bash allowlist, so nothing else in the argv moves.
              const args = restricted![0] as string[];
              const index = args.indexOf('--config');
              expect(index).toBeGreaterThanOrEqual(0);
              expect(args[index + 1]).toMatch(/omp-restrict-delegation\.yml$/);
              expect(args.filter((_, i) => i !== index && i !== index + 1)).toEqual(ordinary![0]);
              expect(ordinary![0]).not.toContain('--config');
              // The `task` strip from the default tool list is proven in omp-runner.test.ts (D1).
            } else if (backend === 'cursor') {
              const normal: string[] = ordinary![0];
              const controlled: string[] = restricted![0];
              expect(normal).not.toContain('--allowed-tools');
              const index = controlled.indexOf('--allowed-tools');
              expect(index).toBeGreaterThanOrEqual(0);
              expect(controlled[index + 1]).toContain('read_tool_call');
              expect(controlled[index + 1]).not.toContain('task_tool_call');
              expect(controlled.filter((_, i) => i !== index && i !== index + 1)).toEqual(normal);
              expect(normal.includes('--resume')).toBe(resume);
            } else if (resume) {
              const sessionUrl = `/session/${PINNED_SESSION_ID}`;
              const deny = { permission: [{ permission: 'task', pattern: '*', action: 'deny' }] };
              for (const rows of [ordinary, restricted]) {
                expect(rows!.some(row => row.method === 'GET' && row.url === sessionUrl)).toBe(true);
                expect(rows!.filter(row => row.method === 'POST' && row.url === '/session')).toEqual([]);
              }
              expect(restricted!.find(row => row.method === 'PATCH' && row.url === sessionUrl)?.body).toEqual(deny);
              expect(ordinary!.filter(row => row.method === 'PATCH')).toEqual([]);
              expect(restricted!.filter(row => row.url.includes('prompt_async')).every(row => row.body.tools === undefined)).toBe(true);
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

    if (scope === 'once') {
      it('opencode restricted Continue does not PATCH when the session already denies task', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-native-wire-sticky-'));
        const path = join(dir, 'wire.ndjson');
        try {
          seedOpencodeMockSession(path, {
            permission: [{ permission: 'task', pattern: '*', action: 'deny' }],
          });
          const obs = await driveSeam('opencode', 'baseline', { spec: {
            cwd: dir, resume: true, restrictNativeDelegation: true,
            env: { CEZ_MOCK_ARGS_FILE: path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' },
          } });
          expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
          const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
          expect(rows.some(row => row.method === 'GET' && row.url === `/session/${PINNED_SESSION_ID}`)).toBe(true);
          expect(rows.filter(row => row.method === 'POST' && row.url === '/session')).toEqual([]);
          expect(rows.filter(row => row.method === 'PATCH')).toEqual([]);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 45000);

      it('opencode restricted Continue POSTs the deny when GET /session/{id} 404s', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-native-wire-fallback-'));
        const path = join(dir, 'wire.ndjson');
        try {
          const obs = await driveSeam('opencode', 'baseline', { spec: {
            cwd: dir, resume: true, restrictNativeDelegation: true,
            env: { CEZ_MOCK_ARGS_FILE: path, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' },
          } });
          expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
          const rows = readFileSync(path, 'utf8').trim().split('\n').map(line => JSON.parse(line));
          expect(rows.some(row => row.method === 'GET' && row.url === `/session/${PINNED_SESSION_ID}`)).toBe(true);
          expect(rows.find(row => row.method === 'POST' && row.url === '/session')?.body.permission).toEqual(
            [{ permission: 'task', pattern: '*', action: 'deny' }],
          );
          expect(rows.filter(row => row.method === 'PATCH')).toEqual([]);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 45000);
    }
  });

  // D2 (hearsay-tools/cezarion#1284): a restricted session's forked skill starts no native
  // subagent. Only Claude's wire constructs the scenario, and Claude 2.1.303 starts the fork
  // whatever its deny rules say (AGENT_PROTOCOL.md, Claude forked-skill gap), so its row is
  // pinned the other way round: the day Claude can block forks, it fails and must go live.
  describeRunners('harness parity — D2 forked skill in a restricted session', () => {
    for (const backend of runners) {
      const exempt = exemptionFor('D2', backend);
      if (exempt?.kind === 'scenario-unconstructible') {
        it(`${backend} is exempt from D2 — ${exempt.reason}`, () => {
          expect(HARNESS_ADAPTERS[backend].scenarios['forked-skill']).toBeUndefined();
        });
        continue;
      }
      it(exempt ? `${backend} is exempt from D2 — ${exempt.reason}` : `${backend} D2 starts no native subagent from a forked skill in a restricted session`, async () => {
        const dir = mkdtempSync(join(tmpdir(), 'cez-forked-skill-'));
        const argsFile = join(dir, 'args.ndjson');
        try {
          const obs = await driveSeam(backend, 'forked-skill', { spec: {
            restrictNativeDelegation: true,
            env: { CEZ_MOCK_ARGS_FILE: argsFile, CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' },
          } });
          expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
          expect(obs.v1.at(-1)?.type).toBe('done');
          const items = obs.v2.flatMap(event => event.type === 'item.started' || event.type === 'item.completed' ? [event.item] : []);
          const nested = items.filter(item => item.parentItemId !== undefined);
          if (!exempt) {
            expect(nested).toEqual([]);
            return;
          }
          // The exact absent capability, not "some assertion threw": the session was
          // restricted, and the forked child still ran nested under the Skill call.
          expect(exempt.kind).toBe('capability-absent');
          const args = JSON.parse(readFileSync(argsFile, 'utf8').trim().split('\n')[0]!) as string[];
          expect(args).toContain('--disallowedTools');
          expect(args[args.indexOf('--disallowedTools') + 1]).toBe('Agent,Task,Workflow');
          const skill = items.find(item => item.kind === 'tool' && item.name === 'Skill');
          expect(skill).toBeDefined();
          expect(new Set(nested.map(item => item.parentItemId))).toEqual(new Set([skill!.id]));
          expect(nested.some(item => item.kind === 'tool' && item.name === 'Bash' && item.status === 'completed')).toBe(true);
        } finally { rmSync(dir, { recursive: true, force: true }); }
      }, 45_000);
    }
  });

  describe('harness parity — AgentRunSpec support declarations', () => {
    if (scope === 'once') {
      it('every runner id builds its own runner, declaring every AgentRunSpec field with a reason', () => {
        for (const backend of RUNNER_IDS) {
          const runner = createRunner(backend);
          // A new RUNNER_IDS member with no factory case falls through to claude; that is not a declaration.
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
    }

    for (const backend of runners) {
      describe(`${backend} declarations against its boundary`, () => {
        let dir = '';
        const recordings = new Map<string, string[]>();
        let deadlineErrors: string[] = [];

        beforeAll(async () => {
          dir = mkdtempSync(join(tmpdir(), `cez-spec-support-${backend}-`));
          const variants = new Map<string, Partial<AgentRunSpec>>();
          for (const [field, entry] of Object.entries(SPEC_FIELD_PROBES) as [AgentRunSpecField, SpecFieldProbe][]) {
            const probe = entry.kind === 'boundary' ? fieldVariants(backend, field, entry) : entry;
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
              const variants = fieldVariants(backend, field, probe);
              const without = recordings.get(variantKey(variants.without));
              const withField = recordings.get(variantKey(variants.with));
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

  // #781: the `cezarTools` cell, live. One shared cezar tool list feeds every
  // runner's own wire (Claude's MCP config and generated allow-list entry, Codex
  // and Cursor forwarded env, OpenCode's runtime config, Pi's extension and tool
  // admission), and each mock lists the tools through the real bundled adapter.
  // `cezar_preview_serve` and `cezar_preview_stop` are listed under `CEZ_PREVIEW=1` exactly, and
  // `cezar_schedule_task` and `cezar_scheduled_tasks` under `CEZ_AUTOMATIONS=1` (hearsay-tools/cezarion#1465).
  // Each cell turns both opt-ins on or off together; tools.ts's unit tests pin each flag alone.
  describeRunners('harness parity — cezarTools list behind CEZ_PREVIEW', () => {
    const wait = { id: '11111111-1111-4111-8111-111111111111', generation: 'gen', turnId: 'turn', timeoutSeconds: 1800, prUrl: 'https://github.com/owner/repo/pull/1', repository: 'owner/repo', prNumber: 1, headSha: 'a'.repeat(40), registeredAt: '2026-09-22T00:00:00.000Z', deadline: '2026-09-22T00:30:00.000Z', phase: 'registered' as const };
    // hearsay-tools/cezarion#1305: pi also runs the default list, which admits the tools through no allowlist.
    const lists = (backend: RunnerId) => [
      { label: '', allowedTools: ['Read'] },
      ...(backend === 'pi' ? [{ label: ' on the default tool list', allowedTools: allowedToolsForStep(undefined, 'pi') }] : []),
    ];
    for (const backend of runners) for (const enabled of [true, false]) for (const { label, allowedTools } of lists(backend)) {
      it(`${backend} R35 ${enabled ? 'exposes' : 'hides'} preview serve and stop with CEZ_PREVIEW ${enabled ? 'on' : 'off'} and the schedule tools with CEZ_AUTOMATIONS ${enabled ? 'on' : 'off'}${label}`, async () => {
        vi.stubEnv('CEZ_PREVIEW', enabled ? '1' : '');
        vi.stubEnv('CEZ_AUTOMATIONS', enabled ? '1' : '');
        const { CiToolController } = await import('../ci-wait/controller.ts');
        const controller = await CiToolController.start();
        const dir = mkdtempSync(join(tmpdir(), 'cez-tools-list-'));
        try {
          const session = controller.provision({ registerWait: async () => ({ answer: { ok: true, wait_id: wait.id, kind: 'ci', deadline: wait.deadline, open_waits: [] }, wait: { ...wait, kind: 'ci', source: 'agent', via: 'cezar_wait', phase: 'open' } }), ask: async () => ({ ok: false, code: 'unavailable', message: 'none' }), cancelWait: async () => ({ cancelled: false, code: 'not_found', message: 'none' }), finishTurn: async () => ({ ok: true, finishes: 'at_turn_end', open_waits: [] }) });
          const obs = await driveSeam(backend, 'baseline', { spec: { cezarTools: session.descriptor, allowedTools, env: { ...session.env, CEZ_MOCK_ARGS_FILE: join(dir, 'wire'), CEZ_MOCK_CI_PR: wait.prUrl, CEZ_MOCK_CI_RESULT: join(dir, 'result'), CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
          expect(obs.v1.filter((event) => event.type === 'error')).toEqual([]);
          const waits = ['cezar_wait', 'cezar_ask', 'cezar_cancel_wait', 'cezar_done'];
          const expected = enabled ? [...waits, 'cezar_preview_serve', 'cezar_preview_stop', 'cezar_schedule_task', 'cezar_scheduled_tasks'] : waits;
          expect(JSON.parse(readFileSync(join(dir, 'result'), 'utf8')).names).toEqual(expected);
          const argv: string[] = JSON.parse(readFileSync(join(dir, 'wire'), 'utf8').trim().split('\n')[0]!);
          if (backend === 'claude') {
            const allowed = argv[argv.indexOf('--allowedTools') + 1]!.split(',');
            expect(allowed.filter((name) => name.startsWith(`mcp__${session.descriptor.name}__`))).toEqual(expected.map((name) => `mcp__${session.descriptor.name}__${name}`));
          }
          // hearsay-tools/cezarion#1305: pi's default list sends no allowlist, so the extension's tools stay active.
          if (backend === 'pi' && !argv.includes('--tools')) expect(argv).toContain('--no-builtin-tools');
          else if (backend === 'pi' || backend === 'omp') expect(argv[argv.indexOf('--tools') + 1]!.split(',').filter((name) => name.startsWith('cezar_'))).toEqual(expected);
        } finally {
          vi.unstubAllEnvs();
          await controller.close();
          rmSync(dir, { recursive: true, force: true });
        }
      }, 30_000);
    }
  });

  // #661: native runner completion precedes the real durable cleanup checkpoint.
  // Every adapter supplies baseline; there is no wire exemption for this path.
  describeRunners('harness parity — terminal cleanup reconciliation', () => {
    for (const backend of runners) {
      for (const enabled of [true, false]) {
        const criterion = enabled ? 'R20' : 'R21';
        it(`${backend} ${criterion} cleanup checkpoints ${enabled ? 'read only their family' : 'skip reconciliation with delegation disabled'}`, async () => {
          vi.stubEnv('CEZ_DELEGATION', '1');
          try {
            await withOwnedInputRun(backend, 'baseline', async ({ store, manager, runId, repoRoot }) => {
              manager.enqueueOwnedRun(runId);
              await waitFor(() => store.getRun(runId)?.status === 'waiting');
              if (!enabled) vi.stubEnv('CEZ_DELEGATION', '0');
              expect(manager.finish(runId)).toBe(true);
              await waitFor(() => !manager.isActive(runId) && store.readWorkerExecution(runId)?.phase === 'complete');
              const unrelated = seedSettledFamily(store, repoRoot);
              const reads = vi.spyOn(store, 'readEvents');
              const reconcile = vi.spyOn(manager, 'reconcileWorkerWaits');
              try {
                cleanupCheckpoint(store, runId);
                expect(store.readWorkerExecution(runId)?.phase).toBe('complete');
                expect(reads.mock.calls.map(([id]) => id)).not.toContain(unrelated.parentId);
                expect(reads.mock.calls.map(([id]) => id)).not.toContain(unrelated.workerId);
                if (!enabled) { expect(reconcile).not.toHaveBeenCalled(); expect(reads).not.toHaveBeenCalled(); }
              } finally { reads.mockRestore(); reconcile.mockRestore(); }
            });
          } finally { vi.unstubAllEnvs(); }
        }, 60_000);
      }
    }
  });

  // #473: successful settlement closes intermediate Continues left by idle close.
  describeRunners('harness parity — multi-Continue settlement', () => {
    for (const backend of runners) {
      for (const status of ['done', 'review', 'cancelled'] as const) {
        const criterion = status === 'done' ? 'R28' : status === 'review' ? 'R29' : 'R30';
        it(`${backend} ${criterion} closes every live step when multi-Continue finishes as ${status}`, async () => {
          vi.stubEnv('CEZ_REVIEW_GATE', status === 'review' ? '1' : '0');
          try {
            await driveRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
              async ({ store, manager, runId }) => {
                const internal = manager as unknown as {
                  repoRoot: string;
                  active: Map<string, { idleTimer?: NodeJS.Timeout }>;
                };
                for (let turn = 0; turn < 2; turn++) {
                  const timer = internal.active.get(runId)?.idleTimer as NodeJS.Timeout & { _onTimeout(): void };
                  expect(timer).toBeDefined();
                  timer._onTimeout();
                  await waitFor(() => !manager.isActive(runId));
                  // Idle close remains a park, not successful task completion.
                  expect(store.getRun(runId)?.status).toBe('waiting');
                  expect(store.getRun(runId)?.steps.every(step => step.status === 'waiting' && !step.finishedAt)).toBe(true);
                  expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
                  await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                }
                const before = store.getRun(runId)!;
                expect(before.steps.map(step => step.id)).toEqual(['task', 'continue-1', 'continue-2']);
                // driveRun uses an in-place repository; expose that real diff to the gate.
                store.updateRun(runId, { worktreePath: internal.repoRoot, baseBranch: 'main' });
                writeFileSync(join(internal.repoRoot, 'a.txt'), 'changed for review\n');
                if (status === 'cancelled') {
                  let release!: (diff: string) => void;
                  const diff = vi.spyOn(gitWorktree, 'worktreeDiff').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
                  try {
                    expect(manager.finish(runId)).toBe(true);
                    await waitFor(() => release !== undefined);
                    expect(manager.cancel(runId)).toBe(true);
                  } finally {
                    release?.('changed');
                    diff.mockRestore();
                  }
                } else expect(manager.finish(runId)).toBe(true);
                await waitFor(() => !manager.isActive(runId));
                const completed = store.getRun(runId)!;
                expect(completed.status).toBe(status);
                expect(completed.steps.map(step => step.status)).toEqual(['done', status === 'cancelled' ? 'cancelled' : 'done', 'done']);
                for (const step of completed.steps) expect(step.finishedAt).toBeDefined();
                expect(completed.currentStepId).toBeUndefined();
              });
          } finally { vi.unstubAllEnvs(); }
        }, 60_000);
      }
    }
  });

  describeRunners('harness parity — inactive Finish superseded by Continue', () => {
    for (const backend of runners) {
      for (const queued of [false, true]) {
        const criterion = queued ? 'R34' : 'R33';
        it(`${backend} ${criterion} rejects stale Finish after Continue ${queued ? 'queues' : 'starts and idle-closes'}`, async () => {
          await driveRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
            async ({ store, manager, runId }) => {
              const internal = manager as unknown as {
                repoRoot: string;
                active: Map<string, { idleTimer?: NodeJS.Timeout }>;
                semaphore: { busy(): number };
                settleSuccess(id: string, durable?: boolean): Promise<void>;
              };
              const idleClose = async () => {
                const timer = internal.active.get(runId)?.idleTimer as NodeJS.Timeout & { _onTimeout(): void };
                expect(timer).toBeDefined();
                timer._onTimeout();
                await waitFor(() => !manager.isActive(runId));
                expect(store.getRun(runId)?.status).toBe('waiting');
              };
              await idleClose();
              store.updateRun(runId, { worktreePath: internal.repoRoot, baseBranch: 'main' });
              let release: ((diff: string) => void) | undefined;
              const diff = vi.spyOn(gitWorktree, 'worktreeDiff').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
              // Observe the real fire-and-forget settlement, including its config I/O.
              const settlement = vi.spyOn(internal, 'settleSuccess');
              // Hold only scheduler capacity; the run and its idle close use native wires.
              const capacity = queued ? vi.spyOn(internal.semaphore, 'busy').mockReturnValue(Number.MAX_SAFE_INTEGER) : undefined;
              try {
                expect(manager.finish(runId)).toBe(true);
                await waitFor(() => release !== undefined);
                const pending = settlement.mock.results[0]!.value as Promise<void>;
                expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }, queued).ok).toBe(true);
                if (!queued) {
                  await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                  await idleClose();
                }
                expect(internal.active.get(runId)).toBeUndefined();
                const before = structuredClone(store.getRun(runId)!);
                expect(before.status).toBe(queued ? 'queued' : 'waiting');
                expect(before.steps.at(-1)).toMatchObject({ id: 'continue-1', status: queued ? 'pending' : 'waiting' });
                release!('changed');
                await pending;
                const after = store.getRun(runId)!;
                expect(after.status).toBe(before.status);
                expect(after.steps).toEqual(before.steps);
                expect(after.finishedAt).toBeUndefined();
                expect(store.readEvents(runId).some(event => event.type === 'lifecycle' &&
                  (event.message === 'run finished' || (typeof event.message === 'string' && event.message.startsWith('changes ready for review'))))).toBe(false);
              } finally {
                release?.('changed');
                await Promise.allSettled(settlement.mock.results.map(result => result.value));
                diff.mockRestore();
                settlement.mockRestore();
                // Cancel queued work before restoring capacity so teardown cannot launch it.
                manager.cancel(runId);
                capacity?.mockRestore();
              }
            });
        }, 60_000);
      }
    }
  });

  describeRunners('harness parity — accepted Finish across disposal', () => {
    for (const backend of runners) {
      for (const continuation of [false, true]) {
        const criterion = continuation ? 'R32' : 'R31';
        it(`${backend} ${criterion} honors ${continuation ? 'Continue' : 'fresh'} Finish when disposed during diff I/O`, async () => {
          vi.stubEnv('CEZ_REVIEW_GATE', '0');
          try {
            await driveRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
              async ({ store, manager, runId }) => {
                const internal = manager as unknown as {
                  repoRoot: string;
                  active: Map<string, { idleTimer?: NodeJS.Timeout }>;
                  dropActive(id: string): void;
                };
                if (continuation) {
                  const timer = internal.active.get(runId)?.idleTimer as NodeJS.Timeout & { _onTimeout(): void };
                  expect(timer).toBeDefined();
                  timer._onTimeout();
                  await waitFor(() => !manager.isActive(runId));
                  expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
                  await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                }
                store.updateRun(runId, { worktreePath: internal.repoRoot, baseBranch: 'main' });
                let release: ((diff: string) => void) | undefined;
                const diff = vi.spyOn(gitWorktree, 'worktreeDiff').mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
                // dispose clears active immediately. Observe actual engine cleanup,
                // so assertions and fixture deletion wait for the settlement callback.
                let cleanedUp = false;
                const dropActive = internal.dropActive.bind(manager);
                const cleanup = vi.spyOn(internal, 'dropActive').mockImplementation(id => {
                  dropActive(id);
                  if (id === runId) cleanedUp = true;
                });
                try {
                  expect(manager.finish(runId)).toBe(true);
                  await waitFor(() => release !== undefined);
                  manager.dispose();
                  release!('changed');
                  await waitFor(() => cleanedUp);
                  const completed = store.getRun(runId)!;
                  expect(completed.status).toBe('done');
                  expect(completed.finishedAt).toBeDefined();
                  expect(completed.currentStepId).toBeUndefined();
                  expect(completed.steps).toHaveLength(continuation ? 2 : 1);
                  for (const step of completed.steps) expect(step).toMatchObject({ status: 'done', finishedAt: expect.any(String) });
                } finally {
                  release?.('changed');
                  diff.mockRestore();
                  cleanup.mockRestore();
                }
              });
          } finally { vi.unstubAllEnvs(); }
        }, 60_000);
      }
    }
  });

  // #515: task scratch outlives a process, on both workflow and Continue paths.
  describeRunners('harness parity — live task scratch', () => {
    for (const backend of runners) {
      it(`${backend} R22 retains scratch across idle close and Continue, then reaps on finish`, async () => {
        await driveRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
          async ({ store, manager, runId }) => {
            const internal = manager as unknown as {
              dataDir: string;
              active: Map<string, { idleTimer?: NodeJS.Timeout }>;
            };
            const original = resolveAgentTmpDir(internal.dataDir, runId);
            const dirs = new Set([agentTmpDir(internal.dataDir, runId), original]);
            const nextRoot = mkdtempSync(join(realpathSync('/tmp'), 'cez-next-'));
            const keys = ['TMPDIR', 'TEMP', 'TMP'] as const;
            const previous = keys.map(key => process.env[key]);
            try {
              for (const key of keys) process.env[key] = nextRoot;
              for (const dir of dirs) {
                mkdirSync(dir, { recursive: true });
                writeFileSync(join(dir, 'notes'), 'keep across turns');
              }
              for (let turn = 0; turn < 2; turn++) {
                const timer = internal.active.get(runId)?.idleTimer as NodeJS.Timeout & { _onTimeout(): void };
                expect(timer).toBeDefined();
                timer._onTimeout();
                await waitFor(() => !manager.isActive(runId));
                expect(store.getRun(runId)?.status).toBe('waiting');
                for (const dir of dirs) expect(readFileSync(join(dir, 'notes'), 'utf8')).toBe('keep across turns');
                expect(resolveAgentTmpDir(internal.dataDir, runId)).toBe(original);
                expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
                await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                for (const dir of dirs) expect(readFileSync(join(dir, 'notes'), 'utf8')).toBe('keep across turns');
              }
              expect(manager.finish(runId)).toBe(true);
              await waitFor(() => !manager.isActive(runId));
              expect(['done', 'review']).toContain(store.getRun(runId)?.status);
              for (const dir of dirs) expect(existsSync(dir)).toBe(false);
            } finally {
              keys.forEach((key, index) => {
                if (previous[index] === undefined) delete process.env[key];
                else process.env[key] = previous[index];
              });
              rmSync(nextRoot, { recursive: true, force: true });
            }
          });
      }, 60_000);

      it(`${backend} R23 retains pending-question worker scratch after its process completes`, async () => {
        await withOwnedInputRun(backend, 'ask', async ({ manager, store, runId, repoRoot }) => {
          manager.enqueueOwnedRun(runId);
          await waitFor(() => store.readEvents(runId).some(event => event.type === 'ask.requested'));
          const scratch = resolveAgentTmpDir(join(repoRoot, '.ai/cezar'), runId);
          writeFileSync(join(scratch, 'notes'), 'pending answer');
          // Native asks can hold the turn open without an idle timer. Close the
          // actual session through the same idle-close state, after its native ask.
          const internal = manager as unknown as {
            active: Map<string, { idleClosed: boolean; session: import('./agent-runner.ts').AgentSession }>;
          };
          const state = internal.active.get(runId)!;
          state.idleClosed = true;
          state.session.end();
          await waitFor(() => !manager.isActive(runId));
          expect(store.getRun(runId)?.status).toBe('waiting');
          expect(store.readWorkerExecution(runId)?.phase).toBe('complete');
          expect(readFileSync(join(scratch, 'notes'), 'utf8')).toBe('pending answer');
        });
      }, 60_000);
    }
  });

  // #399 incident: issue Agent context, run 3a3c1ffa (original history unavailable).
  // Prompt delivery is the contract under test; these offline wires cannot prove
  // that a live model follows the instruction. Markerless output must still wait.
  // hearsay-tools/cezarion#1234: every runner honors cezarTools, so every session here is taught
  // the lifecycle tools instead of the markers (the toolless form is in human-waits.test.ts).
  describeRunners('harness parity — monitoring wrap-up contract (#399)', () => {
    const promptRules = [
      'When the goal is fully achieved and verified and you have no question for the user, call cezar_done, then end your turn.',
      'call cezar_wait with kind "ci" for a pull request\'s checks or kind "timer" to re-check later, then end your turn.',
    ];
    const wakeRules = [
      'When the goal is complete and verified, call cezar_done.',
      'If the watched work is still pending, call cezar_wait again.',
    ];
    type Wire = {
      userText?: string; method?: string; url?: string; prompt?: string;
      params?: { input?: { text?: string }[]; prompt?: { text?: string }[] };
      body?: { parts?: { text?: string }[] };
    };
    const records = (path: string): (Wire | string[])[] => existsSync(path)
      ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
    // Print carries its combined prompt on stdin; Claude/Pi/OMP keep the system prompt in argv.
    const stdinWire = (backend: RunnerId) => backend === 'claude' || backend === 'pi' || backend === 'omp';
    const messages = (backend: RunnerId, dir: string): string[] => {
      const channel = stdinWire(backend) ? 'stdin' : 'args';
      const wire = backend === 'cursor' ? [...records(join(dir, 'args')), ...records(join(dir, 'stdin'))]
        : records(join(dir, channel));
      return wire.flatMap(row => {
        if (Array.isArray(row)) return backend === 'cursor' && row.at(-1)?.includes('\n\n---\n\n')
          ? [row.at(-1)!] : [];
        if (stdinWire(backend)) return row.userText === undefined ? [] : [row.userText];
        if (backend === 'cursor' && row.method === 'cursor-print/stdin' && row.prompt !== undefined) return [row.prompt];
        const parts = backend === 'codex' && row.method === 'turn/start' ? row.params?.input
          : backend === 'cursor' && row.method === 'session/prompt' ? row.params?.prompt
          : backend === 'opencode' && /\/(message|prompt_async)$/.test(row.url ?? '') ? row.body?.parts : undefined;
        return parts ? [parts.map(part => part.text ?? '').join('\n')] : [];
      });
    };
    const systemPrompt = (backend: RunnerId, dir: string): string => {
      if (!stdinWire(backend)) return messages(backend, dir)[0] ?? '';
      const argv = records(join(dir, 'args')).find(Array.isArray) ?? [];
      const index = argv.indexOf('--append-system-prompt');
      expect(index).toBeGreaterThanOrEqual(0);
      return argv[index + 1] ?? '';
    };
    const assertRules = (text: string, rules: readonly string[]) => {
      for (const rule of rules) expect(text).toContain(rule);
      expect(text).not.toContain('CEZ:MONITORING');
    };
    const recording = async (body: (dir: string) => Promise<void>) => {
      const dir = mkdtempSync(join(tmpdir(), 'cez-monitoring-prompt-'));
      vi.stubEnv('CEZ_MOCK_ARGS_FILE', join(dir, 'args'));
      vi.stubEnv('CEZ_MOCK_STDIN_FILE', join(dir, 'stdin'));
      try { await body(dir); }
      finally { vi.unstubAllEnvs(); rmSync(dir, { recursive: true, force: true }); }
    };
    const clearRecording = (dir: string) => {
      for (const channel of ['args', 'stdin']) writeFileSync(join(dir, channel), '');
    };

    for (const backend of runners) {
      for (const continued of [false, true]) {
        it(`${backend} ${continued ? 'R37 Continue' : 'R36 fresh'} receives the shared monitoring wrap-up contract`, async () => {
          await recording(async dir => {
            await driveRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
              async ({ store, manager, runId }) => {
                if (continued) {
                  const internal = manager as unknown as { active: Map<string, { idleTimer?: NodeJS.Timeout }> };
                  const timer = internal.active.get(runId)?.idleTimer as NodeJS.Timeout & { _onTimeout(): void };
                  expect(timer).toBeDefined();
                  timer._onTimeout();
                  await waitFor(() => !manager.isActive(runId));
                  clearRecording(dir);
                  expect(manager.continueRun(runId, { text: promptFor(backend, 'baseline') }).ok).toBe(true);
                  await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
                }
                assertRules(systemPrompt(backend, dir), promptRules);
                expect(systemPrompt(backend, dir)).toContain('When a user decision or missing input is needed, call cezar_ask');
              });
          });
        }, 60_000);
      }

      it(`${backend} R38 restart recovery receives the shared monitoring wrap-up contract`, async () => {
        await recording(async dir => {
          await withOwnedInputRun(backend, 'split-text', async fixture => {
            fixture.manager.enqueueOwnedRun(fixture.runId);
            await waitFor(() => fixture.store.getRun(fixture.runId)?.status === 'waiting' && !!monitoringWakeOf(fixture.store.getRun(fixture.runId)));
            clearRecording(dir);
            const { manager } = await fixture.restart();
            // hearsay-tools/cezarion#1233: recovery re-arms the park's persisted monitoring timer
            // instead of resuming at once; its wake starts the recovered session.
            await waitFor(() => !!monitoringTimerOf(manager, fixture.runId));
            monitoringTimerOf(manager, fixture.runId)!._onTimeout();
            await waitFor(() => manager.isActive(fixture.runId) && messages(backend, dir).length > 0);
            assertRules(systemPrompt(backend, dir), promptRules);
          });
        });
      }, 60_000);

      it(`${backend} R39 monitoring wake delivers the cezar_done and cezar_wait instructions on the native message channel`, async () => {
        await recording(async dir => {
          await driveRun(backend, 'split-text', record => record?.status === 'waiting' && !!monitoringWakeOf(record), 30_000,
            async ({ store, manager, runId }) => {
              const timer = monitoringTimerOf(manager, runId)!;
              expect(timer).toBeDefined();
              timer._onTimeout();
              await waitFor(() => messages(backend, dir).length > 1);
              assertRules(messages(backend, dir)[1]!, wakeRules);
              expect(store.readEvents(runId).some(event => event.type === 'user-message')).toBe(false);
            });
        });
      }, 60_000);

      it(`${backend} R40 completion prose without a marker still parks waiting`, async () => {
        await driveRun(backend, 'baseline', record => record?.status === 'waiting', 30_000,
          async ({ store, manager, runId }) => {
            const prose = 'The PR merged. No further monitoring is needed. Everything is complete.';
            expect(manager.sendMessage(runId, [{ type: 'text', text: `mock:agent-echo ${prose}` }])).toBe(true);
            await waitFor(() => store.readEvents(runId).some(event => event.type === 'text' && String(event.text).includes(prose)));
            await waitFor(() => store.getRun(runId)?.status === 'waiting');
            expect(manager.isActive(runId)).toBe(true);
          });
      }, 60_000);
    }
  });

  // hearsay-tools/cezarion#922: every task-owned declaration, through each native runner wire.
  describeRunners('harness parity — multi-pr collection', () => {
    for (const backend of runners) {
      for (const continuation of [false, true]) {
        it(`${backend} ${continuation ? 'PR2' : 'PR1'} multi-pr retains fresh and continued declarations`, async () => {
          let dataDir = '';
          const observed = await driveRun(backend, 'multi-pr-refs', record => record?.status === 'done', 60_000,
            async ({ store, manager, runId }) => {
              expect(store.getRun(runId)?.pullRequests?.map(pr => pr.number)).toEqual([812, 813, 814, 815, 816]);
              expect(store.getRun(runId)?.markerRefs?.pr).toBe(816);
              if (continuation) {
                await waitFor(() => !manager.isActive(runId));
                expect(manager.continueRun(runId, { text: 'mock:multi-pr-refs-continue' }).ok).toBe(true);
                await waitFor(() => !manager.isActive(runId) && store.getRun(runId)?.status === 'done', 60_000);
                expect(store.getRun(runId)?.markerRefs?.pr).toBe(817);
              }
              store.flush();
              expect(readPersistedRuns(dataDir).find(run => run.id === runId)?.pullRequests?.map((pr: NonNullable<RunRecord['pullRequests']>[number]) => pr.number))
                .toEqual(continuation ? [812, 813, 814, 815, 816, 817] : [812, 813, 814, 815, 816]);
            }, { beforeStart: ({ repoRoot }) => { dataDir = join(repoRoot, '.ai/cezar'); } });
          expect(observed.record?.pullRequests?.some(pr => pr.number === 999)).toBe(false);
        }, 150_000);
      }
    }
  });

  describeRunners('native permission routing (hearsay-tools/cezarion#1049)', () => {
    for (const backend of runners) {
      const exemption = exemptionFor('P1', backend);
      if (exemption) {
        it(`${backend} P1 exemption — ${exemption.reason}`, () => {
          expect(exemption.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].scenarios.approval).toBeUndefined();
        });
        continue;
      }
      for (const { pick: decision, echo } of HARNESS_ADAPTERS[backend].approvalDecisions!) {
        it(`${backend} P1 ${decision} answers the native request through the cockpit API`, async () => {
          let repoRoot = '';
          const observation = await driveRun(backend, 'approval', run => !!run && ['done', 'review'].includes(run.status), 30_000, async ({ store, manager, runId }) => {
            // Continue builds ActiveRun at a second site. Old capabilities must stay
            // retired while a fresh native approval parks the resumed generation.
            const first = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
            await waitFor(() => !manager.isActive(runId));
            expect(manager.continueRun(runId, { text: 'mock:approval' })).toEqual({ ok: true });
            await waitFor(() => store.readEvents(runId).filter(event => event.type === 'permission.requested').length === 2);
            const request = store.readEvents(runId).filter(event => event.type === 'permission.requested')[1]!;
            expect(request.requestId).not.toBe(first.requestId);
            expect(store.getRun(runId)).toMatchObject({ status: 'waiting', hasPendingPermission: true });
            const old = (first.options as Array<{ id: string }>)[0]!;
            expect(manager.respondPermission(runId, first.requestId as string, old.id)).toBe(false);
            const choice = (request.options as Array<{ id: string; label: string }>).find(option => option.label.toLowerCase().includes(decision))!;
            expect(manager.respondPermission(runId, request.requestId as string, choice.id)).toBe(true);
            await waitFor(() => ['done', 'review'].includes(store.getRun(runId)?.status ?? '') && !manager.isActive(runId));
          }, {
            autonomous: true,
            beforeStart: context => { repoRoot = context.repoRoot; },
            during: async ({ store, manager, runId }) => {
              await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
              expect(store.getRun(runId)).toMatchObject({ status: 'waiting', hasPendingPermission: true });
              const request = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
              const options = request.options as Array<{ id: string; label: string }>;
              const choice = options.find(option => option.label.toLowerCase().includes(decision));
              expect(choice).toBeDefined();
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
              expect(manager.respondPermission(runId, request.requestId as string, 'not-offered')).toBe(false);
              const app = createApp({ repoRoot, store, manager, version: 'test' });
              const response = await apiRequest(app, `/api/v1/runs/${runId}/permissions`, {
                method: 'POST', headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ requestId: request.requestId, optionId: choice!.id }),
              });
              expect(response.status).toBe(200);
              expect(await response.json()).toEqual({ delivered: true });
              expect(manager.respondPermission(runId, request.requestId as string, choice!.id)).toBe(false);
            },
          });
          expect(observation.events).toContainEqual(expect.objectContaining({ type: 'permission.resolved', optionId: expect.any(String) }));
          expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
          expect(observation.events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain(echo);
          expect(observation.record?.hasPendingPermission).toBe(false);
          expect(observation.events.some(event => event.type === 'ask.requested')).toBe(false);
        }, 45_000);
      }
    }
  });

  describeRunners('default permission asks (hearsay-tools/cezarion#1266)', () => {
    for (const backend of runners) {
      const exemption = exemptionFor('P2', backend);
      if (exemption) {
        it(`${backend} P2 exemption — ${exemption.reason}`, () => {
          expect(exemption.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].scenarios['permission-default']).toBeUndefined();
        });
        continue;
      }
      it(`${backend} P2 answers its built-in default permission ask without parking`, async () => {
        const observation = await driveRun(backend, 'permission-default', run => !!run && ['done', 'review'].includes(run.status), 30_000);
        expect(observation.events.some(event => event.type === 'permission.requested')).toBe(false);
        expect(observation.record?.hasPendingPermission).toBeFalsy();
        expect(observation.events.filter(event => event.type === 'text').map(event => event.text).join('')).toContain('Approval response: {"reply":"once"}');
        expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
      }, 45_000);
    }
  });

  for (const { id, scenario, text } of RETIREMENTS) {
    describeRunners(`${id} ${PERMISSION_CRITERIA.find(c => c.id === id)!.name} (hearsay-tools/cezarion#1266)`, () => {
      for (const backend of runners) {
        if (permissionExemption(id, backend, scenario)) continue;
        it(`${backend} ${id} retires the card, its capability and the run's pending permission`, async () => {
          await withRelease(async (release) => {
            let requestId = '';
            // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
            const observation = await driveRun(backend, scenario, run => !!run && ['done', 'review'].includes(run.status), 30_000, undefined, {
              env: { CEZ_MOCK_RELEASE_FILE: release },
              during: async ({ store, manager, runId }) => {
                await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
                const request = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
                requestId = request.requestId as string;
                expect(store.getRun(runId)).toMatchObject({ status: 'waiting', hasPendingPermission: true });
                expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
                writeFileSync(release, 'go');
                await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.resolved' && event.requestId === requestId));
                // The retired card answers nothing, whether or not the run has moved on yet.
                expect(manager.respondPermission(runId, requestId, (request.options as Array<{ id: string }>)[0]!.id)).toBe(false);
              },
            });
            const resolutions = permissionResolutionsOf(observation.events);
            expect(resolutions).toEqual([expect.objectContaining({ requestId, reason: expect.any(String) })]);
            expect(resolutions[0]).not.toHaveProperty('optionId');
            expect(observation.record?.hasPendingPermission).toBe(false);
            expect(joinedText(observation.events)).toContain(text);
            expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
          });
        // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
        }, 45_000);
      }
    });
  }

  describeRunners(`P5 ${PERMISSION_CRITERIA.find(c => c.id === 'P5')!.name} (hearsay-tools/cezarion#1266)`, () => {
    for (const backend of runners) {
      if (permissionExemption('P5', backend, 'approval-reply-fails')) continue;
      it(`${backend} P5 replaces the card it could not deliver and keeps the run waiting`, async () => {
        let repoRoot = '';
        const { pick, echo } = HARNESS_ADAPTERS[backend].approvalDecisions![0]!;
        let freshId = '';
        // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
        const observation = await driveRun(backend, 'approval-reply-fails', run => !!run && ['done', 'review'].includes(run.status), 30_000, undefined, {
          beforeStart: context => { repoRoot = context.repoRoot; },
          during: async ({ store, manager, runId }) => {
            const requests = () => store.readEvents(runId).filter(event => event.type === 'permission.requested');
            await waitFor(() => requests().length === 1);
            const first = requests()[0]!;
            const firstChoice = optionPicked(first, pick);
            // From the refused answer to the replacement card, the run never stops waiting on a card.
            const changes: Array<{ status: string; hasPendingPermission?: boolean }> = [];
            const recordChange = (record: RunRecord) => {
              if (record.id === runId) changes.push({ status: record.status, hasPendingPermission: record.hasPendingPermission });
            };
            store.on('run', recordChange);
            try {
              const response = await answerThroughRoute(repoRoot, store, manager, runId, first, firstChoice.id);
              expect(response.status).toBe(200);
              expect(await response.json()).toEqual({ delivered: true });
              await waitFor(() => requests().length === 2 &&
                store.readEvents(runId).some(event => event.type === 'permission.resolved' && event.requestId === first.requestId));
            } finally { store.off('run', recordChange); }
            for (const change of changes) expect(change).toEqual({ status: 'waiting', hasPendingPermission: true });
            const events = store.readEvents(runId);
            const fresh = requests()[1]!;
            freshId = fresh.requestId as string;
            expect(freshId).not.toBe(first.requestId);
            const oldResolution = events.findIndex(event => event.type === 'permission.resolved' && event.requestId === first.requestId);
            expect(events.findIndex(event => event.type === 'permission.requested' && event.requestId === freshId)).toBeLessThan(oldResolution);
            expect(events[oldResolution]).toMatchObject({ reason: expect.any(String) });
            expect(events[oldResolution]).not.toHaveProperty('optionId');
            expect(store.getRun(runId)).toMatchObject({ status: 'waiting', hasPendingPermission: true });
            expect(manager.respondPermission(runId, first.requestId as string, firstChoice.id)).toBe(false);
            expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
            const retry = await answerThroughRoute(repoRoot, store, manager, runId, fresh, optionPicked(fresh, pick).id);
            expect(retry.status).toBe(200);
          },
        });
        expect(permissionResolutionsOf(observation.events).filter(event => event.optionId !== undefined))
          .toEqual([expect.objectContaining({ requestId: freshId, optionId: expect.any(String) })]);
        expect(observation.record?.hasPendingPermission).toBe(false);
        expect(joinedText(observation.events)).toContain(echo);
        expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
      // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
      }, 45_000);
    }
  });

  describeRunners(`P6 ${PERMISSION_CRITERIA.find(c => c.id === 'P6')!.name} (hearsay-tools/cezarion#1266)`, () => {
    for (const backend of runners) {
      if (permissionExemption('P6', backend, 'approval-malformed')) continue;
      it(`${backend} P6 refuses the malformed request natively and the turn goes on`, async () => {
        // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
        const observation = await driveRun(backend, 'approval-malformed', run => !!run && ['done', 'review'].includes(run.status), 30_000);
        expect(observation.events.some(event => event.type === 'permission.requested')).toBe(false);
        expect(observation.record?.hasPendingPermission).toBeFalsy();
        expect(observation.statuses).not.toContain('waiting');
        expect(joinedText(observation.events)).toContain(HARNESS_ADAPTERS[backend].malformedApprovalEcho!);
        expect(observation.events).toContainEqual(expect.objectContaining({ type: 'turn.completed' }));
      // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
      }, 45_000);
    }
  });

  describeRunners(`P7 ${PERMISSION_CRITERIA.find(c => c.id === 'P7')!.name} (hearsay-tools/cezarion#1266)`, () => {
    for (const backend of runners) {
      if (permissionExemption('P7', backend, 'permission-classify')) continue;
      // Agent input reaches a session only through `sendAgentMessage`, so the cell drives the seam.
      it(`${backend} P7 refuses agent input before the card and drops the request settled meanwhile`, async () => {
        await withRelease(async (release) => {
          const argsFile = `${release}.args.ndjson`;
          let inputReady = 0;
          const observation = await driveSeam(backend, 'permission-classify', {
            spec: { env: { CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '', CEZ_MOCK_ARGS_FILE: argsFile, CEZ_MOCK_RELEASE_FILE: release } },
            sessionOptions: { onAgentInputReady: () => { inputReady += 1; } },
            whileOpen: async (session, observed) => {
              await waitFor(() => existsSync(`${release}.config-read`));
              expect(session.sendAgentMessage([{ type: 'text', text: 'steer' }])).toBe(false);
              const before = inputReady;
              writeFileSync(`${release}.settle`, 'go');
              // SSE frames are handled in order: the text after the native reply proves it was read.
              await waitFor(() => observed.v2.some(event => JSON.stringify(event).includes('OpenCode settled the ask itself.')));
              await waitFor(() => inputReady > before);
              writeFileSync(release, 'go');
              await waitFor(() => observed.v2.some(event => event.type === 'permission.requested'));
              const requests = observed.v2.filter((event): event is PermissionRequestedEvent => event.type === 'permission.requested');
              expect(requests).toHaveLength(1);
              expect(JSON.parse(requests[0]!.details!)).toMatchObject({ patterns: ['marker'] });
              const allow = requests[0]!.options.find(option => option.label.toLowerCase().includes('allow once'))!;
              expect(session.respondPermission!(requests[0]!.requestId, allow.id)).toBe(true);
              await waitFor(() => observed.v1.some(event => event.type === 'turn-end'));
            },
          });
          expect(observation.failure).toBeUndefined();
          const urls = readFileSync(argsFile, 'utf8').split('\n').filter(Boolean).map(line => (JSON.parse(line) as { url?: string }).url);
          expect(urls).not.toContain('/permission/per_mock_classify/reply');
          expect(urls).toContain('/permission/per_mock_marker/reply');
        });
      // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
      }, 45_000);
    }
  });

  describeRunners(`P8 ${PERMISSION_CRITERIA.find(c => c.id === 'P8')!.name} (hearsay-tools/cezarion#1266)`, () => {
    for (const backend of runners) {
      if (permissionExemption('P8', backend, 'permission-late')) continue;
      // A session's own close (autoEndAfterFirstTurn) lives at the seam.
      it(`${backend} P8 reopens the turn for the late card and ends the session after that turn`, async () => {
        const observation = await driveSeam(backend, 'permission-late', {
          sessionOptions: { autoEndAfterFirstTurn: true },
          whileOpen: async (session, observed) => {
            const turnEnds = () => observed.v1.filter(event => event.type === 'turn-end').length;
            await waitFor(() => observed.v2.some(event => event.type === 'permission.requested'));
            expect(turnEnds()).toBe(1);
            const started = observed.v2.flatMap((event, index) => event.type === 'turn.started' ? [index] : []);
            expect(started).toHaveLength(2);
            expect(observed.v2.findIndex(event => event.type === 'turn.completed')).toBeLessThan(started[1]!);
            expect(started[1]!).toBeLessThan(observed.v2.findIndex(event => event.type === 'permission.requested'));
            expect(session.open).toBe(true);
            const request = observed.v2.find((event): event is PermissionRequestedEvent => event.type === 'permission.requested')!;
            const allow = request.options.find(option => option.label.toLowerCase().includes('allow once'))!;
            expect(session.respondPermission!(request.requestId, allow.id)).toBe(true);
            await waitFor(() => !session.open);
            expect(turnEnds()).toBe(2);
          },
        });
        expect(observation.failure).toBeUndefined();
        expect(observation.v2.filter(event => event.type === 'permission.resolved'))
          .toEqual([expect.objectContaining({ optionId: expect.any(String) })]);
        expect(observation.v2.filter(event => event.type === 'turn.completed')).toHaveLength(2);
        expect(textEvents(observation.v1).join('\n')).toContain('Approval response: {"reply":"once"}');
      // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
      }, 45_000);

      // Through RunManager only a non-final step closes on its own; the second step proves it did.
      it(`${backend} P8 lets the workflow advance past a non-final step whose late card is answered`, async () => {
        let repoRoot = '';
        const { pick } = HARNESS_ADAPTERS[backend].approvalDecisions![0]!;
        const workflowDef: WorkflowDef = {
          name: 'permission-late', source: 'built-in',
          steps: [{ id: 'first', name: 'First', prompt: '{{task}}' }, { id: 'second', name: 'Second', prompt: promptFor(backend, 'done') }],
        };
        // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
        const observation = await driveRun(backend, 'permission-late', run => !!run && ['done', 'review'].includes(run.status), 30_000, undefined, {
          workflowDef,
          beforeStart: context => { repoRoot = context.repoRoot; },
          during: async ({ store, manager, runId }) => {
            await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
            expect(store.getRun(runId)).toMatchObject({ status: 'waiting', hasPendingPermission: true });
            const request = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
            const response = await answerThroughRoute(repoRoot, store, manager, runId, request, optionPicked(request, pick).id);
            expect(response.status).toBe(200);
          },
        });
        expect(permissionResolutionsOf(observation.events)).toEqual([expect.objectContaining({ optionId: expect.any(String) })]);
        expect(observation.record?.hasPendingPermission).toBe(false);
        expect(observation.record?.steps.map(step => [step.id, step.status])).toEqual([['first', 'done'], ['second', 'done']]);
      // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
      }, 45_000);
    }
  });

  // cezar's own tools are covered where they run: Codex rows of ci-wait-parity park only
  // when the mock's MCP tool gate lets cezar_wait through unasked.
  describeRunners('MCP tool approval routing (hearsay-tools/cezarion#1294)', () => {
    for (const backend of runners) {
      const exemption = exemptionFor('P9', backend);
      if (exemption) {
        it(`${backend} P9 exemption — ${exemption.reason}`, () => {
          expect(exemption.kind).toBe('scenario-unconstructible');
          expect(HARNESS_ADAPTERS[backend].scenarios['mcp-approval']).toBeUndefined();
        });
        continue;
      }
      for (const [label, action] of [['Allow once', 'accept'], ['Decline and continue', 'decline']] as const) {
        it(`${backend} P9 ${action} answers another server's MCP tool approval through the cockpit API`, async () => {
          let repoRoot = '';
          // bound: hang guard for the live mock run; the predicate waits on the run settling, and a stuck card fails here instead of at the test timeout.
          const observation = await driveRun(backend, 'mcp-approval', run => !!run && ['done', 'review'].includes(run.status), 30_000, undefined, {
            beforeStart: context => { repoRoot = context.repoRoot; },
            during: async ({ store, manager, runId }) => {
              await waitFor(() => store.readEvents(runId).some(event => event.type === 'permission.requested'));
              expect(store.getRun(runId)).toMatchObject({ status: 'waiting', hasPendingPermission: true });
              const request = store.readEvents(runId).find(event => event.type === 'permission.requested')!;
              expect(request.title).toBe('Codex requests an MCP tool call');
              const choice = (request.options as Array<{ id: string; label: string }>).find(option => option.label === label)!;
              expect(manager.sendMessage(runId, [{ type: 'text', text: 'accept' }])).toBe(false);
              const response = await answerThroughRoute(repoRoot, store, manager, runId, request, choice.id);
              expect(response.status).toBe(200);
              expect(await response.json()).toEqual({ delivered: true });
            },
          });
          expect(observation.events).toContainEqual(expect.objectContaining({ type: 'permission.resolved', optionId: expect.any(String) }));
          expect(observation.events.filter(event => event.type === 'text').map(event => event.text).join(''))
            .toContain(`Approval response: ${JSON.stringify({ action, content: null, _meta: null })}`);
          expect(observation.record?.hasPendingPermission).toBe(false);
        // bound: per-cell hang guard above driveRun's own 30 s settle bound, sized for a parity cell under host load.
        }, 45_000);
      }
    }
  });
}
