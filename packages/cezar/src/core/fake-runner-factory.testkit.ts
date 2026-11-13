import type { RunnerFactory } from './agent-runner.ts';

/** Keep the incomplete runner shapes of factory mocks when moving them to fixture injection.
 *  The test supplies the methods it exercises; this adapter adds no fields or runtime behavior. */
export function fakeRunnerFactory(factory: (...args: never[]) => object): RunnerFactory {
  return factory as RunnerFactory;
}
