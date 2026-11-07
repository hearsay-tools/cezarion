import './every-runner.testkit.ts';

/** `harness-parity-core.testkit.ts` with every production adapter as the test file's runners. A
 *  test that drives one runner imports `harness-parity-core.testkit.ts` instead
 *  (hearsay-tools/cezarion#2939). */
export * from './harness-parity-core.testkit.ts';
