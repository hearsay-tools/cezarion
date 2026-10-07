import { execFileSync, type ChildProcess } from 'node:child_process';
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

/** A zombie has exited; only its reaper's wait remains. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z';
  } catch { return false; }
}

/** The two children the leftover scenario leaves in the session's cwd. */
async function leftovers(cwd: string): Promise<{ group: number; session: number }> {
  return vi.waitFor(() => {
    const [group, session] = ['leftover-group.pid', 'leftover-session.pid'].map(file => Number(readFileSync(join(cwd, file), 'utf8')));
    expect(group).toBeGreaterThan(0);
    expect(session).toBeGreaterThan(0);
    return { group: group!, session: session! };
  }, { timeout: 5000 });
}

async function withChild(backend: RunnerId, check: (session: AgentSession, child: ChildProcess, events: AgentEvent[], settled: Promise<unknown>, cwd: string) => Promise<void>, scenario: 'no-progress' | 'no-progress-leftover' = 'no-progress') {
  const adapter = HARNESS_ADAPTERS[backend];
  const cwd = mkdtempSync(join(tmpdir(), `cez-shutdown-${backend}-`));
  vi.stubEnv('CEZ_DRY_RUN', '');
  vi.stubEnv(adapter.binEnv, adapter.mockBin);
  const events: AgentEvent[] = [];
  spawned.length = 0;
  eventStreams.length = 0;
  const session = createRunner(backend).startSession({
    cwd, userPrompt: promptFor(backend, scenario), timeoutMs: 0,
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
    await check(session, child, events, settled, cwd);
  } finally {
    session.interrupt();
    for (const child of spawned) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const file of ['leftover-group.pid', 'leftover-session.pid']) {
      try { process.kill(Number(readFileSync(join(cwd, file), 'utf8')), 'SIGKILL'); } catch { /* none, or gone */ }
    }
    await settled;
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('runner shutdown parity (hearsay-tools/cezarion#843)', () => {
  const [outsideSignal, endEscalation, outputFailure, ownGroup, stopGroup, endGroup] = SHUTDOWN_CRITERIA;
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

    // hearsay-tools/cezarion#890: what the agent leaves in its process group ends with it.
    it.skipIf(process.platform === 'win32')(`${backend} ${ownGroup.id} ${ownGroup.name}`, async () => {
      await withChild(backend, async (_session, child, _events, _settled, cwd) => {
        await leftovers(cwd);
        expect(execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()).toBe(String(child.pid));
      }, 'no-progress-leftover');
    }, 15_000);

    it.skipIf(process.platform === 'win32')(`${backend} ${stopGroup.id} ${stopGroup.name}`, async () => {
      await withChild(backend, async (session, _child, _events, settled, cwd) => {
        const { group, session: setsid } = await leftovers(cwd);
        session.interrupt();
        await settled;
        await vi.waitFor(() => expect(alive(group)).toBe(false), { timeout: 6000 });
        expect(alive(setsid)).toBe(true);
      }, 'no-progress-leftover');
    }, 15_000);

    it.skipIf(process.platform === 'win32')(`${backend} ${endGroup.id} ${endGroup.name}`, async () => {
      await withChild(backend, async (session, child, _events, settled, cwd) => {
        const { group, session: setsid } = await leftovers(cwd);
        child.kill('SIGSTOP');
        session.end();
        await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'), { timeout: 6000 });
        await settled;
        await vi.waitFor(() => expect(alive(group)).toBe(false), { timeout: 6000 });
        expect(alive(setsid)).toBe(true);
      }, 'no-progress-leftover');
    }, 15_000);

    if (backend === 'pi' || backend === 'claude') {
      it(`${backend} reaps a live child after stdout ends cleanly`, async () => {
        await withChild(backend, async (session, child, _events, settled) => {
          child.kill('SIGSTOP');
          child.stdout!.push(null);
          await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'), { timeout: 6000 });
          await settled;
          expect(session.open).toBe(false);
        });
      }, 15_000);
    }
  }
});
