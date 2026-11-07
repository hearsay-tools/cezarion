import { createServer } from 'node:net';

import { expect, it, vi } from 'vitest';

import { waitFor } from './harness-parity.testkit.ts';
import { withOwnedInputRun } from './workflow-parity.testkit.ts';


it('opencode fixture reaches waiting when the requested runner port is occupied', async () => {
  const occupied = createServer();
  await new Promise<void>(resolve => occupied.listen(0, '127.0.0.1', resolve));
  const address = occupied.address();
  if (!address || typeof address === 'string') throw new Error('expected TCP address');
  // Force the runner's candidate port to collide with a real listening socket.
  const random = vi.spyOn(Math, 'random').mockReturnValue((address.port - 40_000 + 0.5) / 20_000);
  try {
    await withOwnedInputRun('opencode', 'baseline', async ({ store, manager, runId }) => {
      manager.enqueueOwnedRun(runId);
      await waitFor(() => store.getRun(runId)?.status === 'waiting' || store.getRun(runId)?.status === 'failed');
      expect(store.getRun(runId)?.status).toBe('waiting');
      expect(manager.isActive(runId)).toBe(true);
    });
  } finally {
    random.mockRestore();
    await new Promise<void>((resolve, reject) => occupied.close(error => error ? reject(error) : resolve()));
  }
}, 60_000);
