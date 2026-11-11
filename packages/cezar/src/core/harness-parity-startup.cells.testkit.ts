import type { RunnerId } from './agent-runner.ts';
import type { HarnessParityPart } from './harness-parity-parts.testkit.ts';
import { describeHarnessPart, type HarnessGroup, type HarnessRegistrar, type HarnessRegistration } from './harness-parity-registrar.testkit.ts';
import { SEAM_CRITERIA, seamRows } from './harness-parity-seam-tier.testkit.ts';

export const STARTUP_GROUPS = {
  startup(r: HarnessRegistrar) {
    const { describeRunners } = r;
    describeRunners('startup', 'harness parity — missing executable', () => seamRows(r, SEAM_CRITERIA.filter(row => row.id === 'S20')));
  },
} satisfies Readonly<Record<string, HarnessGroup>>;

/** Register the startup part's cells for one runner: `harness-<runner>-startup-parity.test.ts`. */
export function describeHarnessParity(scope: { runner: RunnerId; part: HarnessParityPart }, registration?: HarnessRegistration): void {
  describeHarnessPart('startup', STARTUP_GROUPS, scope, registration);
}
