import type { RunnerId } from './agent-runner.ts';

/**
 * The parts of the harness parity matrix, as plain data. Each part's cells live in
 * `harness-parity-<part>.cells.testkit.ts`, and each `harness-<runner>-<part>-parity.test.ts`
 * imports only that module, so an edit behind one part reruns only its files
 * (hearsay-tools/cezarion#3242). `harness-parity-cells.testkit.ts` joins every part for the guards.
 */
export type HarnessParityPart = 'session' | 'run' | 'ownership' | 'settlement' | 'provider' | 'owned-input' | 'startup' | 'owned-workflows' | 'contract';

// Adjacent semantic families; every group below belongs to exactly one part.
export const HARNESS_PARITY_GROUPS: Readonly<Record<HarnessParityPart, readonly string[]>> = {
  startup: ['startup'],
  provider: ['provider'],
  contract: ['contract'],
  session: ['seam', 'session', 'input', 'governed', 'native-message', 'spec', 'tools', 'cdp', 'tool-grants'],
  run: ['run', 'diagnostics', 'child', 'hooks', 'answer', 'monitoring', 'prs'],
  'owned-workflows': ['owned-workflows'],
  'owned-input': ['owned'],
  ownership: ['continue', 'restart', 'owner', 'adopt', 'stop'],
  settlement: ['cleanup', 'multi-continue', 'superseded', 'disposal', 'scratch', 'permission', 'default-permission', 'retirement-P3', 'retirement-P4', 'permission-failure', 'malformed', 'early-permission', 'late-permission', 'mcp'],
};

export const harnessParityFile = (backend: RunnerId, part: HarnessParityPart): string =>
  `harness-${backend}-${part}-parity.test.ts`;

/** The module that defines one part's cells; its runner files import it and nothing wider. */
export const harnessParityCellsFile = (part: HarnessParityPart): string =>
  `harness-parity-${part}.cells.testkit.ts`;
