import type { ChildProcess } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Capture the real child only to break its OS transport; native mock frames and
// the production runner still own startup, input delivery and settlement.
const spawned = vi.hoisted(() => [] as ChildProcess[]);
const eventStreams = vi.hoisted(() => [] as IncomingMessage[]);
vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>();
  return { ...actual, request: ((...args: Parameters<typeof actual.request>) => {
    const request = actual.request(...args);
    request.on('response', response => {
      if (response.headers['content-type']?.includes('text/event-stream')) eventStreams.push(response);
    });
    return request;
  }) as typeof actual.request };
});
vi.mock('node:child_process', async (original) => {
  const actual = await original<typeof import('node:child_process')>();
  return { ...actual, spawn: ((...args: Parameters<typeof actual.spawn>) => {
    const child = actual.spawn(...args);
    spawned.push(child);
    return child;
  }) as typeof actual.spawn };
});
vi.mock('./runner-runtime.ts', async (original) => ({
  ...await original<typeof import('./runner-runtime.ts')>(),
  KILL_GRACE_MS: 100,
  EOF_TERM_GRACE_MS: 100,
  EOF_KILL_GRACE_MS: 100,
}));

import { RUNNER_IDS, type AgentEvent, type AgentSession, type RunnerId } from './agent-runner.js';
import { createRunner } from './runner-factory.js';
import { HARNESS_ADAPTERS, SHUTDOWN_CRITERIA, promptFor } from './harness-parity.testkit.js';

afterEach(() => vi.unstubAllEnvs());

async function withChild(backend: RunnerId, check: (session: AgentSession, child: ChildProcess, events: AgentEvent[], settled: Promise<unknown>) => Promise<void>) {
  const adapter = HARNESS_ADAPTERS[backend];
  const cwd = mkdtempSync(join(tmpdir(), `cez-shutdown-${backend}-`));
  vi.stubEnv('CEZ_DRY_RUN', '');
  vi.stubEnv(adapter.binEnv, adapter.mockBin);
  const events: AgentEvent[] = [];
  spawned.length = 0;
  eventStreams.length = 0;
  const session = createRunner(backend).startSession({
    cwd, userPrompt: promptFor(backend, 'no-progress'), timeoutMs: 0,
  }, event => events.push(event), { autoEndAfterFirstTurn: false });
  const settled = session.result.catch(error => error);
  try {
    // Wait for the PID contents, not merely file creation (which precedes the
    // write). Cursor can also replace its child while bootstrapping, so use the
    // native process that actually accepted this prompt, not the first spawn.
    const child = await vi.waitFor(() => {
      const pid = Number(readFileSync(join(cwd, 'watchdog.pid'), 'utf8'));
      const accepted = spawned.find(candidate => candidate.pid === pid);
      expect(accepted).toBeDefined();
      return accepted!;
    }, { timeout: 5000 });
    await check(session, child, events, settled);
  } finally {
    session.interrupt();
    for (const child of spawned) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    await settled;
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('runner shutdown parity (hearsay-tools/cezarion#843)', () => {
  const [outsideSignal, endEscalation, outputFailure] = SHUTDOWN_CRITERIA;
  for (const backend of RUNNER_IDS) {
    it(`${backend} ${outsideSignal.id} ${outsideSignal.name}`, async () => {
      await withChild(backend, async (_session, child, events, settled) => {
        child.kill('SIGKILL');
        const result = await settled;
        expect(result instanceof Error || events.some(event => event.type === 'error')).toBe(true);
        if (backend === 'pi' || backend === 'claude' || backend === 'codex') {
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).message).toContain('SIGKILL');
          expect(events.some(event => event.type === 'done')).toBe(false);
        }
      });
    }, 15_000);

    it(`${backend} ${endEscalation.id} ${endEscalation.name}`, async () => {
      await withChild(backend, async (session, child, events, settled) => {
        // Stop a native process after startup: neither EOF nor TERM can be
        // handled, but KILL must still settle the runner within its watchdog.
        child.kill('SIGSTOP');
        session.end();
        await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'), { timeout: 6000 });
        await expect(settled).resolves.not.toBeInstanceOf(Error);
        expect(events.filter(event => event.type === 'error')).toEqual([]);
      });
    }, 15_000);

    it(`${backend} ${outputFailure.id} ${outputFailure.name}`, async () => {
      await withChild(backend, async (session, child, events, settled) => {
        let exitedAtSettlement = false;
        void settled.then(() => {
          exitedAtSettlement = child.exitCode !== null || child.signalCode !== null;
        });
        child.kill('SIGSTOP');
        // OpenCode carries native output on HTTP/SSE, not subprocess stdout.
        const output = backend === 'opencode' ? eventStreams.at(-1)! : child.stdout!;
        expect(output).toBeDefined();
        output.destroy(new Error('stdout broke'));
        await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'), { timeout: 6000 });
        const result = await settled;
        expect(session.open).toBe(false);
        expect(result instanceof Error || events.some(event => event.type === 'error')).toBe(true);
        if (backend === 'pi' || backend === 'claude') {
          expect(exitedAtSettlement).toBe(true);
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).message).toBe('stdout broke');
        }
      });
    }, 15_000);
  }
});
