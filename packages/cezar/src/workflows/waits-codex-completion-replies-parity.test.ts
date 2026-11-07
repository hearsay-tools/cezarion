import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { CodexAppServerRunner } from '../core/codex-app-server-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('codex', () => new CodexAppServerRunner()));

describeWaitParity({ runner: 'codex', part: 'completion-replies' });
