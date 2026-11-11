import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Wait } from '@open-mercato/cezar-contract/waits';
import { controlledWire, manager, parent, root, store, toolGenerationOf, until } from './worker-wait-claude.testkit.ts';

export const pr = 'https://github.com/acme/repo/pull/12';
export const identity = { prUrl: pr, repository: 'acme/repo', prNumber: 12, headSha: 'a'.repeat(40) };

export const handlers = (runId: string) => manager.cezarToolHandlers(runId, toolGenerationOf(runId));
export const entryOf = (runId: string, waitId: string): Wait | undefined => store.getRun(runId)?.waits?.find(wait => wait.id === waitId);
export const settledOf = (runId: string, waitId: string): Wait | undefined => store.getRun(runId)?.lastWaits?.find(wait => wait.id === waitId);
export const inputOf = (runId: string, id: string) => store.getRun(runId)?.agentInputs?.find(input => input.id === id);

/** A parent whose first turn is held until `release()`: registrations happen mid-turn. */
export async function heldParent() {
  const gate = join(root, `release-${randomUUID()}`);
  const wire = controlledWire({ firstResultGate: gate });
  const run = await parent(); await until(wire.initialReceived);
  return { run, release: () => writeFileSync(gate, 'release') };
}
