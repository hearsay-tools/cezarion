import type { RunnerId } from './agent-runner.ts';
import type { HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessPart, type HarnessGroup, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { SEAM_CONTRACT_ROWS } from './seam-contract.testkit.ts';

export const CONTRACT_GROUPS = {
  // hearsay-tools/cezarion#2991: the seam contract every runner keeps, read from its declared facts.
  contract(r: HarnessRegistrar) {
    const { describeRunners, runners, parityRow } = r;
    describeRunners('contract', 'harness parity — seam contract (hearsay-tools/cezarion#2991)', () => {
      for (const backend of runners) for (const row of SEAM_CONTRACT_ROWS) parityRow(backend, row, () => row.observe(backend));
    });
  },
} satisfies Readonly<Record<string, HarnessGroup>>;

/** Register the contract part's cells for one runner: `harness-<runner>-contract-parity.test.ts`. */
export function describeHarnessParity(scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration): void {
  describeHarnessPart('contract', CONTRACT_GROUPS, scope, registration);
}
