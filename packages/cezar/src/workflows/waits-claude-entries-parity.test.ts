import { describeWaitParity } from './waits-parity-entries-cells.testkit.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('claude', () => new ClaudeCliRunner()));

// The wait list's RUNNER_IDS turn-end entry cells on the claude wire (hearsay-tools/cezarion#1525).
describeWaitParity({ runner: 'claude', part: 'entries' });
