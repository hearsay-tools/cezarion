import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeRunRecord, RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
const release = vi.hoisted(() => ({ enabled: false }));
vi.mock('./home/switch.ts', () => ({ get REBRAND_SWITCH() { return release.enabled; } }));
import { noticeLegacyProject, projectPaths } from './project-paths.ts';
import { seedRuns } from './runs/run-store.testkit.ts';
import { RunStore } from './runs/store.ts';

describe('project reads across the release switch', () => {
  it.each([false, true])('reads both trees and writes legacy, with notice gated by switch=%s', enabled => {
    release.enabled = enabled;
    const repo = mkdtempSync(join(tmpdir(), 'project-switch-'));
    const paths = projectPaths(repo);
    const old = makeRunRecord({ status: RUN_STATUS.done, title: 'legacy' });
    const fallback = makeRunRecord({ status: RUN_STATUS.done, title: 'fallback' });
    seedRuns(paths.write, [old]);
    seedRuns(paths.reads[1]!, [fallback]);
    const warnings: string[] = [];
    let store: RunStore | undefined;
    try {
      noticeLegacyProject(repo, { warn: line => warnings.push(line) });
      noticeLegacyProject(repo, { warn: line => warnings.push(line) });
      expect(warnings).toHaveLength(enabled ? 1 : 0);
      store = RunStore.open(paths.write, { keepLive: true });
      expect(new Set(store.listRunIds())).toEqual(new Set([old.id, fallback.id]));
      const run = store.createRun({ title: 'new', task: 'new', workflow: 'quick-task', steps: [] });
      store.flush();
      expect(store.sourceDataDir(run.id)).toBe(paths.write);
      expect(existsSync(join(repo, '.ai/squawk-migration.json'))).toBe(false);
    } finally { store?.close(); rmSync(repo, { recursive: true, force: true }); }
  });
});
