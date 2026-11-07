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
const ENGINE = ['workflows/run.ts', 'delegation/provision.ts', 'delegation/workspace.ts', 'workflows/fixture-cleanup.testkit.ts'];

function engineFilesIn(entry: string): string[] {
  const closure = importClosure(join(src, entry)).map(path => relative(src, path));
  return ENGINE.filter(file => closure.includes(file));
}

describe('the harness parity kits', () => {
  it('keeps the workflow engine out of the adapter-level kit', () => {
    expect(engineFilesIn('core/harness-parity.testkit.ts')).toEqual([]);
  });

  it('loads the workflow engine through the workflow-level kit', () => {
    expect(engineFilesIn('core/workflow-parity.testkit.ts')).toEqual(ENGINE);
  });
});
