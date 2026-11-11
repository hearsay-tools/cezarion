import type { SessionTransport } from '@open-mercato/cezar-contract';
import type { AgentRunner, RunnerFactory, RunnerId } from './agent-runner.ts';

/** The runner factory a test file drives. Each test file is its own module graph, so this is per
 *  file (hearsay-tools/cezarion#2939).
 *
 *  Two kinds of call choose it. `useRunners` is explicit: it always replaces the factory, so the
 *  last explicit call wins. `core/every-runner.testkit.ts` makes one at import, and a test body
 *  that calls it after its imports still wins. `offerRunners` is a default: it replaces only a
 *  weaker offer, and never an explicit choice. `core/claude-runner.testkit.ts` offers
 *  `RUNNER_OFFER.claude` and `core/no-runner.testkit.ts` offers `RUNNER_OFFER.none`. So when one
 *  test file's closure holds several of these kits, every-runner beats claude, and claude beats
 *  none, whatever the import order (hearsay-tools/cezarion#3242). */
let current: RunnerFactory | undefined;
let currentRank = 0;

/** The rank of each default offer. A higher rank replaces a lower one. */
export const RUNNER_OFFER = { none: 1, claude: 2 } as const;

/** Choose the runners this test file's fixtures build. */
export function useRunners(factory: RunnerFactory): void {
  current = factory;
  currentRank = Number.POSITIVE_INFINITY;
}

/** Offer a default factory: it applies only when no explicit choice and no stronger offer exists. */
export function offerRunners(factory: RunnerFactory, rank: number): void {
  if (rank <= currentRank) return;
  current = factory;
  currentRank = rank;
}

/** The factory `useRunners` chose. A fixture asks for it only when a run starts a runner. */
export function runnersUnderTest(): RunnerFactory {
  if (!current) {
    throw new Error('No runner factory for this test file: call useRunners() with the runner it drives, '
      + 'or import core/claude-runner.testkit.ts, core/no-runner.testkit.ts or core/every-runner.testkit.ts.');
  }
  return current;
}

type RunnerMaker = (options: { sessionTransport?: SessionTransport }) => AgentRunner;

/** A factory that builds the named runners and refuses every other backend, so a per-runner test
 *  loads and starts only the adapters it names. */
export function onlyRunners(makers: Partial<Record<RunnerId, RunnerMaker>>): RunnerFactory {
  return (backend, options = {}) => {
    const requested = backend === undefined || backend === 'claude-cli' ? 'claude' : backend;
    const make = makers[requested];
    if (!make) throw new Error(`This test drives only the ${Object.keys(makers).join(' and ')} runner; it was asked for ${String(backend)}.`);
    return make(options);
  };
}

/** `onlyRunners` for one runner. */
export function onlyRunner(id: RunnerId, make: RunnerMaker): RunnerFactory {
  return onlyRunners({ [id]: make });
}

/** For a run module test that starts no runner: building one fails the test at once. */
export const noRunners: RunnerFactory = (backend) => {
  throw new Error(`This test starts no runner; it was asked for ${String(backend)}.`);
};
