import { subagentCells } from './waits-subagents-parity-cells.testkit.ts';
import { PiRunner } from '../core/pi-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('pi', () => new PiRunner()));

// Squawk's wait on native subagents on the pi wire (hearsay-tools/cezarion#2431).
subagentCells(['pi']);
