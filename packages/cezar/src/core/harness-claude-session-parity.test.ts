import { describeHarnessParity } from './harness-parity-session.cells.testkit.ts';
import { ClaudeCliRunner } from './claude-cli-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';

useRunners(onlyRunner('claude', () => new ClaudeCliRunner()));

describeHarnessParity({ runner: 'claude', part: 'session' });
