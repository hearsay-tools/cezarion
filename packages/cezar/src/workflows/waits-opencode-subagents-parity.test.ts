import { subagentCells } from './waits-subagents-parity-cells.testkit.ts';
import { OpencodeServerRunner } from '../core/opencode-server-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('opencode', () => new OpencodeServerRunner()));

// Squawk's wait on native subagents on the opencode wire (hearsay-tools/cezarion#2431).
subagentCells(['opencode']);
