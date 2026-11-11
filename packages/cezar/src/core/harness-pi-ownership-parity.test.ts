import { describeHarnessParity } from './harness-parity-ownership.cells.testkit.ts';
import { PiRunner } from './pi-runner.ts';
import { onlyRunner, useRunners } from './runners-under-test.testkit.ts';

useRunners(onlyRunner('pi', () => new PiRunner()));

describeHarnessParity({ runner: 'pi', part: 'ownership' });
