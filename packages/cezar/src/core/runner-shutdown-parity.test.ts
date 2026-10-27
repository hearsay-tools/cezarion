import * as childProcess from 'node:child_process';
import { execFileSync, type ChildProcess } from 'node:child_process';
import type { IncomingMessage } from 'node:http';
import * as fs from 'node:fs';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UNSET_TOOL_GRANT } from './tool-grant.testkit.ts';

// Capture the real child only to break its OS transport; native mock frames and
// the production runner still own startup, input delivery and settlement.
const spawned = vi.hoisted(() => [] as ChildProcess[]);
const eventStreams = vi.hoisted(() => [] as IncomingMessage[]);
const streamClosure = vi.hoisted(() => ({ gate: undefined as Promise<void> | undefined }));
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
vi.mock('node:http', async (original) => {
  const actual = await original<typeof import('node:http')>();
  return { ...actual, request: ((...args: Parameters<typeof actual.request>) => {
    const request = actual.request(...args);
    request.on('response', response => {
      if (response.headers['content-type']?.includes('text/event-stream')) {
        eventStreams.push(response);
        const gate = streamClosure.gate;
        if (gate) {
          const iterate = response[Symbol.asyncIterator].bind(response);
          response[Symbol.asyncIterator] = async function* () {
            try { yield* iterate(); } finally { await gate; }
            return undefined;
          };
        }
      }
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
const eofGrace = vi.hoisted(() => ({ termMs: 100 }));
vi.mock('./runner-runtime.ts', async (original) => ({
  ...await original<typeof import('./runner-runtime.ts')>(),
  KILL_GRACE_MS: 100,
  // Read at each use, so S30 can leave a leader that exits on EOF time to do so on its own.
  get EOF_TERM_GRACE_MS() { return eofGrace.termMs; },
  EOF_KILL_GRACE_MS: 100,
}));

import { RUNNER_IDS, type AgentEvent, type AgentSession, type RunnerId } from './agent-runner.js';
import { createRunner } from './runner-factory.js';
import { HARNESS_ADAPTERS, SHUTDOWN_CRITERIA, promptFor } from './harness-parity.testkit.js';
import { killFromPidFile, readPid, requirePid } from '../pid-file.testkit.js';

afterEach(() => { vi.unstubAllEnvs(); vi.restoreAllMocks(); });

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
  // bound: wait for the fixture's native process receipt on a loaded host.
  return vi.waitFor(() => {
    const [group, session] = ['leftover-group.pid', 'leftover-session.pid'].map(file => requirePid(join(cwd, file)));
    return { group: group!, session: session! };
  }, { timeout: 10_000 });
}

async function withChild(backend: RunnerId, check: (session: AgentSession, child: ChildProcess, events: AgentEvent[], settled: Promise<unknown>, cwd: string) => Promise<void>, scenario: 'no-progress' | 'no-progress-leftover' | 'no-progress-ignore-term' = 'no-progress') {
  const adapter = HARNESS_ADAPTERS[backend];
  const cwd = mkdtempSync(join(tmpdir(), `cez-shutdown-${backend}-`));
  vi.stubEnv('CEZ_DRY_RUN', '');
  vi.stubEnv(adapter.binEnv, adapter.mockBin);
  const events: AgentEvent[] = [];
  spawned.length = 0;
  eventStreams.length = 0;
  const session = createRunner(backend).startSession({ toolGrant: UNSET_TOOL_GRANT,
    cwd, userPrompt: promptFor(backend, scenario), timeoutMs: 0,
  }, event => events.push(event), { autoEndAfterFirstTurn: false });
  const settled = session.result.catch(error => error);
  try {
    // Wait for the PID contents, not merely file creation (which precedes the
    // write). Cursor can also replace its child while bootstrapping, so use the
    // native process that actually accepted this prompt, not the first spawn.
    // bound: wait for the fixture's native process receipt on a loaded host.
    const child = await vi.waitFor(() => {
      const pid = readPid(join(cwd, 'watchdog.pid'));
      const accepted = spawned.find(candidate => candidate.pid === pid);
      expect(accepted).toBeDefined();
      return accepted!;
    }, { timeout: 10_000 });
    await check(session, child, events, settled, cwd);
  } finally {
    session.interrupt();
    for (const child of spawned) {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
    for (const file of ['leftover-group.pid', 'leftover-session.pid']) killFromPidFile(join(cwd, file));
    await settled;
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** Deny evidence only: actual signal delivery, native frames and exit status stay real. */
function denyExitEvidence(child: ChildProcess, psFailure: 'unavailable' | 'timeout' = 'unavailable'): void {
  const read = fs.readFileSync;
  vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof read>) => {
    if (args[0] === `/proc/${child.pid}/stat`) throw Object.assign(new Error('unreadable proc'), { code: 'EACCES' });
    return read(...args);
  }) as typeof read);
  const kill = process.kill;
  vi.spyOn(process, 'kill').mockImplementation((pid, signal) => {
    if (pid === child.pid && signal === 0) throw Object.assign(new Error('denied probe'), { code: 'EPERM' });
    return kill(pid, signal);
  });
  const exec = childProcess.execFile;
  vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
    if (args[0] === 'ps') {
      if (psFailure === 'timeout') return Object.assign(new childProcess.ChildProcess(), { kill: vi.fn(() => true) });
      throw Object.assign(new Error('ps unavailable'), { code: 'ENOENT' });
    }
    return Reflect.apply(exec, childProcess, args);
  }) as typeof exec);
}

// Test limits cover each independent 10 s step guard plus settlement and cleanup.
// Group cases also wait for leftover receipts and reaping; EOF adds its own 10 s grace.
describe('runner shutdown parity (hearsay-tools/cezarion#843)', () => {
  const [outsideSignal, endEscalation, outputFailure, ownGroup, stopGroup, endGroup, /* S29: omp-input-pipe.test.ts */, ownExit, outsideKill, lateOutsideSignal, unknownOutsideSignal] = SHUTDOWN_CRITERIA;
  for (const backend of RUNNER_IDS) {
    it(`${backend} ${outsideSignal.id} ${outsideSignal.name}`, async () => {
      // Process exit must classify the failure even when HTTP stream closure
      // arrives later. Keep native SSE frames, but hold its terminal notification.
      let releaseStream!: () => void;
      streamClosure.gate = new Promise<void>(resolve => { releaseStream = resolve; });
      try {
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
      } finally {
        releaseStream();
        streamClosure.gate = undefined;
      }
    }, 15_000);

    for (const criterion of [lateOutsideSignal, unknownOutsideSignal]) {
    it(`${backend} ${criterion.id} ${criterion.name}`, async () => {
      await withChild(backend, async (_session, child, events, settled) => {
        if (criterion === unknownOutsideSignal) denyExitEvidence(child);
        const handle = (child as unknown as { _handle: { onexit: (...args: unknown[]) => void } })._handle;
        const onexit = handle.onexit;
        handle.onexit = function (...args) {
          // Delay the real OS result beyond EOF cleanup; preserve its exact status.
          setTimeout(() => onexit.apply(this, args), 250);
        };
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

    }

    it(`${backend} ${endEscalation.id} ${endEscalation.name}`, async () => {
      await withChild(backend, async (session, child, events, settled) => {
        // Stop a native process after startup: neither EOF nor TERM can be
        // handled, but KILL must still settle the runner within its watchdog.
        child.kill('SIGSTOP');
        session.end();
        // bound: wait for SIGKILL delivery and native process exit.
        await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'), { timeout: 10_000 });
        await expect(settled).resolves.not.toBeInstanceOf(Error);
        expect(events.filter(event => event.type === 'error')).toEqual([]);
      });
    }, 30_000);

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
        // bound: wait for SIGKILL delivery and native process exit.
        await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'), { timeout: 10_000 });
        const result = await settled;
        expect(session.open).toBe(false);
        expect(result instanceof Error || events.some(event => event.type === 'error')).toBe(true);
        if (backend === 'pi' || backend === 'claude') {
          expect(exitedAtSettlement).toBe(true);
          expect(result).toBeInstanceOf(Error);
          expect((result as Error).message).toBe('stdout broke');
        }
      });
    }, 30_000);

    // hearsay-tools/cezarion#890: what the agent leaves in its process group ends with it.
    it.skipIf(process.platform === 'win32')(`${backend} ${ownGroup.id} ${ownGroup.name}`, async () => {
      await withChild(backend, async (_session, child, _events, _settled, cwd) => {
        await leftovers(cwd);
        expect(execFileSync('ps', ['-o', 'pgid=', '-p', String(child.pid)], { encoding: 'utf8' }).trim()).toBe(String(child.pid));
      }, 'no-progress-leftover');
    }, 30_000);

    it.skipIf(process.platform === 'win32')(`${backend} ${stopGroup.id} ${stopGroup.name}`, async () => {
      await withChild(backend, async (session, _child, _events, settled, cwd) => {
        const { group, session: setsid } = await leftovers(cwd);
        session.interrupt();
        await settled;
        // bound: wait for process-group cleanup and reaping on a loaded host.
        await vi.waitFor(() => expect(alive(group)).toBe(false), { timeout: 10_000 });
        expect(alive(setsid)).toBe(true);
      }, 'no-progress-leftover');
    }, 40_000);

    it.skipIf(process.platform === 'win32')(`${backend} ${endGroup.id} ${endGroup.name}`, async () => {
      await withChild(backend, async (session, child, _events, settled, cwd) => {
        const { group, session: setsid } = await leftovers(cwd);
        child.kill('SIGSTOP');
        session.end();
        // bound: wait for SIGKILL delivery and native process exit.
        await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'), { timeout: 10_000 });
        await settled;
        // bound: wait for process-group cleanup and reaping on a loaded host.
        await vi.waitFor(() => expect(alive(group)).toBe(false), { timeout: 10_000 });
        expect(alive(setsid)).toBe(true);
      }, 'no-progress-leftover');
    }, 50_000);

    // hearsay-tools/cezarion#1286: cezar signals nothing when the agent exits on EOF, so the stdio MCP
    // servers and background jobs it left in its group are ended by the reap after its exit.
    // OpenCode's runner and Cursor print end by a cezar signal on end (S27/S28's path), so their
    // cells do not reach the reap; S31 does.
    it.skipIf(process.platform === 'win32')(`${backend} ${ownExit.id} ${ownExit.name}`, async () => {
      const signalsOnEnd = backend === 'opencode' || backend === 'cursor';
      // Past any EOF exit and short of the test timeout: only the leader's own exit settles it.
      if (!signalsOnEnd) eofGrace.termMs = 10_000;
      try {
        await withChild(backend, async (session, child, _events, settled, cwd) => {
          const { group, session: setsid } = await leftovers(cwd);
          session.end();
          await settled;
          if (!signalsOnEnd) expect(child.signalCode).toBeNull();
          // bound: the exit drain, the grace, then signal delivery and reaping by the subreaper.

          await vi.waitFor(() => expect(alive(group)).toBe(false), { timeout: 10_000 });
          expect(alive(setsid)).toBe(true);
        }, 'no-progress-leftover');
      } finally {
        eofGrace.termMs = 100;
      }
    }, 50_000);

    // hearsay-tools/cezarion#1286: a leader killed from outside (a crash, the OOM killer) gets no
    // signal from cezar, so only what cezar does after its exit ends what it left in its group.
    it.skipIf(process.platform === 'win32')(`${backend} ${outsideKill.id} ${outsideKill.name}`, async () => {
      await withChild(backend, async (_session, child, _events, settled, cwd) => {
        const { group, session: setsid } = await leftovers(cwd);
        child.kill('SIGKILL');
        await settled;
        // bound: the exit drain, the grace, then signal delivery and reaping by the subreaper.

        await vi.waitFor(() => expect(alive(group)).toBe(false), { timeout: 10_000 });
        expect(alive(setsid)).toBe(true);
      }, 'no-progress-leftover');
    }, 40_000);

    // hearsay-tools/cezarion#1625: N5 signals as soon as `watchdog.pid` appears. A mock that
    // published it before replacing its SIGTERM handler died from that SIGTERM.
    it(`${backend} an ignore-term stall survives SIGTERM sent as soon as it publishes its pid`, async () => {
      const preloadDir = mkdtempSync(join(tmpdir(), `cez-sigterm-gap-${backend}-`));
      const preload = join(preloadDir, 'pause-signal-setup.mjs');
      // Model preemption while the default SIGTERM action applies: before a handler
      // install with no listener left. Readiness must not let the test signal in this gap.
      writeFileSync(preload, `
const on = process.on;
process.on = function(event, listener) {
  // bound: widen the handler-install gap well past the test's pid poll.
  if (event === 'SIGTERM' && process.listenerCount('SIGTERM') === 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);
  return on.call(this, event, listener);
};
`);
      vi.stubEnv('NODE_OPTIONS', `${process.env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim());
      try {
        await withChild(backend, async (_session, child) => {
          child.kill('SIGTERM');
          // bound: proves an exit did NOT happen; the default action kills within
          // milliseconds, so this window can only miss a death, never invent one.
          await new Promise(resolve => setTimeout(resolve, 300));
          expect(child.signalCode).toBeNull();
          expect(alive(child.pid!)).toBe(true);
        }, 'no-progress-ignore-term');
      } finally {
        rmSync(preloadDir, { recursive: true, force: true });
      }
    }, 15_000);

    if (backend === 'pi' || backend === 'claude') {
      it(`${backend} reaps a live child after stdout ends cleanly`, async () => {
        await withChild(backend, async (session, child, _events, settled) => {
          child.kill('SIGSTOP');
          child.stdout!.push(null);
          // bound: wait for SIGKILL delivery and native process exit.
          await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'), { timeout: 10_000 });
          await settled;
          expect(session.open).toBe(false);
        });
      }, 30_000);
    }
  }
});

// These adapters use clean output EOF to start bounded cleanup. Other native
// transports keep their own S23/S24 guards; S33 above covers every runner.
for (const backend of ['claude', 'codex', 'pi'] as const) {
  it(`${backend} keeps live EOF cleanup bounded with unavailable process evidence`, async () => {
    await withChild(backend, async (session, child, _events, settled) => {
      const read = fs.readFileSync;
      vi.spyOn(fs, 'readFileSync').mockImplementation(((...args: Parameters<typeof read>) => {
        if (args[0] === `/proc/${child.pid}/stat`) throw Object.assign(new Error('unreadable proc'), { code: 'EACCES' });
        return read(...args);
      }) as typeof read);
      // This case requires positive fallback evidence, independent of ps startup speed.
      // Native stop/EOF/signals and exit status remain real. Unknown evidence has its own case.
      vi.spyOn(childProcess, 'execFile').mockImplementation(((...args: unknown[]) => {
        expect(args[0]).toBe('ps');
        const callback = args.at(-1) as (error: Error | null, stdout: string, stderr: string) => void;
        queueMicrotask(() => callback(null, 'T', ''));
        return Object.assign(new childProcess.ChildProcess(), { exitCode: 0 });
      }) as typeof childProcess.execFile);
      child.kill('SIGSTOP');
      child.stdout!.push(null);
      // bound: a stopped child ignores TERM, so cleanup must still escalate.
      await vi.waitFor(() => expect(child.signalCode).toBe('SIGKILL'), { timeout: 10_000 });
      await expect(settled).resolves.not.toBeInstanceOf(Error);
      expect(session.open).toBe(false);
    });
  }, 15_000);
}

// Intent has precedence until native exit. It never postpones automatic escalation.
for (const backend of ['claude', 'codex', 'pi'] as const) {
  it.each(['unavailable', 'timeout'] as const)(`${backend} unknown automatic EOF cleanup fails but still reaps the live child (%s)`, async psFailure => {
    await withChild(backend, async (session, child, events, settled) => {
      denyExitEvidence(child, psFailure);
      child.kill('SIGSTOP');
      child.stdout!.push(null);
      const result = await settled;
      expect(child.signalCode).toBe('SIGKILL');
      expect(result).toBeInstanceOf(Error);
      expect((result as Error).message).toContain('SIGKILL');
      expect(events.some(event => event.type === 'done')).toBe(false);
      expect(session.open).toBe(false);
    });
  }, 15_000);

  for (const intent of ['end', 'interrupt'] as const) {
    for (const when of ['before EOF', 'during probe', 'after TERM'] as const) {
      it(`${backend} explicit ${intent} ${when} wins over unknown automatic cleanup`, async () => {
        await withChild(backend, async (session, child, events, settled) => {
          denyExitEvidence(child);
          child.kill('SIGSTOP');
          const kill = child.kill.bind(child);
          let applyIntent = when === 'after TERM';
          const signals = vi.spyOn(child, 'kill').mockImplementation(signal => {
            const sent = kill(signal);
            if (signal === 'SIGTERM' && applyIntent) {
              applyIntent = false;
              queueMicrotask(() => session[intent]());
            }
            return sent;
          });
          if (when === 'during probe') vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
          try {
            if (when === 'before EOF') session[intent]();
            child.stdout!.push(null);
            if (when === 'during probe') {
              // Drain the real stream while holding every cleanup timeout at its origin.
              await new Promise<void>(resolve => setImmediate(resolve));
              expect(session.open).toBe(false);
              expect(signals).not.toHaveBeenCalledWith('SIGTERM');
              session[intent]();
              await vi.advanceTimersByTimeAsync(500);
            }
          } finally { if (when === 'during probe') vi.useRealTimers(); }
          await expect(settled).resolves.not.toBeInstanceOf(Error);
          expect(child.signalCode).toBe('SIGKILL');
          expect(events.filter(event => event.type === 'error')).toEqual([]);
        });
      }, 15_000);
    }
  }
}

for (const backend of ['claude', 'codex', 'pi'] as const) {
  it(`${backend} interrupt during automatic cleanup keeps the earlier KILL deadline`, async () => {
    await withChild(backend, async (session, child, _events, settled) => {
      denyExitEvidence(child);
      child.kill('SIGSTOP');
      const kill = vi.spyOn(child, 'kill');
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      try {
        child.stdout!.push(null);
        // Let the real native stream finish while only timeout timers are controlled.
        await new Promise<void>(resolve => setImmediate(resolve));
        expect(session.open).toBe(false);
        await vi.advanceTimersByTimeAsync(backend === 'codex' ? 100 : 50);
        expect(kill).toHaveBeenCalledWith('SIGTERM');
        await vi.advanceTimersByTimeAsync(50);
        session.interrupt();
        await vi.advanceTimersByTimeAsync(49);
        expect(kill).not.toHaveBeenCalledWith('SIGKILL');
        await vi.advanceTimersByTimeAsync(1);
        expect(kill).toHaveBeenCalledWith('SIGKILL');
      } finally { vi.useRealTimers(); }
      await expect(settled).resolves.not.toBeInstanceOf(Error);
    });
  }, 15_000);
}
