import type { RunnerId } from '../core/agent-runner.ts';

export const CHANNEL_WIRES = {
  claude: { missing: false, refresh: false, reason: 'whole assistant/result text feeds both channels' },
  codex: { missing: true, refresh: true, reason: 'v1 buffers absent snapshots and deduplicates completed ids; v2 maps each snapshot' },
  opencode: { missing: true, refresh: false, reason: 'v1 buffers absent snapshots; both channels deduplicate completed parts' },
  pi: { missing: false, refresh: false, reason: 'text_end snapshot/delta fallback feeds both channels' },
  omp: { missing: false, refresh: false, reason: 'text_end snapshot/delta fallback feeds both channels' },
  cursor: { missing: false, refresh: false, reason: 'v1 is emitted directly from completed v2 messages' },
} as const satisfies Record<RunnerId, { missing: boolean; refresh: boolean; reason: string }>;

/** Change native completion frames only, through the mock's own scenario token: `body` adds
 * `token` to its turn-messages input. No runner or normalized-event injection. Unsupported
 * directions get an empty token and execute their ordinary coupled-wire control instead. */
export async function withChannelWire(backend: RunnerId, direction: 'missing' | 'refresh', body: (token: string) => Promise<void>): Promise<void> {
  await body(CHANNEL_WIRES[backend][direction] ? `mock:channel-${direction}` : '');
}
