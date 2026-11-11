import { describeHarnessParity } from './harness-parity-ownership.cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';

useRunners(onlyRunner('claude', () => new ClaudeCliRunner()));

describeHarnessParity({ runner: 'claude', part: 'ownership' });
