import { describe, it } from 'vitest';
import { replyAfterRestart, useWorkerQuestionsFixture } from './worker-questions.testkit.ts';

describe("worker questions route to the parent (hearsay-tools/cezarion#505)", { timeout: 45_000 }, () => {
  useWorkerQuestionsFixture();

it('a parent reply answers the worker after a crash left its execution starting (#469)', () => replyAfterRestart());

it('waits for reusable resources when recovery already completed the crashed execution (hearsay-tools/cezarion#732)', () => replyAfterRestart(true));
});
