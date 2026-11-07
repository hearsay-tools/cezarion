import '../core/every-runner.testkit.ts';

/** `worker-wait-core.testkit.ts` with every production adapter as the test file's runners. A test
 *  that drives one runner imports `worker-wait-core.testkit.ts` instead (hearsay-tools/cezarion#2939). */
export * from './worker-wait-core.testkit.ts';
