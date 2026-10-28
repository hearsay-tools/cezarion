import { AliasWorkBudget } from './linux-alias-model.ts';
import { AliasMappingScope } from './linux-alias-scope.ts';
import type { AliasScanResult } from './linux-alias-scan.ts';

/** A provisional match retains on lost evidence. It authorizes no signal until
 * the caller has rechecked the resource and process at the signal boundary. */
export function assessAliasEvidence(pid: number, token: string, result: AliasScanResult,
  scope: AliasMappingScope, budget: AliasWorkBudget, publish: (entries: ReturnType<AliasMappingScope['snapshot']>) => void): boolean {
  const previouslyScoped = scope.has(pid);
  if (result.outcome === 'unknown') {
    if (result.scoped || (scope.has(pid) && scope.recheck(pid, token, undefined, false, undefined, budget) === 'unknown')) {
      throw new Error(`Cannot verify alias evidence for destroy holder ${pid}`);
    }
    if (previouslyScoped && !scope.has(pid)) publish(scope.snapshot());
    return false;
  }
  if (result.outcome === 'held') {
    if (result.mappings.length) scope.remember(pid, token, result.mappings);
    for (const link of result.links) scope.rememberLink(pid, token, link);
    if (!result.mappings.length && !result.links.length) throw new Error('held alias has no evidence');
    publish(scope.snapshot());
    return true;
  }
  if (scope.recheck(pid, token, result.maps, false, result.observedLinks, budget) === 'unknown') {
    throw new Error(`Cannot verify released alias holder ${pid}`);
  }
  if (previouslyScoped && !scope.has(pid)) publish(scope.snapshot());
  return false;
}
