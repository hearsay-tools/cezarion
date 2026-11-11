import { noRunners, offerRunners, RUNNER_OFFER } from './runners-under-test.testkit.ts';

// Importing this module makes building any runner fail the test at once. Use it when a test uses a
// run fixture but starts no runner: it loads no adapter. It is the weakest offer, so
// `core/claude-runner.testkit.ts` and `core/every-runner.testkit.ts` beat it when the same test file
// loads them too (hearsay-tools/cezarion#3242).
offerRunners(noRunners, RUNNER_OFFER.none);
