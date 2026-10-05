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
 * `ask.requested` comes from the RUNNER for codex, opencode and cursor and from
 * `workflows/run.ts` for claude and pi — groups 1, 3 and 6 are only uniform
 * above the seam.
 */
import { MONITORING_TURN_CRITERIA, MONITORING_ACK_CRITERIA, MONITORING_ORDER_CRITERIA } from '../workflows/monitoring-turn.testkit.ts';
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
import { inputDeliveryOf } from './agent-runner.ts';
import { agentTmpDir, resolveAgentTmpDir } from '../runs/agent-tmpdir.ts';
import { appendTurnText } from '../workflows/run.ts';
import * as gitWorktree from '../git-worktree.ts';
import { cleanupCheckpoint, seedSettledFamily } from '../workflows/delegation-reconcile.testkit.ts';
import { supportsProfiles } from './agent-profiles.ts';
import { plannedWorkflow, skillTaskSteps, type WorkflowDef } from '../workflows/types.ts';
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
  WORKFLOW_TIMEOUT_CRITERIA,
  NO_PROGRESS_CRITERIA,
  AUTONOMOUS_CRITERIA,
  WORKFLOW_ASK_CRITERIA,
  PARITY_EXEMPTIONS,
  PINNED_SESSION_ID,
  type RunObservation,
  type ScenarioName,
  type SeamObservation,
  waitFor,
} from './harness-parity.testkit.ts';

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
  { id: 'R16', scenario: 'ask-snapshot' },
  { id: 'R20', scenario: 'baseline' },
  { id: 'R21', scenario: 'baseline' },
  { id: 'R22', scenario: 'baseline' },
  { id: 'R23', scenario: 'ask' },
  // harness-autosave.test.ts drives both cleanup paths with native runner wires.
  { id: 'R24', scenario: 'baseline' },
  { id: 'R25', scenario: 'baseline' },
  { id: 'R26', scenario: 'ask-resume' },
  // workflows/ci-wait-refusal.test.ts: settled worker wake, private CI IPC, then delivery.
  { id: 'R27', scenario: 'hold' },
  { id: 'R28', scenario: 'baseline' },
  { id: 'R29', scenario: 'baseline' },
  { id: 'R30', scenario: 'baseline' },
  { id: 'R31', scenario: 'baseline' },
  { id: 'R32', scenario: 'baseline' },
  { id: 'R33', scenario: 'baseline' },
  { id: 'R34', scenario: 'baseline' },
  // R35 covers both preview serve (#781) and stop/restart (#803) discovery on every native wire.
  { id: 'R35', scenario: 'baseline' },
  // #399: shared monitoring instructions on each native prompt channel.
  { id: 'R36', scenario: 'baseline' },
  { id: 'R37', scenario: 'baseline' },
  { id: 'R38', scenario: 'split-text' },
  { id: 'R39', scenario: 'split-text' },
  { id: 'R40', scenario: 'baseline' },
  { id: 'R41', scenario: 'done' },
  { id: 'R42', scenario: 'baseline' },
  // workflows/worker-reboot-parity.test.ts and worker-location-evidence.test.ts: native exit/Continue,
  // independent reboot proof, legacy location uncertainty, real holders, cleanup retries and parent Finish.
  { id: 'R43', scenario: 'baseline' },
  // workflows/worker-restart-parity.test.ts: same-boot abandonment, mixed-holder polling and bounded cleanup locks.
  { id: 'R47', scenario: 'baseline' },
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

describe('harness parity — seam tier', () => {
  for (const backend of RUNNER_IDS) {
    for (const criterion of SEAM_CRITERIA) {
      parityRow(backend, criterion, () => driveSeam(backend, criterion.scenario));
    }
  }
});

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
describe('harness parity — input delivery (#505)', () => {
  for (const backend of RUNNER_IDS) {
    it(`${backend} I0 declares its input delivery`, () => {
      expect(['steer', 'boundary']).toContain(inputDeliveryOf(createRunner(backend)).mode);
    });
    for (const criterion of INPUT_CRITERIA) {
      parityRow(backend, criterion, () => observeInput(backend, criterion.scenario, `parity-${criterion.id}`));
    }
  }
});

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

describe('harness parity — recoverable skill diagnostics (#723)', () => {
  for (const backend of RUNNER_IDS) {
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
  for (const continuation of [false, true]) for (const scenario of ['unscoped-provider-failure', 'scoped-skill-failure']) {
    it(`opencode ${continuation ? 'continued' : 'fresh'} ${scenario} remains fatal`, async () => {
      const prompt = `mock:${scenario}`;
      const obs = continuation ? await continueDiagnosticRun('opencode', prompt)
        : await driveRun('opencode', { prompt }, record => TERMINAL.includes(record?.status ?? ''));
      expect(obs.record?.status).toBe('failed');
      expect(obs.record?.error).toContain('provider');
      expect(obs.record?.error).toContain(scenario === 'scoped-skill-failure' ? '/skills/required/SKILL.md' : 'restoring service');
    }, 45_000);
  }
});

describe('harness parity — seam tier, session control', () => {
  for (const backend of RUNNER_IDS) {
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
describe('harness parity — late child attention', () => {
  for (const backend of RUNNER_IDS) {
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
          record => record?.activity === 'monitoring' || record?.status === 'waiting', 30_000,
          async ({ store, runId }) => {
            expect(store.getRun(runId)).toMatchObject({ status: 'running', activity: 'monitoring' });
            const wake = store.getRun(runId)?.monitoringWakeAt;
            expect(wake).toBeDefined();
            const before = store.readEvents(runId).length;
            const changes: Array<{ status: string; activity?: string; monitoringWakeAt?: string }> = [];
            const recordChange = (record: NonNullable<RunObservation['record']>) => {
              if (record.id === runId) changes.push({ status: record.status, activity: record.activity, monitoringWakeAt: record.monitoringWakeAt });
            };
            store.on('run', recordChange);
            try {
              writeFileSync(release, 'go');
              await waitFor(() => store.readEvents(runId).slice(before).some(event =>
                backend === 'opencode'
                  ? event.type === 'usage.updated' && (event.usage as { total?: number } | undefined)?.total === 424242
                  : JSON.stringify(event).includes('Post-park child update processed.')));
              expect(store.getRun(runId)).toMatchObject({ status: 'running', activity: 'monitoring', monitoringWakeAt: wake });
              for (const change of changes) expect(change).toEqual({ status: 'running', activity: 'monitoring', monitoringWakeAt: wake });
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

// #134/#401: use native completed-message frames, not an injected UiEvent or
// fake runner. Current wires couple that snapshot to v1; the named exemptions
// are pinned in the inverse direction, in addition to the actual park/card.
describe('harness parity — stored assistant ASK', () => {
  for (const backend of RUNNER_IDS) {
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
      expect(run.record).toMatchObject({ status: 'waiting', hasPendingHumanAsk: true });
      expect(run.record?.activity).toBeUndefined();
      expect(run.record?.monitoringWakeAt).toBeUndefined();
      expect(askEvents(run)).toHaveLength(1);
      expect(askEvents(run)[0]?.questions).toMatchObject([{ header: 'Library', question: 'Which test library?' }]);
      expect(run.events.some(event => event.type === 'item.completed' && JSON.stringify(event.item).includes('CEZ:ASK'))).toBe(true);
    }, 60_000);
  }
});

// #398: a native answer's turn boundary must not ask the human to prompt again.
// R6 deliberately tests markerless owned-input draining; it cannot prove completion.
describe('harness parity — answer to completion run tier', () => {
  for (const backend of RUNNER_IDS) {
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
          expect(store.getRun(runId)?.hasPendingHumanAsk).toBe(true);
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
            expect(store.getRun(runId)?.hasPendingHumanAsk).toBe(false);
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
        // #505: input can land mid-turn, so delivery no longer implies the answering turn
        // ended; the answer's durable checkpoint is still that turn's end.
        await waitFor(() => recovered.store.readEvents(runId).some(e => e.type === 'human-input-delivered'));
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
      // #505: the queued message steers into the answering turn right behind the answer,
      // so it may carry a delivery receipt; the input itself is unchanged and never lost.
      const withoutReceipts = (inputs: AgentInput[] | undefined) => inputs?.map(({ deliveredAt: _d, consumedAt: _c, awaitingRead: _a, ...rest }) => rest);
      expect(withoutReceipts(store.getRun(runId)?.agentInputs)).toEqual([input]);
      const recovered = await fixture.restart();
      expect((recovered.manager as unknown as { hasPendingHumanAsk(id: string): boolean }).hasPendingHumanAsk(runId)).toBe(true);
      expect(recovered.manager.continueRun(runId).ok).toBe(false);
      expect(withoutReceipts(recovered.store.getRun(runId)?.agentInputs)).toEqual([input]);
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
    ...MONITORING_TURN_CRITERIA.map(c => c.id),
    ...MONITORING_ACK_CRITERIA.map(c => c.id),
    ...MONITORING_ORDER_CRITERIA.map(c => c.id),
    ...WORKFLOW_ASK_CRITERIA.map(c => c.id),
    ...AUTONOMOUS_CRITERIA.map(c => c.id),
    ...NO_PROGRESS_CRITERIA.map(c => c.id),
    ...WORKFLOW_TIMEOUT_CRITERIA.map((c) => c.id),
    ...SEAM_CRITERIA.map((c) => c.id),
    ...INPUT_CRITERIA.map((c) => c.id),
    ...CONTROL_CRITERIA.map((c) => c.id),
    ...RUN_CRITERIA.map((c) => c.id),
  ];
  const scenarioOf = (id: string): ScenarioName => {
    const monitor = [...MONITORING_TURN_CRITERIA, ...MONITORING_ACK_CRITERIA, ...MONITORING_ORDER_CRITERIA].find(c => c.id === id);
    if (monitor) return monitor.scenario;
    const ask = WORKFLOW_ASK_CRITERIA.find(c => c.id === id);
    if (ask) return ask.scenario;
    const autonomous = AUTONOMOUS_CRITERIA.find(c => c.id === id);
    if (autonomous) return autonomous.scenario;
    const inactivity = NO_PROGRESS_CRITERIA.find(c => c.id === id);
    if (inactivity) return inactivity.scenario;
    const timeout = WORKFLOW_TIMEOUT_CRITERIA.find(c => c.id === id);
    if (timeout) return timeout.scenario;
    const seam = SEAM_CRITERIA.find((c) => c.id === id) ?? INPUT_CRITERIA.find((c) => c.id === id);
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
      cursor: ['cursor/ask_question', 'cursor/create_plan'],
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
      'packages/cezar/src/core/harness-parity.test.ts', 'packages/cezar/src/core/harness-parity.testkit.ts']) {
      const source = readFileSync(new URL(`../../../../${path}`, import.meta.url), 'utf8');
      expect(source.match(countedRunners) ?? [], path).toEqual([]);
    }
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
    for (const url of [new URL(import.meta.url), new URL('../workflows/worker-parent-attention.test.ts', import.meta.url), new URL('../workflows/monitoring-turn.test.ts', import.meta.url)]) {
      const source = readFileSync(url, 'utf8');
      expect(source).not.toMatch(/\b(?:it|test|describe)\s*\.\s*(?:skip|todo)\s*\(/);
    }
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

// #781: the `cezarTools` cell, live. One shared cezar tool list feeds every
// runner's own wire (Claude's MCP config and generated allow-list entry, Codex
// and Cursor forwarded env, OpenCode's runtime config, Pi's extension and tool
// admission), and each mock lists the tools through the real bundled adapter.
// `cezar_preview_serve` and `cezar_preview_stop` are listed under `CEZ_PREVIEW=1` exactly.
describe('harness parity — cezarTools list behind CEZ_PREVIEW', () => {
  const wait = { id: '11111111-1111-4111-8111-111111111111', generation: 'gen', turnId: 'turn', timeoutSeconds: 1800, prUrl: 'https://github.com/owner/repo/pull/1', repository: 'owner/repo', prNumber: 1, headSha: 'a'.repeat(40), registeredAt: '2026-09-22T00:00:00.000Z', deadline: '2026-09-22T00:30:00.000Z', phase: 'registered' as const };
  for (const backend of RUNNER_IDS) for (const enabled of [true, false]) {
    it(`${backend} R35 ${enabled ? 'exposes' : 'hides'} preview serve and stop with CEZ_PREVIEW ${enabled ? 'on' : 'off'}`, async () => {
      vi.stubEnv('CEZ_PREVIEW', enabled ? '1' : '');
      const { CiToolController } = await import('../ci-wait/controller.ts');
      const controller = await CiToolController.start();
      const dir = mkdtempSync(join(tmpdir(), 'cez-tools-list-'));
      try {
        const session = controller.provision(async () => wait);
        const obs = await driveSeam(backend, 'baseline', { spec: { cezarTools: session.descriptor, allowedTools: ['Read'], env: { ...session.env, CEZ_MOCK_ARGS_FILE: join(dir, 'wire'), CEZ_MOCK_CI_PR: wait.prUrl, CEZ_MOCK_CI_RESULT: join(dir, 'result'), CEZ_HANDOFF_FILE: '', CEZ_TODOS_FILE: '' } } });
        expect(obs.v1.filter((event) => event.type === 'error')).toEqual([]);
        const expected = enabled ? ['cezar_wait_for_ci', 'cezar_preview_serve', 'cezar_preview_stop'] : ['cezar_wait_for_ci'];
        expect(JSON.parse(readFileSync(join(dir, 'result'), 'utf8')).names).toEqual(expected);
        const argv: string[] = JSON.parse(readFileSync(join(dir, 'wire'), 'utf8').trim().split('\n')[0]!);
        if (backend === 'claude') {
          const allowed = argv[argv.indexOf('--allowedTools') + 1]!.split(',');
          expect(allowed.filter((name) => name.startsWith(`mcp__${session.descriptor.name}__`))).toEqual(expected.map((name) => `mcp__${session.descriptor.name}__${name}`));
        }
        if (backend === 'pi') expect(argv[argv.indexOf('--tools') + 1]!.split(',').filter((name) => name.startsWith('cezar_'))).toEqual(expected);
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
describe('harness parity — terminal cleanup reconciliation', () => {
  for (const backend of RUNNER_IDS) {
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
describe('harness parity — multi-Continue settlement', () => {
  for (const backend of RUNNER_IDS) {
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

describe('harness parity — inactive Finish superseded by Continue', () => {
  for (const backend of RUNNER_IDS) {
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

describe('harness parity — accepted Finish across disposal', () => {
  for (const backend of RUNNER_IDS) {
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
describe('harness parity — live task scratch', () => {
  for (const backend of RUNNER_IDS) {
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
describe('harness parity — monitoring wrap-up contract (#399)', () => {
  const finishedRule = 'When the watched work is finished and the task goal is complete, end your final message with CEZ:DONE.';
  const pendingRule = 'If the watched work is still pending, end with CEZ:MONITORING.';
  const markerlessRule = 'Never yield markerless for a monitoring wrap-up.';
  type Wire = {
    userText?: string; method?: string; url?: string;
    params?: { input?: { text?: string }[]; prompt?: { text?: string }[] };
    body?: { parts?: { text?: string }[] };
  };
  const records = (path: string): (Wire | string[])[] => existsSync(path)
    ? readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
  // These wires record each user message on the stdin hook and the system prompt in argv.
  const stdinWire = (backend: RunnerId) => backend === 'claude' || backend === 'pi' || backend === 'omp';
  const messages = (backend: RunnerId, dir: string): string[] => {
    const channel = stdinWire(backend) ? 'stdin' : 'args';
    return records(join(dir, channel)).flatMap(row => {
      if (Array.isArray(row)) return [];
      if (stdinWire(backend)) return row.userText === undefined ? [] : [row.userText];
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
  const assertRules = (text: string) => {
    expect(text).toContain(finishedRule);
    expect(text).toContain(pendingRule);
    expect(text).toContain(markerlessRule);
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

  for (const backend of RUNNER_IDS) {
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
              assertRules(systemPrompt(backend, dir));
              expect(systemPrompt(backend, dir)).toContain('end plainly (no marker) only when you are genuinely waiting on the user');
            });
        });
      }, 60_000);
    }

    it(`${backend} R38 restart recovery receives the shared monitoring wrap-up contract`, async () => {
      await recording(async dir => {
        await withOwnedInputRun(backend, 'split-text', async fixture => {
          fixture.manager.enqueueOwnedRun(fixture.runId);
          await waitFor(() => fixture.store.getRun(fixture.runId)?.activity === 'monitoring');
          clearRecording(dir);
          const { manager } = await fixture.restart();
          await waitFor(() => manager.isActive(fixture.runId) && messages(backend, dir).length > 0);
          assertRules(systemPrompt(backend, dir));
        });
      });
    }, 60_000);

    it(`${backend} R39 monitoring wake delivers DONE and MONITORING instructions on the native message channel`, async () => {
      await recording(async dir => {
        await driveRun(backend, 'split-text', record => record?.activity === 'monitoring', 30_000,
          async ({ store, manager, runId }) => {
            const internal = manager as unknown as { active: Map<string, { monitoringWakeTimer?: NodeJS.Timeout }> };
            const timer = internal.active.get(runId)?.monitoringWakeTimer as NodeJS.Timeout & { _onTimeout(): void };
            expect(timer).toBeDefined();
            timer._onTimeout();
            await waitFor(() => messages(backend, dir).length > 1);
            assertRules(messages(backend, dir)[1]!);
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
          expect(store.getRun(runId)?.activity).toBeUndefined();
          expect(manager.isActive(runId)).toBe(true);
        });
    }, 60_000);
  }
});
