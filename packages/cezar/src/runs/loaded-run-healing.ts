import type { RunRecord } from './store.ts';

/** Heal reference metadata through the store's existing declaration and resolution rules. */
export function restoreLostReferencedPullRequest(
  run: RunRecord,
  referencedPrDeclaration: (run: RunRecord) => number | undefined,
  resolveReferencedRef: (candidates: string[], task: string, declared?: number) => string | undefined,
): void {
  // Heal a record written before `referencedPrDeclaration` existed: a task that re-declared
  // `CEZ:PR` with the PR it had just CREATED cleared the PR it was ABOUT, because no candidate
  // could match the created number. The evidence is all still on the record — only the
  // conclusion drawn from it was wrong — so re-resolve without that declaration instead of
  // asking for a migration. Deliberately one-directional: it only runs on a record that HAS no
  // referenced PR, so it can never take one away from a record written by an older cezar whose
  // candidate list no longer explains it. `prNumber` is not recoverable this way (the
  // declaration overwrote it) and is left alone — the restored URL is what paints the chip.
  if (
    run.referencedPullRequestUrl === undefined &&
    run.markerRefs?.pr !== undefined &&
    referencedPrDeclaration(run) === undefined
  ) {
    run.referencedPullRequestUrl = resolveReferencedRef(
      run.referencedPrCandidates ?? [],
      run.task,
      undefined,
    );
  }
}
