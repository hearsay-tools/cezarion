import { describeHarnessParity } from './harness-parity-session.cells.testkit.ts';
import { CodexAppServerRunner } from './codex-app-server-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';

useRunners(onlyRunner('codex', () => new CodexAppServerRunner()));

describeHarnessParity({ runner: 'codex', part: 'session' });
