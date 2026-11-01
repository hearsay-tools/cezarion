// Experimental policy only. The required CI and local iteration selector do not read this.
const EXTRA_GUARDS = new Set([
  'packages/cezar/src/env-example.test.ts',
  'packages/cezar/src/mock-source-boundary.test.ts',
  'packages/cezar/src/run-search-readers.test.ts',
  'packages/cezar/src/run-fact-readers.test.ts',
  'packages/cezar/src/test-wait-discipline.test.ts',
  'packages/cezar/src/test-enum-literal-rule.test.ts',
  'packages/web/src/test/e2e-wait-discipline.test.ts',
  'packages/web/src/test/unit-wait-discipline.test.ts',
  'packages/web/src/test/wait-baseline.test.ts',
  'packages/web/src/test/e2e-spec-map.test.ts',
]);

/** Reuse declared filesystem dependencies, plus known source-reading invariants. */
export function mandatoryFiles(inventory, inputs) {
  return inventory.filter(file => Object.hasOwn(inputs, file) || EXTRA_GUARDS.has(file));
}

/** Decide emptiness before adding guards: guards must never hide a missing graph. */
export function chooseFiles({ inventory, related, mandatory, localMode, localReason, graphError }) {
  const all = [...new Set(inventory)].sort();
  const full = reason => ({ mode: 'full', reason, files: all });
  if (graphError) return full(`Graph unavailable: ${graphError}`);
  if (localMode !== 'changed') return full(`Local fallback: ${localReason}`);
  if (!related.length) return full('No related tests before mandatory guards');
  if ([...related, ...mandatory].some(file => !all.includes(file))) return full('Unknown selected file');
  return { mode: 'selective', reason: 'Import graph plus mandatory source invariants',
    files: [...new Set([...related, ...mandatory])].sort() };
}
