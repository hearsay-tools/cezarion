import { describeWaitParity } from './waits-parity-cells.testkit.ts';
import { CodexAppServerRunner } from '../core/codex-app-server-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('codex', () => new CodexAppServerRunner()));

// The wait list's process-wait cells on the codex wire (hearsay-tools/cezarion#1446).
describeWaitParity({ runner: 'codex', part: 'process' });
