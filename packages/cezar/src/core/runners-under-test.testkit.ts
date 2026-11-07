import type { SessionTransport } from '@open-mercato/cezar-contract';
import type { AgentRunner, RunnerFactory, RunnerId } from './agent-runner.ts';

/** The runner factory a test file drives. Each test file is its own module graph, so this is per
 *  file (hearsay-tools/cezarion#2939). */
let current: RunnerFactory | undefined;

/** Choose the runners this test file's fixtures build. */
export function useRunners(factory: RunnerFactory): void {
  current = factory;
}

/** The factory `useRunners` chose. A fixture asks for it only when a run starts a runner. */
export function runnersUnderTest(): RunnerFactory {
  if (!current) {
    throw new Error('No runner factory for this test file: call useRunners() with the runner it drives, '
      + 'or build the manager through workflows/fixture-cleanup.testkit.ts for every adapter.');
  }
  return current;
}

/** A factory that builds one runner and refuses every other backend, so a per-runner test loads
 *  and starts only its own adapter. */
export function onlyRunner(id: RunnerId, make: (options: { sessionTransport?: SessionTransport }) => AgentRunner): RunnerFactory {
  return (backend, options = {}) => {
    const requested = backend === undefined || backend === 'claude-cli' ? 'claude' : backend;
    if (requested !== id) throw new Error(`This test drives only the ${id} runner; it was asked for ${String(backend)}.`);
    return make(options);
  };
}

/** For a run module test that starts no runner: building one fails the test at once. */
export const noRunners: RunnerFactory = (backend) => {
  throw new Error(`This test starts no runner; it was asked for ${String(backend)}.`);
};
