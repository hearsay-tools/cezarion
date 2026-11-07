import './every-runner.testkit.ts';

/** `workflow-parity-core.testkit.ts` with every production adapter as the test file's runners. A
 *  test that drives one runner imports `workflow-parity-core.testkit.ts` instead
 *  (hearsay-tools/cezarion#2939). */
export * from './workflow-parity-core.testkit.ts';
