import { subagentCells } from './waits-subagents-parity-cells.testkit.ts';
import { CursorRunner } from '../core/cursor-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('cursor', options => new CursorRunner(options)));

// Squawk's wait on native subagents on the cursor wire (hearsay-tools/cezarion#2431).
subagentCells(['cursor']);
