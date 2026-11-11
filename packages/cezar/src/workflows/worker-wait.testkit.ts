import '../core/every-runner.testkit.ts';

/** `worker-wait-core.testkit.ts` with every production adapter as the test file's runners. A test
 *  that drives one runner imports `worker-wait-core.testkit.ts` instead (hearsay-tools/cezarion#2939),
 *  and a test that needs no fixture imports `worker-wait-timeline.testkit.ts` (hearsay-tools/cezarion#3242). */
export * from './worker-wait-core.testkit.ts';
