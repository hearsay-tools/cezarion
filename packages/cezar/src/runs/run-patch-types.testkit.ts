import type { RunStore } from './store.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunPatch } from './run-exits.ts';

// @ts-expect-error Status writes belong to exits, not a run patch.
const statusPatch: RunPatch = { status: RUN_STATUS.running };
void statusPatch;

function refusesStatus(store: RunStore): void {
  // @ts-expect-error A run status can only be written by an exit or the testkit helper.
  store.updateRun('fixture', { status: RUN_STATUS.running });
}
void refusesStatus;
