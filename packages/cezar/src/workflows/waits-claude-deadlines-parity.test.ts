import { describeWaitParity } from './waits-parity-deadlines-cells.testkit.ts';
import { ClaudeCliRunner } from '../core/claude-cli-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('claude', () => new ClaudeCliRunner()));

// The wait list's deadline-accounting cells on the claude wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'claude', part: 'deadlines' });
