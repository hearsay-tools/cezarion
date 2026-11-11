import { createRunner } from './runner-factory.ts';
import { useRunners } from './runners-under-test.testkit.ts';

// Importing this module makes every production adapter the test file's runners. `createRunner` is
// read at call time, so a test's `vi.mock` or `vi.spyOn` of `runner-factory.ts` still reaches it.
// A test that drives one runner never imports this module (hearsay-tools/cezarion#2939). A test
// that starts no runner imports `no-runner.testkit.ts`, and one that runs only Claude imports
// `claude-runner.testkit.ts`. This kit's choice is explicit, so it beats both of them when one test
// file loads them together (hearsay-tools/cezarion#3242).
useRunners((backend, options) => createRunner(backend, options));
