import { describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RUNNER_IDS } from './agent-runner.ts';
import { HARNESS_ADAPTERS, exemptionFor, driveSeam } from './harness-parity.testkit.ts';

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
          spec: { cwd },
          whileOpen: async session => {
            // The mock's real closeSync(0) precedes its marker. The session's cwd is
            // passed through the production spawn; no normalized events are injected.
            await vi.waitFor(() => expect(existsSync(join(cwd, 'input-closed.pid'))).toBe(true), { timeout: 5000 });
            expect(session.open).toBe(true);
            const receipt = session.sendAgentMessage([{ type: 'text', text: 'force broken native agent input write' }]);
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
    }, 10000);
  }
});

describe('Pi native input teardown', () => {
  it.each(['end', 'interrupt'] as const)('%s observes a broken pipe without reporting a new failure', async action => {
    const cwd = mkdtempSync(join(tmpdir(), 'cez-pi-input-teardown-'));
    try {
      const obs = await driveSeam('pi', 'input-closed-live', {
        spec: { cwd },
        whileOpen: async session => {
          await vi.waitFor(() => expect(existsSync(join(cwd, 'input-closed.pid'))).toBe(true), { timeout: 5000 });
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
