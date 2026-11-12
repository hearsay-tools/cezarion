import type { RunnerId } from './agent-runner.ts';
import type { HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessPart, type HarnessGroup, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { PROVIDER_HOLD_ROW_IDS } from './harness-parity-rows.testkit.ts';
import { RUN_CRITERIA, runRows } from './harness-parity-run-tier.testkit.ts';

export const PROVIDER_GROUPS = {
  provider(r: HarnessRegistrar) {
    const { describeRunners } = r;
    describeRunners('provider', 'harness parity — provider error hold', () => runRows(r, RUN_CRITERIA.filter(row => PROVIDER_HOLD_ROW_IDS.includes(row.id))));
  },
} satisfies Readonly<Record<string, HarnessGroup>>;

/** Register the provider part's cells for one runner: `harness-<runner>-provider-parity.test.ts`. */
export function describeHarnessParity(scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration): void {
  describeHarnessPart('provider', PROVIDER_GROUPS, scope, registration);
}
