import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it, vi } from 'vitest';
import type { AgentSession } from './agent-runner.ts';
import { HARNESS_ADAPTERS, waitFor, withOwnedInputRun } from './harness-parity.testkit.ts';

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

/** Real HTTP fails on interruption before the real process exits. Normal mock
 * behavior is unchanged until armed; the runner's existing SIGKILL escalation
 * still bounds cleanup if the expected observation never arrives. */
async function withInterruptedHttp(body: (arm: () => void, acknowledge: () => void) => Promise<void>): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), 'cez-checkpoint-wire-'));
  const armed = join(root, 'armed'), observed = join(root, 'observed');
  // Narrow mutable test view; restored in finally within this isolated test file.
  const adapter = HARNESS_ADAPTERS.opencode as { mockBin: string };
  const original = adapter.mockBin;
  const mock = join(root, 'mock-opencode.mjs');
  const source = readFileSync(original, 'utf8');
  const importAnchor = "import { createServer } from 'node:http';";
  const exitAnchor = "process.on('SIGTERM', () => process.exit(0));";
  expect(source.split(importAnchor)).toHaveLength(2);
  expect(source.split(exitAnchor)).toHaveLength(2);
  writeFileSync(mock, source.replace(importAnchor, `${importAnchor}\nimport { existsSync } from 'node:fs';`)
    .replace(exitAnchor, `process.on('SIGTERM', () => {
      if (!existsSync(${JSON.stringify(armed)})) process.exit(0);
      server.closeAllConnections(); server.close();
      const timer = setInterval(() => {
        if (existsSync(${JSON.stringify(observed)})) { clearInterval(timer); process.exit(0); }
      }, 5);
    });`), { mode: 0o755 });
  adapter.mockBin = mock;
  try { await body(() => writeFileSync(armed, ''), () => writeFileSync(observed, '')); }
  finally {
    adapter.mockBin = original;
    rmSync(root, { recursive: true, force: true });
  }
}

it.each(['fresh', 'continuation'] as const)('%s checkpoint failure remains primary after interruption causes real OpenCode HTTP failure', async mode => {
  await withInterruptedHttp(async (arm, acknowledge) => {
    await withOwnedInputRun('opencode', 'baseline', async fixture => {
      await openSession(fixture, mode);
      const { store, manager, runId, repoRoot, parentRunId } = fixture;
      const state = activeState(fixture), checkpointsAtInterrupt: Array<string | undefined> = [];
      const interrupt = state.session.interrupt.bind(state.session);
      vi.spyOn(state.session, 'interrupt').mockImplementation(() => {
        checkpointsAtInterrupt.push(state.agentInputError);
        interrupt();
      });
      store.flush();
      const tmp = join(repoRoot, '.ai/cezar/runs.json.tmp');
      const observe = ({ event }: { event: { type: string; message?: string } }) => {
        if (event.type === 'agent-input') mkdirSync(tmp);
        if (event.type === 'error' && event.message === 'opencode: agent input failed: fetch failed') acknowledge();
      };
      const input = { id: randomUUID(), source: 'agent' as const, parentRunId, text: 'mock:hold', createdAt: new Date().toISOString() };
      arm(); store.on('event', observe);
      try {
        try { expect(() => manager.steerWorker(runId, input)).toThrow(/agent input delivery checkpoint failed/); }
        finally { rmSync(tmp, { recursive: true, force: true }); }
        await waitFor(() => !manager.isActive(runId));
        const errors = store.readEvents(runId).filter(event => event.type === 'error').map(event => event.message);
        expect(checkpointsAtInterrupt[0]).toContain('agent input delivery checkpoint failed');
        expect(errors[0]).toContain('agent input delivery checkpoint failed');
        expect(errors).toContain('opencode: agent input failed: fetch failed');
        expect(store.getRun(runId)?.status).toBe('failed');
        expect(store.getRun(runId)?.agentInputs).toEqual([input]);
        expect(store.getRun(runId)?.error).toContain('agent input delivery checkpoint failed');
      } finally {
        acknowledge(); store.off('event', observe);
        rmSync(tmp, { recursive: true, force: true });
      }
    });
  });
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
