import { AliasWorkBudget } from './linux-alias-model.ts';
import type { AliasScanResult } from './linux-alias-scan.ts';

/** Complete the sweep before the caller can signal any returned process. */
export function collectAliasHolders<T>(candidates: readonly T[], budget: AliasWorkBudget,
  scan: (candidate: T, budget: AliasWorkBudget) => AliasScanResult,
  scoped: (candidate: T) => boolean): { candidate: T; evidence: AliasScanResult }[] {
  const held: { candidate: T; evidence: AliasScanResult }[] = [];
  for (const candidate of candidates) {
    budget.spend();
    const evidence = scan(candidate, budget);
    if (evidence.outcome === 'unknown' && (evidence.scoped || scoped(candidate))) throw new Error('scoped alias evidence unavailable');
    if (evidence.outcome === 'held') held.push({ candidate, evidence });
  }
  return held;
}
