import { join, relative } from 'node:path';
import { describe, expect, it } from 'vitest';
import { importClosure } from '../lint/import-closure.testkit.ts';

/**
 * Squeal reruns every test whose import closure holds an edited file. The adapter-level parity kit
 * stays free of the workflow engine, so an engine edit does not rerun the runner-adapter tests
 * (hearsay-tools/cezarion#2938). The walk follows the imports a test loads at runtime; TypeScript
 * erases type-only ones.
 */
const src = join(import.meta.dirname, '..');
const ENGINE = ['workflows/run.ts', 'delegation/provision.ts', 'delegation/workspace.ts', 'workflows/fixture-manager.testkit.ts'];

function engineFilesIn(entry: string): string[] {
  const closure = importClosure(join(src, entry)).map(path => relative(src, path));
  return ENGINE.filter(file => closure.includes(file));
}

describe('the harness parity kits', () => {
  // Each kit's `-core` file imports no runner adapter; the plain name re-exports it with every
  // adapter chosen (hearsay-tools/cezarion#2939).
  it.each(['core/harness-parity.testkit.ts', 'core/harness-parity-core.testkit.ts'])('keeps the workflow engine out of the adapter-level kit %s', (kit) => {
    expect(engineFilesIn(kit)).toEqual([]);
  });

  // The startup, contract and session parts drive only the seam tier, so their runner files load
  // no engine; `harness-parity.test.ts` pins that each runner file imports only its part's kit
  // (hearsay-tools/cezarion#3242).
  it.each(['startup', 'contract', 'session'].map(part => `core/harness-parity-${part}.cells.testkit.ts`))('keeps the workflow engine out of the seam-tier part kit %s', (kit) => {
    expect(engineFilesIn(kit)).toEqual([]);
  });

  it.each(['core/workflow-parity.testkit.ts', 'core/workflow-parity-core.testkit.ts'])('loads the workflow engine through the workflow-level kit %s', (kit) => {
    expect(engineFilesIn(kit)).toEqual(ENGINE);
  });
});
