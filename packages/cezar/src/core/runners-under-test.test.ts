import { describe, expect, it, vi } from 'vitest';
import type { RunnerFactory } from './agent-runner.ts';

// Which factory a test file drives when its closure loads several runner kits
// (hearsay-tools/cezarion#3242). Each case loads a fresh `runners-under-test.testkit.ts`, so
// the kits it imports next register with that instance, in the order the case names.
type Kit = 'every-runner' | 'claude-runner' | 'no-runner';
const KIT_MODULES: Record<Kit, () => Promise<unknown>> = {
  'every-runner': () => import('./every-runner.testkit.ts'),
  'claude-runner': () => import('./claude-runner.testkit.ts'),
  'no-runner': () => import('./no-runner.testkit.ts'),
};

async function freshRunnersKit() {
  vi.resetModules();
  return import('./runners-under-test.testkit.ts');
}

async function importKits(kits: readonly Kit[]): Promise<void> {
  for (const kit of kits) await KIT_MODULES[kit]();
}

/** The kit whose factory `runnersUnderTest` returns, read from how it treats a Codex task. */
function chosenKit(factory: RunnerFactory): Kit {
  try {
    const backend = factory('codex').backend;
    if (backend === 'codex') return 'every-runner';
    throw new Error(`A Codex task got the ${backend} runner.`);
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('drives only the claude runner')) return 'claude-runner';
    if (message.includes('starts no runner')) return 'no-runner';
    throw error;
  }
}

function permutations<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) return [[...items]];
  return items.flatMap((item, index) => permutations([...items.slice(0, index), ...items.slice(index + 1)]).map(rest => [item, ...rest]));
}

describe('runner kit precedence', () => {
  it.each(permutations<Kit>(['every-runner', 'claude-runner', 'no-runner']).map(order => [order.join(', '), order] as const))(
    'every-runner wins when the kits load in the order %s',
    async (_name, order) => {
      const kit = await freshRunnersKit();
      await importKits(order);
      expect(chosenKit(kit.runnersUnderTest())).toBe('every-runner');
    },
  );

  it.each(permutations<Kit>(['claude-runner', 'no-runner']).map(order => [order.join(', '), order] as const))(
    'claude-runner beats no-runner when the kits load in the order %s',
    async (_name, order) => {
      const kit = await freshRunnersKit();
      await importKits(order);
      expect(chosenKit(kit.runnersUnderTest())).toBe('claude-runner');
    },
  );

  it.each<Kit>(['every-runner', 'claude-runner', 'no-runner'])('a single %s kit chooses its own factory', async (only) => {
    const kit = await freshRunnersKit();
    await importKits([only]);
    expect(chosenKit(kit.runnersUnderTest())).toBe(only);
  });

  it('a later explicit useRunners in the test body wins over every kit', async () => {
    const kit = await freshRunnersKit();
    await importKits(['claude-runner', 'every-runner', 'no-runner']);
    kit.useRunners(kit.noRunners);
    expect(chosenKit(kit.runnersUnderTest())).toBe('no-runner');
  });

  it('an offer after an explicit choice does not replace it', async () => {
    const kit = await freshRunnersKit();
    kit.useRunners(kit.noRunners);
    kit.offerRunners(kit.onlyRunner('claude', () => { throw new Error('unused'); }), kit.RUNNER_OFFER.claude);
    expect(chosenKit(kit.runnersUnderTest())).toBe('no-runner');
  });

  it('the claude-runner kit builds the Claude runner for claude, claude-cli and no backend', async () => {
    const kit = await freshRunnersKit();
    await importKits(['claude-runner']);
    const factory = kit.runnersUnderTest();
    for (const backend of ['claude', 'claude-cli', undefined] as const) expect(factory(backend).backend).toBe('claude');
  });

  it('no kit leaves the test file without a factory', async () => {
    const kit = await freshRunnersKit();
    expect(() => kit.runnersUnderTest()).toThrow('No runner factory for this test file');
  });
});
