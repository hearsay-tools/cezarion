import { describeWaitParityFamily } from './waits-parity-registration-cells.testkit.ts';
import { WAIT_PARITY_FAMILIES } from './waits-parity-catalog.testkit.ts';
import { CursorRunner } from '../core/cursor-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('cursor', options => new CursorRunner(options)));

describeWaitParityFamily(WAIT_PARITY_FAMILIES.cursorRegistrationLimits);
