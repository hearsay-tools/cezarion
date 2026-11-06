import { it } from 'vitest';
import { checkLaunchReadMatrix } from './launch-read-matrix.testkit.ts';

// bound: batched rule scans prove every fields cell; retain the existing 120 s rule-test hang guard.
it('refuses the generated launch-read fields matrix and preserves documented limits', { timeout: 120_000 }, async () => {
  await checkLaunchReadMatrix('fields');
});
