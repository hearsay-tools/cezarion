/** Instrument a disposable installed copy. Never change the budget or refusal. */
export function instrumentAliasBudget(source: string): string {
  const marker = 'if (this.remaining < 0)\n            throw new AliasBudgetExceeded();';
  if (source.split(marker).length !== 2) throw new Error('alias budget diagnostic marker changed');
  const names = ['AliasWorkBudget.spend', 'readProcEvidence', 'mappedPathScope', 'mappedHolder', 'holds', 'findHolders',
    'linuxCandidates', 'prepareAliasScan', 'verifyAliasScan', 'scanAliases', 'scanAndRetain', 'discoverAliasHolders',
    'parseAliasMounts', 'locateOwnedRoot', 'indexAliasMounts', 'indexedMounts', 'aliasCandidates', 'linkedAliasCandidates',
    'mappedAliasCandidates', 'linkAliasCandidates', 'readAliasLinks', 'descriptorNames', 'processEntries',
    'scopedMappingStillPresent', 'AliasMappingScope.recheck', 'assessAliasEvidence', 'checkScopedHolders',
    'evaluateAliasCandidates', 'checkedSignalEvidence', 'signalHolder', 'reapDestroyHolders'];
  const replacement = `if (this.remaining < 0) {
            if (!cezBudgetReported) {
                cezBudgetReported = true;
                const allowed = ${JSON.stringify(names)};
                const frames = String(new Error().stack ?? '').split('\\n').slice(1, 25).flatMap(line => {
                    const name = /^\\s*at (?:async )?([\\w.]+)(?:\\s|\\()/.exec(line)?.[1];
                    return allowed.includes(name) ? [name] : [];
                }).slice(0, 12);
                console.error('[packaged-alias-budget-diagnostic]', JSON.stringify({ remaining: this.remaining, charge: amount, frames }));
            }
            throw new AliasBudgetExceeded();
        }`;
  return 'let cezBudgetReported = false;\n' + source.replace(marker, replacement);
}
