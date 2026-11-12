import { expect } from 'vitest';
import type { AgentEvent } from './agent-runner.ts';
import { driveSeam, lastIndexWhere } from './harness-parity-core.testkit.ts';
import type { Cells, HarnessRegistrar, SeamCriterion } from './harness-parity-registrar.testkit.ts';
import { SEAM_ROWS } from './harness-parity-rows.testkit.ts';

/** The seam tier's row cells (S1–S25), shared by the startup and session parts. */

const sessionEvents = (v1: readonly AgentEvent[]) =>
  v1.filter((e): e is Extract<AgentEvent, { type: 'session' }> => e.type === 'session');

const SEAM_CELLS: Cells<typeof SEAM_ROWS, SeamCriterion> = {
  S21: {
    // hearsay-tools/cezarion#832: restored history must not silently cross workflow steps.
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
  S25: {
    // hearsay-tools/cezarion#872: a start racing its predecessor's teardown exits before listening.
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
  S20: {
    assert: ({ backend, v1, failure, pid, elapsedMs }) => {
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
        expect(elapsedMs).toBeLessThan(2_000); // hearsay-tools/cezarion#895: the real spawn error, not the 30 s server URL deadline.
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
  S18: {
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
  S19: {
    assert: ({ v1, elapsedMs }) => {
      expect(elapsedMs).toBeLessThan(4_000); // Descendant keeps both pipes open for 5s.
      const errors = v1.filter(e => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('Error: write EPIPE');
      expect(v1.filter(e => e.type === 'note').map(e => e.message).join('\n')).toContain('late buffered crash diagnostic');
    },
  },
  S17: {
    assert: ({ v1 }) => {
      expect(v1.filter(e => e.type === 'error')).toEqual([]);
      expect(v1.filter(e => e.type === 'done')).toHaveLength(1);
      expect(v1.filter(e => e.type === 'turn-end')).toHaveLength(1);
      expect(v1.at(-1)?.type).toBe('done');
      expect(v1.filter(e => e.type === 'note').map(e => e.message).join('\n')).not.toContain('harmless shutdown diagnostic');
    },
  },
  S15: {
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
  S16: {
    assert: ({ v1 }) => {
      const errors = v1.filter(e => e.type === 'error');
      expect(errors).toHaveLength(1);
      expect(errors.at(-1)!.message).toContain('authentication unavailable');
      expect(errors.at(-1)!.message).toMatch(/(?:code 7|\(7\))/);
    },
  },
  S1: {
    // Group 7 — the baseline AgentSession contract, never asserted uniformly.
    assert: ({ v1 }) => {
      expect(v1.filter((e) => e.type === 'done')).toHaveLength(1);
      expect(v1.at(-1)?.type).toBe('done');
    },
  },
  S2: {
    // Group 2 / #4 — the OpenCode five-minute cut. The runner used to end the
    // turn from its transport's own response, so undici's 300s headers timeout
    // killed a healthy long turn and Squawk parked the run. `hold` acknowledges
    // the prompt, THEN waits before emitting content and its terminal signal:
    // a runner that still derives turn-end from the ack reports it before the
    // content it is supposed to close over.
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
  S7: {
    // Group 1 / #53, #54 — a runtime provider rejection used to look like a
    // clean finish, so the orchestrator parked the run as "Needs You" and the
    // user waited on an agent that was never coming back. The rejection has to
    // reach BOTH streams: v1 `error` is what fails the run, v2 `session.error`
    // is what the cockpit renders.
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
  S9: {
    // Group 4 / #5, #600 — a spawned sub-agent runs in its own child session
    // that emits a full lifecycle over the shared connection. Its terminal
    // signal used to end the PARENT turn, so the parent's remaining work was
    // attributed to a turn Squawk had already closed.
    assert: ({ backend, v1, v2, result }) => {
      // #149: child text stays nested on v2 and never contaminates parent text,
      // including AgentRunResult's fallback buffer and unfinished child deltas.
      const texts = v1.filter((e) => e.type === 'text').map((e) => e.text);
      expect(texts).toHaveLength(1);
      expect(texts[0]).not.toContain('Child review finished.');
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
  S3: {
    // Group 7 — `resumeCommand()` and "open in CLI" need a session id after
    // every run. The two wires differ and both are legitimate: codex, opencode
    // cursor and pi mint their own and echo a v1 `session` event, while claude pins
    // the id Squawk supplied (`--session-id`, claude-cli-runner.ts:385) and
    // returns it on the result. What must never happen is neither — that is a
    // run nobody can resume.
    assert: ({ v1, result }) => {
      const reported = sessionEvents(v1)[0]?.sessionId ?? result.sessionId;
      expect(reported ?? '').not.toBe('');
    },
  },
  S4: {
    // Group 7 — usage telemetry on both streams, not one.
    assert: ({ v1, v2 }) => {
      expect(v1.some((e) => e.type === 'token-usage' && e.tokensUsed > 0)).toBe(true);
      expect(v2.some((e) => e.type === 'usage.updated')).toBe(true);
    },
  },
  S10: {
    // Group 7 — the pid roots the run's process tree for resource telemetry (#348).
    assert: ({ pid }) => {
      expect(typeof pid).toBe('number');
    },
  },
};
export const SEAM_CRITERIA: readonly SeamCriterion[] = SEAM_ROWS.map(row => ({ ...row, ...SEAM_CELLS[row.id] }));

export function seamRows({ runners, parityRow }: HarnessRegistrar, criteria: readonly SeamCriterion[]): void {
  for (const backend of runners) {
    for (const criterion of criteria) {
      parityRow(backend, criterion, () => driveSeam(backend, criterion.scenario));
    }
  }
}
