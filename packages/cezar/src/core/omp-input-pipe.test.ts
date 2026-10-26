import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNNER_IDS } from './agent-runner.ts';
import { HARNESS_ADAPTERS, exemptionFor, driveSeam, promptFor, waitFor } from './harness-parity.testkit.ts';

describe('OMP native input pipe', () => {
  it('fails queued-before-ready writes even when the child would exit zero', async () => {
    const obs = await driveSeam('omp', 'closed-input', {
      whileOpen: async session => {
        await expect(session.result).rejects.toThrow(/omp.*input.*EPIPE/i);
        expect(session.open).toBe(false);
        expect(session.sendMessage([{ type: 'text', text: 'later input' }])).toBe(false);
        expect(session.sendAgentMessage([{ type: 'text', text: 'later agent input' }])).toBe(false);
      },
    });
    expect(obs.failure?.message).toMatch(/omp.*input.*EPIPE/i);
    expect(obs.v1.filter(e => e.type === 'error')).toHaveLength(1);
    expect(obs.v1.some(e => e.type === 'done' || e.type === 'turn-end')).toBe(false);
    expect(obs.elapsedMs).toBeLessThan(5000);
  }, 10000);
});

describe('native live closed-input parity', () => {
  for (const backend of RUNNER_IDS) {
    const exemption = exemptionFor('S29', backend);
    if (exemption) {
      it(`${backend} S29 executable wire gap — ${exemption.reason}`, () => {
        expect(exemption.kind).toBe('scenario-unconstructible');
        expect(HARNESS_ADAPTERS[backend].scenarios['input-closed-live']).toBeUndefined();
      });
      continue;
    }
    it(`${backend} surfaces closed-input failure S29`, async () => {
      const cwd = mkdtempSync(join(tmpdir(), 'cez-input-pipe-'));
      try {
        let receiptError: unknown;
        const obs = await driveSeam(backend, 'input-closed-live', {
          spec: { cwd, ...(backend === 'pi' || backend === 'omp' ? { userPrompt: `${promptFor(backend, 'input-closed-live')} mock:gate-prompt-ack` } : {}) },
          whileOpen: async session => {
            // The mock's real closeSync(0) precedes its marker. The session's cwd is
            // passed through the production spawn; no normalized events are injected.
            // bound: wait for the fixture's native process receipt on a loaded host.
            await vi.waitFor(() => expect(existsSync(join(cwd, 'input-closed.pid'))).toBe(true), { timeout: 10_000 });
            expect(session.open).toBe(true);
            if (backend === 'pi' || backend === 'omp') {
              expect(session.holdsHumanInput?.()).toBe(true);
              writeFileSync(join(cwd, 'input-ack.release'), 'release native prompt acknowledgement');
              // hearsay-tools/cezarion#974: the fd-close marker can beat stdout's
              // initial Pi/OMP prompt ACK (CI refused Pi input at 68ms). A native ACK gate
              // reproduces that ordering; wait for admission before testing EPIPE.
              // bound: wait for the pending human-input queue to drain.
              await vi.waitFor(() => expect(session.holdsHumanInput?.()).toBe(false), { timeout: 10_000 });
            }
            // Codex can report `open` before the first main-thread turn exists, so
            // sendAgentMessage still returns false (hearsay-tools/cezarion#969). Poll
            // Codex admission; Pi/OMP admission is confirmed by the native ACK above.
            let receipt: false | Promise<void> = false;
            if (backend === 'codex') {
              await waitFor(() => {
                if (receipt !== false) return true;
                receipt = session.sendAgentMessage([{ type: 'text', text: 'force broken native agent input write' }]);
                return receipt !== false || !session.open;
              });
            } else {
              receipt = session.sendAgentMessage([{ type: 'text', text: 'force broken native agent input write' }]);
            }

            expect(receipt).not.toBe(false);
            if (!receipt) throw new Error('native input was refused before exercising its transport');
            await receipt.catch((error: unknown) => { receiptError = error; });
            expect(receiptError).toBeInstanceOf(Error);
            expect((receiptError as Error).message).toMatch(/EPIPE|stdin|input|fetch failed/i);
            if (backend === 'omp' || backend === 'pi') {
              // A broken Pi/OMP pipe must close admission immediately.
              expect(session.sendMessage([{ type: 'text', text: 'later human input' }])).toBe(false);
              expect(session.sendAgentMessage([{ type: 'text', text: 'later agent input' }])).toBe(false);
            }
            await session.result.catch(() => undefined);
            expect(session.sendMessage([{ type: 'text', text: 'input after settlement' }])).toBe(false);
            expect(session.sendAgentMessage([{ type: 'text', text: 'agent input after settlement' }])).toBe(false);
          },
        });
        expect(receiptError).toBeInstanceOf(Error);
        if (backend === 'pi') {
          expect(obs.failure?.message).toMatch(/pi.*input.*EPIPE/i);
          expect(obs.v1.filter(e => e.type === 'error')).toHaveLength(1);
          expect(obs.v2.filter(e => e.type === 'session.error')).toEqual([
            { type: 'session.error', message: obs.failure?.message, fatal: true },
          ]);
          expect(obs.v1.some(e => e.type === 'done' || e.type === 'turn-end')).toBe(false);
        }
        // OpenCode's native contract synthesizes a terminal turn boundary on failure.
        // It must never present that boundary as a successful model completion.
        expect(obs.v2.some(e => e.type === 'turn.completed' && e.stopReason === 'end_turn')).toBe(false);
        const error = obs.v1.findIndex(e => e.type === 'error');
        const done = obs.v1.findIndex(e => e.type === 'done');
        if (done >= 0 && error >= 0) expect(error).toBeLessThan(done);
        expect(obs.elapsedMs).toBeLessThan(5000);
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
      // Marker wait is 5s; Codex then polls waitFor (10s default) after that.
      // 10s total cannot cover both plus teardown (hearsay-tools/cezarion#976).
    }, 20_000);
  }
});

describe('Pi native input teardown', () => {
  it.each(['end', 'interrupt'] as const)('%s observes a broken pipe without reporting a new failure', async action => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-pi-input-teardown-'));
    try {
      const obs = await driveSeam('pi', 'input-closed-live', {
        spec: { cwd },
        whileOpen: async session => {
          // bound: wait for the fixture's native process receipt on a loaded host.
          await vi.waitFor(() => expect(existsSync(join(cwd, 'input-closed.pid'))).toBe(true), { timeout: 10_000 });
          expect(session.open).toBe(true);
          session[action]();
          await expect(session.result).resolves.toBeDefined();
          expect(session.open).toBe(false);
        },
      });
      expect(obs.failure).toBeUndefined();
      expect(obs.v1.filter(e => e.type === 'error')).toEqual([]);
      expect(obs.v2.filter(e => e.type === 'session.error')).toEqual([]);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  }, 10000);
});
