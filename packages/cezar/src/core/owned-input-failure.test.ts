import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import { OpencodeServerRunner } from './opencode-server-runner.ts';
import type { AgentSession } from './agent-runner.ts';
import { waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

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
}

function activeState({ manager, runId }: Fixture) {
  return (manager as unknown as {
    active: Map<string, { session: AgentSession; agentInputError?: string }>;
  }).active.get(runId)!;
}

/** The checkpoint now follows the real HTTP ACK, so the previous fixture's
 * same-request fetch failure is impossible. Inject a secondary callback at the
 * observed interrupt instead; the ACK and disk fault themselves remain real. */
it.each(['fresh', 'continuation'] as const)('%s acknowledged input checkpoint remains primary over a later session error', async mode => {
  const start = OpencodeServerRunner.prototype.startSession;
  let emitError: (() => void) | undefined;
  const spy = vi.spyOn(OpencodeServerRunner.prototype, 'startSession').mockImplementation(function (this: OpencodeServerRunner, spec, onEvent, opts) {
    emitError = () => onEvent?.({ type: 'error', message: 'opencode: agent input failed: later transport failure' });
    return start.call(this, spec, onEvent, opts);
  });
  try {
    await withOwnedInputRun('opencode', 'baseline', async fixture => {
      await openSession(fixture, mode);
      const { store, manager, runId, repoRoot, parentRunId } = fixture;
      const state = activeState(fixture), checkpointsAtInterrupt: Array<string | undefined> = [];
      const interrupt = state.session.interrupt.bind(state.session);
      let injected = false;
      vi.spyOn(state.session, 'interrupt').mockImplementation(() => {
        checkpointsAtInterrupt.push(state.agentInputError);
        if (!injected) { injected = true; emitError?.(); }
        interrupt();
      });
      store.flush();
      const tmp = join(repoRoot, '.ai/cezar/runs.json.tmp');
      const observe = ({ event }: { event: { type: string } }) => {
        if (event.type === 'agent-input') mkdirSync(tmp);
      };
      const input = { id: randomUUID(), source: 'agent' as const, parentRunId, text: 'mock:hold', createdAt: new Date().toISOString() };
      store.on('event', observe);
      try {
        expect(manager.steerWorker(runId, input)).toBe('queued');
        await waitFor(() => injected);
        rmSync(tmp, { recursive: true, force: true });
        await waitFor(() => !manager.isActive(runId));
        const errors = store.readEvents(runId).filter(event => event.type === 'error').map(event => event.message);
        expect(checkpointsAtInterrupt[0]).toContain('agent input delivery checkpoint failed');
        expect(errors).toContain('opencode: agent input failed: later transport failure');
        expect(store.getRun(runId)?.status).toBe('failed');
        expect(store.getRun(runId)?.agentInputs).toEqual([input]);
        expect(store.getRun(runId)?.error).toContain('agent input delivery checkpoint failed');
      } finally {
        store.off('event', observe);
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  } finally { spy.mockRestore(); }
}, 60_000);

it.each(['fresh', 'continuation'] as const)('%s earlier provider failure remains primary over a later checkpoint error', async mode => {
  await withOwnedInputRun('opencode', 'baseline', async fixture => {
    await openSession(fixture, mode);
    const { store, manager, runId } = fixture;
    const state = activeState(fixture);
    const interrupt = state.session.interrupt.bind(state.session);
    let observedProviderInterrupt = false;
    vi.spyOn(state.session, 'interrupt').mockImplementation(() => {
      // Deliberately inject the later state at this test seam. The preceding
      // provider error is an actual HTTP/SSE wire frame, already latched by the
      // manager before it invokes interrupt. This is not a second disk-fault test.
      observedProviderInterrupt = true;
      state.agentInputError = 'agent input delivery checkpoint failed: later test fault';
      interrupt();
    });
    expect(manager.sendMessage(runId, [{ type: 'text', text: 'mock:provider-error' }])).toBe(true);
    await waitFor(() => !manager.isActive(runId));
    expect(observedProviderInterrupt).toBe(true);
    expect(store.readEvents(runId).some(event => event.type === 'error' && typeof event.message === 'string' && event.message.includes('API key expired'))).toBe(true);
    expect(store.getRun(runId)?.status).toBe('failed');
    expect(store.getRun(runId)?.error).toContain('API key expired');
    expect(store.getRun(runId)?.error).not.toContain('later test fault');
  });
}, 60_000);
