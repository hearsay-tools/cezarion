import { assessAliasEvidence } from './linux-alias-discovery.ts';
import { AliasWorkBudget } from './linux-alias-model.ts';
import { AliasMappingScope } from './linux-alias-scope.ts';
import type { AliasScanResult } from './linux-alias-scan.ts';

type Entry = { pid: number; token: string };
type Snapshot = ReturnType<AliasMappingScope['snapshot']>;

function relevant(pid: number, scope: AliasMappingScope, result: AliasScanResult): boolean {
  return scope.has(pid) || result.outcome === 'held' || !!result.scoped;
}

function refuseLostEvidence(pid: number, scope: AliasMappingScope, result: AliasScanResult, uncertain: boolean): void {
  if ((uncertain && result.outcome !== 'held') || (result.outcome === 'unknown' && !relevant(pid, scope, result))) {
    throw new Error(`Cannot verify alias evidence for destroy holder ${pid}`);
  }
}

/** No signal is possible until the entire candidate list has been examined. */
export async function discoverAliasHolders(pids: readonly number[], scope: AliasMappingScope, budget: AliasWorkBudget,
  token: (pid: number) => string | undefined, scan: (pid: number, token: string | undefined) => AliasScanResult,
  gone: (pid: number) => boolean, current: () => void | Promise<void>, verify: () => void,
  publish: (entries: Snapshot) => void): Promise<Entry[]> {
  const holders: Entry[] = [];
  const seen = new Set<number>();
  for (const pid of pids) {
    budget.spend();
    seen.add(pid);
    let start = token(pid);
    let result = scan(pid, start);
    const provisional = relevant(pid, scope, result);
    const uncertain = result.outcome === 'unknown' && !!result.scoped;
    if (provisional) {
      // Re-read target evidence after the final asynchronous authorization.
      // A release observed before the yield cannot clear durable retention.
      await current(); verify();
      // A confirmed earlier observation is retention-only. Publish it before
      // a later loss of target evidence can make this attempt incomplete.
      if (start && result.outcome === 'held') assessAliasEvidence(pid, start, result, scope, budget, publish);
      start = token(pid);
      if (scope.has(pid) && gone(pid) && token(pid) === start) {
        scope.recheck(pid, start, undefined, true, undefined, budget);
        verify(); publish(scope.snapshot()); await current();
        continue;
      }
      result = scan(pid, start);
      verify();
      refuseLostEvidence(pid, scope, result, uncertain);
    }
    if (!start) {
      if (scope.has(pid) || result.scoped) throw new Error(`Cannot verify alias process ${pid}`);
      continue;
    }
    if (relevant(pid, scope, result)) {
      const held = assessAliasEvidence(pid, start, result, scope, budget, publish);
      await current();
      if (held) holders.push({ pid, token: start });
    }
  }
  for (const entry of scope.snapshot()) {
    if (seen.has(entry.pid)) continue;
    budget.spend();
    await current(); verify();
    const start = token(entry.pid);
    const exited = !start && gone(entry.pid);
    if (scope.recheck(entry.pid, start, undefined, exited, undefined, budget) === 'unknown') {
      throw new Error(`Cannot verify alias process ${entry.pid}`);
    }
    verify(); publish(scope.snapshot()); await current();
  }
  await current(); verify();
  return holders;
}
