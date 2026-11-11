import { describeHarnessParity } from './harness-parity-startup.cells.testkit.ts';
import { CursorRunner } from './cursor-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';

useRunners(onlyRunner('cursor', options => new CursorRunner(options)));

describeHarnessParity({ runner: 'cursor', part: 'startup' });
