import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import type { RunPatch } from './run-exits.ts';

// @ts-expect-error Status writes belong to exits, not a run patch.
const statusPatch: RunPatch = { status: RUN_STATUS.running };
void statusPatch;
