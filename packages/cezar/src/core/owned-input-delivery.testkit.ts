import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createDeliveryControl, type DeliveryControlOptions } from '../../scripts/mock-delivery-control.mjs';
import type { RunnerId } from './agent-runner.ts';
import { HARNESS_ADAPTERS } from './harness-parity.testkit.ts';

/** Run `body` with a Native delivery control set for the fixture: the real native mock
 * reads it (`CEZ_MOCK_DELIVERY_CONTROL`); nothing rewrites mock source. Every
 * environment value this sets is restored afterwards, absence included. */
async function withDeliveryControl<T>(runner: RunnerId, options: DeliveryControlOptions,
  body: (control: ReturnType<typeof createDeliveryControl>) => Promise<T>): Promise<T> {
  const root = mkdtempSync(join(tmpdir(), 'cez-delivery-'));
  const adapter = HARNESS_ADAPTERS[runner];
  const keys = ['CEZ_MOCK_DELIVERY_CONTROL', 'CEZ_DRY_RUN', adapter.binEnv];
  const saved = keys.map(key => process.env[key]);
  try {
    const control = createDeliveryControl(root, options);
    process.env.CEZ_MOCK_DELIVERY_CONTROL = control.path;
    process.env.CEZ_DRY_RUN = '0';
    process.env[adapter.binEnv] = adapter.mockBin;
    return await body(control);
  } finally {
    keys.forEach((key, i) => { if (saved[i] === undefined) delete process.env[key]; else process.env[key] = saved[i]; });
    rmSync(root, { recursive: true, force: true });
  }
}

/** Reject exactly one matching input through the real protocol; a reopened
 * process accepts it. No session/manager mock and no transport-error inference.
 * `persistent` rejects every such input, in every process, until `lift()`. */
export function withRejectedInput(runner: 'codex' | 'opencode' | 'pi' | 'omp', body: (lift: () => void) => Promise<void>,
  { persistent = false, match = 'reject-owned-turn' } = {}): Promise<void> {
  return withDeliveryControl(runner, { kind: 'reject', match, persistent }, control => body(control.lift));
}

/** Hold only the transport acknowledgement of a matching input; the turn's real frames
 * still reach the runner. On Cursor print the acknowledgement is the first model work. */
export function withHeldAck(runner: 'codex' | 'opencode' | 'pi' | 'omp' | 'cursor', body: (release: () => void) => Promise<void>,
  match = 'delay-owned-ack'): Promise<void> {
  return withDeliveryControl(runner, { kind: 'hold-ack', match }, control => body(control.release));
}

/** Admit a matching input, then send no turn content until release. Claude acknowledges
 * agent input with its local stdin write, so on Claude this is the executable form of the
 * pipe-write exemption: holding the response cannot construct a turn-end-before-ACK race. */
export function withHeldResponse(runner: RunnerId, body: (release: () => void, held: () => boolean) => Promise<void>,
  match = 'mock:agent-echo'): Promise<void> {
  return withDeliveryControl(runner, { kind: 'hold-response', match }, control => body(control.release, control.held));
}
