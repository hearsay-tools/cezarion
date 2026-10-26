import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { handoffPath, seedHandoffFile } from '../handoff.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

/**
 * `GET /runs/:id/handoff` (spec 007) shows the file with cezar's records from the run store
 * (hearsay-tools/cezarion#1809): the agent may have rewritten the block or the whole file since
 * the last write.
 */
describe('GET /runs/:id/handoff', () => {
  const saved = { home: process.env.CEZ_HOME, single: process.env.CEZ_SINGLE_PROJECT };
  let home: string;
  let repoRoot: string;
  let dataDir: string;
  let store: RunStore;
  let projectId: string;
  const records = { autosave: [{ at: '2026-10-25T10:00:00.000Z', note: 'turn end: cezar autosave committed abc1234 on cez/x' }] };

  beforeEach(async () => {
    home = mkdtempSync(join(realpathSync(tmpdir()), 'cez-handoff-home-'));
    repoRoot = mkdtempSync(join(realpathSync(tmpdir()), 'cez-handoff-repo-'));
    process.env.CEZ_HOME = home;
    delete process.env.CEZ_SINGLE_PROJECT;
    clearProjectProbeCache();
    dataDir = join(repoRoot, '.ai/cezar');
    store = RunStore.open(dataDir);
    projectId = (await registerProject(repoRoot)).id;
  });

  afterEach(() => {
    store.close();
    for (const dir of [home, repoRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, env] of [['home', 'CEZ_HOME'], ['single', 'CEZ_SINGLE_PROJECT']] as const) {
      if (saved[key] === undefined) delete process.env[env];
      else process.env[env] = saved[key];
    }
  });

  const get = async (id: string) => {
    const app = createApp({ repoRoot, store, manager: {} as RunManager, version: '0.0.0-test', bootProjectId: projectId });
    const res = await apiRequest(app, `/api/v1/runs/${id}/handoff`);
    return { status: res.status, text: await res.text() };
  };
  const createRun = () => store.createRun({ title: 't', workflow: 'quick-task', task: 'do it', steps: [] }).id;

  it('shows the store records in a file whose block the agent removed', async () => {
    const id = createRun();
    store.updateRun(id, { handoffRecords: records });
    seedHandoffFile(dataDir, store.getRun(id)!);
    writeFileSync(handoffPath(dataDir, id), '# My own handoff\n\n## Goal\n\ndo it\n\n## Progress log\n\n- 10:00 — rewrote it\n');

    const { status, text } = await get(id);
    expect(status).toBe(200);
    expect(text).toContain('### Autosave\n\n- 2026-10-25T10:00:00.000Z — turn end: cezar autosave committed abc1234 on cez/x\n');
    expect(text.indexOf('### Autosave')).toBeLessThan(text.indexOf('## Goal'));
    expect(text.endsWith('## Progress log\n\n- 10:00 — rewrote it\n')).toBe(true);
  });

  it('shows the file as it is for a run without records', async () => {
    const id = createRun();
    seedHandoffFile(dataDir, store.getRun(id)!);
    const { text } = await get(id);
    expect(text).not.toContain('cezar:records');
    expect(text).toContain('## Progress log\n\n## Resume notes\n');
  });

  it("answers '' for a run without a file, and 404 for an unknown run", async () => {
    const id = createRun();
    store.updateRun(id, { handoffRecords: records });
    expect(await get(id)).toEqual({ status: 200, text: '' });
    expect((await get('missing')).status).toBe(404);
  });
});
