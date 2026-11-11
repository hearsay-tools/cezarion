import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { controlledWire, manager, parent, register, root, semaphore, store, until, useWorkerWaitFixture, waitOf, worker } from './worker-wait-claude.testkit.ts';

// Real Git, durable fsync checkpoints and process shutdown share this outer budget.
// Keep the separate 15s state/termination assertions and actual runner timers intact.

describe('worker waits through RunManager', { timeout: 30_000 }, () => {
  useWorkerWaitFixture();
  for (const mode of ['fresh', 'continuation'] as const) {
    for (const marker of ['mock:cezar-done', 'mock:cezar-wait', 'mock:cezar-ask'] as const) {
      it(`${mode}: worker wait precedes ${marker} except that a human ask wins`, async () => {
        const release = join(root, 'release-marker-turn');
        // Each new session holds its first turn until the worker wait is durable.
        let wire = mode === 'fresh' ? controlledWire({ firstResultGate: release }) : undefined;
        const p = await parent(mode === 'fresh' ? marker : 'mock:hold');
        if (mode === 'continuation') {
          await until(() => store.getRun(p.id)?.status === 'waiting');
          manager.finish(p.id); await until(() => !manager.isActive(p.id));
          store.updateRun(p.id, { autonomous: true });
          wire = controlledWire({ firstResultGate: release });
          expect(manager.continueRun(p.id, { text: marker }).ok).toBe(true);
        }
        await until(wire!.initialReceived);
        const w = await worker(p.id); const wait = register(p.id, [w.id]);
        writeFileSync(release, 'release');
        // The Continue runs autonomous, where cezar_ask is refused (hearsay-tools/cezarion#2397):
        // its worker wait parks the run as the other markers do.
        if (marker === 'mock:cezar-ask' && mode === 'fresh') {
          await until(() => store.readEvents(p.id).some(event => event.type === 'ask.requested'));
          expect(waitOf(store.getRun(p.id))?.id).toBe(wait.id);
          expect(store.getRun(p.id)?.agentInputs?.some(input => input.deliveredAt)).not.toBe(true);
        } else {
          await until(() => waitOf(store.getRun(p.id))?.phase === 'parked');
          expect(store.getRun(p.id)?.status).toBe('waiting');
          expect(semaphore.busy()).toBe(0);
          expect(store.readEvents(p.id).some(event => event.type === 'note' && String(event.message).includes('autonomous — continuing'))).toBe(false);
          if (marker === 'mock:cezar-ask') expect(store.readEvents(p.id).some(event => event.type === 'ask.requested')).toBe(false);
        }
      });
    }
  }

});
