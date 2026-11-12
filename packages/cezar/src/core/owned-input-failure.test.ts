import { captureSessions } from '../workflows/runner-session-capture.testkit.ts';
import { agentInputSchema } from '@open-mercato/cezar-contract/delegation';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentSession } from './agent-runner.ts';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import { waitFor } from './harness-parity.testkit.ts';
import { withOwnedInputRun } from './workflow-parity.testkit.ts';
import { blockRunWrites, muteLockedDatabaseLogs } from '../runs/run-store.testkit.ts';

type Fixture = Parameters<Parameters<typeof withOwnedInputRun>[2]>[0];

async function openSession(fixture: Fixture, mode: 'fresh' | 'continuation'): Promise<void> {
  const { manager, store, runId } = fixture;
  manager.enqueueOwnedRun(runId);
  await waitFor(() => store.getRun(runId)?.status === 'waiting');
  if (mode === 'continuation') {
    manager.finish(runId);
    await waitFor(() => !manager.isActive(runId));
    expect(manager.continueRun(runId, { text: 'continue baseline' }).ok).toBe(true);
    await waitFor(() => manager.isActive(runId) && store.getRun(runId)?.status === 'waiting');
  }
  // The idle worker parks on Cezar's fallback question, routed to its parent
  // (hearsay-tools/cezarion#1301, hearsay-tools/cezarion#2410).
  await waitFor(() => store.transcriptFacts(runId).pendingAsk?.routedMessageId !== undefined);
}

/** The checkpoint now follows the real HTTP ACK, so the previous fixture's
 * same-request fetch failure is impossible. Inject a secondary callback at the
 * observed interrupt instead; the ACK and disk fault themselves remain real. */
it.each(['fresh', 'continuation'] as const)('%s acknowledged input checkpoint remains primary over a later session error', async mode => {
  let ownedSession: AgentSession;
  const start = OpencodeServerRunner.prototype.startSession;
  let emitError: (() => void) | undefined;
  const spy = vi.spyOn(OpencodeServerRunner.prototype, 'startSession').mockImplementation(function (this: OpencodeServerRunner, spec, onEvent, opts) {
    emitError = () => onEvent?.({ type: 'error', message: 'opencode: agent input failed: later transport failure' });
    ownedSession = start.call(this, spec, onEvent, opts);
    return ownedSession;
  });
  try {
    await withOwnedInputRun('opencode', 'baseline', async fixture => {
      await openSession(fixture, mode);
      const { store, manager, runId, repoRoot, parentRunId } = fixture;
      const session = ownedSession!;
      const interrupt = session.interrupt.bind(session);
      const checkpointReports = () => store.readEvents(runId).filter(event => event.type === 'error' &&
        typeof event.message === 'string' && event.message.includes('agent input delivery checkpoint failed'));
      const reportsAtInterrupt: number[] = [];
      let injected = false;
      vi.spyOn(session, 'interrupt').mockImplementation(() => {
        reportsAtInterrupt.push(checkpointReports().length);
        expect(checkpointReports()).toEqual([]);
        if (!injected) { injected = true; emitError?.(); }
        interrupt();
        expect(checkpointReports()).toEqual([]);
      });
      store.flush();
      let unblock: (() => void) | undefined;
      // The input supersedes that question with a write to the parent's conversation first; the
      // failure injected here is the input's own delivery checkpoint, after it.
      const observe = ({ event }: { event: { type: string; reason?: unknown } }) => {
        if (event.type === 'human-ask-closed' && event.reason === 'superseded') unblock ??= blockRunWrites(join(repoRoot, '.ai/cezar'));
      };
      const input = { id: randomUUID(), source: agentInputSchema.shape.source.enum.agent, parentRunId, text: 'mock:hold', createdAt: new Date().toISOString() };
      store.on('event', observe);
      const unmute = muteLockedDatabaseLogs();
      try {
        expect(manager.steerWorker(runId, input)).toBe('queued');
        await waitFor(() => injected);
        unblock?.();
        await waitFor(() => !manager.isActive(runId));
        const errors = store.readEvents(runId).filter(event => event.type === 'error').map(event => event.message);
        expect(reportsAtInterrupt.length).toBeGreaterThan(0);
        expect(reportsAtInterrupt.every(count => count === 0)).toBe(true);
        expect(checkpointReports()).toHaveLength(1);
        expect(errors).toContain('opencode: agent input failed: later transport failure');
        expect(store.getRun(runId)?.status).toBe('failed');
        expect(store.getRun(runId)?.agentInputs).toEqual([input]);
        expect(store.getRun(runId)?.error).toContain('agent input delivery checkpoint failed');
      } finally {
        store.off('event', observe);
        unblock?.();
        unmute();
      }
    });
  } finally { spy.mockRestore(); }
}, 60_000);

it.each(['fresh', 'continuation'] as const)('%s provider failure is recorded before the real session interrupt', async mode => {
  const sessionOf = captureSessions();
  await withOwnedInputRun('opencode', 'baseline', async fixture => {
    await openSession(fixture, mode);
    const { store, manager, runId } = fixture;
    const session = sessionOf(runId);
    const interrupt = session.interrupt.bind(session);
    let observedProviderInterrupt = false;
    vi.spyOn(session, 'interrupt').mockImplementation(() => {
      observedProviderInterrupt = true;
      expect(store.readEvents(runId).some(event => event.type === 'error' &&
        typeof event.message === 'string' && event.message.includes('invalid_request_error'))).toBe(true);
      interrupt();
    });
    expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:provider-error' }])).toBe(true);
    await waitFor(() => !manager.isActive(runId));
    expect(observedProviderInterrupt).toBe(true);
    expect(store.readEvents(runId).some(event => event.type === 'error' && typeof event.message === 'string' && event.message.includes('invalid_request_error'))).toBe(true);
    expect(store.getRun(runId)?.status).toBe('failed');
    expect(store.getRun(runId)?.error).toContain('(HTTP 400)');
  });
}, 60_000);
