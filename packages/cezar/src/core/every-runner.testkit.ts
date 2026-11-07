import { createRunner } from './runner-factory.ts';
import { useRunners } from './runners-under-test.testkit.ts';

// Importing this module makes every production adapter the test file's runners. `createRunner` is
// read at call time, so a test's `vi.mock` or `vi.spyOn` of `runner-factory.ts` still reaches it.
// A test that drives one runner never imports this module (hearsay-tools/cezarion#2939).
useRunners((backend, options) => createRunner(backend, options));
