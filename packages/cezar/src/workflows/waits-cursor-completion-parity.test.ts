import { describeWaitParity } from './waits-parity-completion-cells.testkit.ts';
import { CursorRunner } from '../core/cursor-runner.ts';
import { onlyRunner, useRunners } from '../core/runners-under-test.testkit.ts';

useRunners(onlyRunner('cursor', options => new CursorRunner(options)));

describeWaitParity({ runner: 'cursor', part: 'completion' });
