import { subagentCells } from './waits-subagents-parity-cells.testkit.ts';
import { CodexAppServerRunner } from '../core/codex-app-server-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('codex', () => new CodexAppServerRunner()));

// Squawk's wait on native subagents on the codex wire (hearsay-tools/cezarion#2431).
subagentCells(['codex']);
