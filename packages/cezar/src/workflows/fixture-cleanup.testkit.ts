import '../core/every-runner.testkit.ts';

/** `fixture-manager.testkit.ts` with every production adapter as the test file's runners. A test
 *  that drives one runner imports `fixture-manager.testkit.ts` instead (hearsay-tools/cezarion#2939).
 *  A test that runs only Claude imports `fixture-claude.testkit.ts`, and one that starts no runner
 *  imports `fixture-no-runner.testkit.ts` (hearsay-tools/cezarion#3242). */
export * from './fixture-manager.testkit.ts';
