import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { liveRunBatchResponseSchema } from '@open-mercato/cezar-contract/live';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { createApp } from './server.ts';

// hearsay-tools/cezarion#2321: one project context failure answers the same on every transport.
const runId = '00000000-0000-4000-8000-000000002321';

describe('project context failures over HTTP and live feeds', () => {
  let home: string;
  let bootRoot: string;
  let otherRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let app: Hono;
  let otherId: string;
  let bootProjectId: string;

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-ctx-fail-home-'));
    bootRoot = mkdtempSync(join(tmpdir(), 'cez-ctx-fail-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-ctx-fail-other-'));
    vi.stubEnv('CEZ_HOME', home);
    vi.stubEnv('CEZ_SINGLE_PROJECT', '0');
    vi.stubEnv('CEZ_DRY_RUN', '1');
    for (const root of [bootRoot, otherRoot]) mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    clearProjectProbeCache();
    store = RunStore.open(join(bootRoot, '.ai/cezar'));
    contexts = new ProjectContexts({ listProjects });
    bootProjectId = (await registerProject(bootRoot)).id;
    otherId = (await registerProject(otherRoot)).id;
    app = createApp({ repoRoot: bootRoot, store, manager: {} as RunManager, version: 'test', bootProjectId, contexts });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    contexts.disposeAll();
    store.close();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    vi.unstubAllEnvs();
  });

  const json = (body: unknown) => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const demand = () => ({ runs: [{ projectId: otherId, runId, afterSeq: 0 }] });

  /** The public status and message of each path, for one failing project. */
  async function answers() {
    const http = await apiRequest(app, `/api/v1/p/${otherId}/runs`);
    const batch = liveRunBatchResponseSchema.parse(await (await apiRequest(app, '/api/v1/workspace/run-event-batches', json(demand()))).json());
    const controller = new AbortController();
    const response = await apiRequest(app, '/api/v1/workspace/run-events', { ...json(demand()), signal: controller.signal });
    const reader = response.body!.getReader();
    let wire = '';
    try {
      while (!wire.includes('"type":"ready"')) {
        const next = await reader.read();
        if (next.done) throw new Error('stream ended before ready');
        wire += new TextDecoder().decode(next.value);
      }
    } finally { controller.abort(); await reader.cancel(); }
    const frame = wire.split('\n').filter(line => line.startsWith('data: ')).map(line => JSON.parse(line.slice(6)) as { type: string })
      .find(candidate => candidate.type === 'error') as { status: number; error: string } | undefined;
    const result = batch.results[0] as { status: number; error: string };
    return {
      http: { status: http.status, error: ((await http.json()) as { error: string }).error },
      batch: { status: result.status, error: result.error },
      stream: frame && { status: frame.status, error: frame.error },
    };
  }

  it('a missing project folder answers 409 "project folder not found" on every path', async () => {
    rmSync(otherRoot, { recursive: true, force: true });
    clearProjectProbeCache();
    const expected = { status: 409, error: `project folder not found: ${otherId}` };
    expect(await answers()).toEqual({ http: expected, batch: expected, stream: expected });
  });

  it('an unexpected build error answers 503 "project unavailable" on every path and logs the cause', async () => {
    const cause = new Error('disk exploded at /secret/path');
    vi.spyOn(contexts, 'context').mockRejectedValue(cause);
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const expected = { status: 503, error: 'project unavailable' };
    expect(await answers()).toEqual({ http: expected, batch: expected, stream: expected });
    // Each path logs the original failure; no public answer carries its detail.
    expect(log).toHaveBeenCalledTimes(3);
    for (const call of log.mock.calls) {
      expect(call[0]).toBe(`[cez] project ${otherId} context build failed:`);
      expect(call[1]).toBe(cause);
    }
  });

  it('keeps unknown projects at 404 on every path', async () => {
    otherId = 'no-such-project';
    const expected = { status: 404, error: 'unknown project: no-such-project' };
    expect(await answers()).toEqual({ http: expected, batch: expected, stream: expected });
  });

  it('keeps a feed read failure in an open project at 503 "run feed unavailable"', async () => {
    vi.spyOn(store, 'getRun').mockImplementation(() => { throw new Error('history unreadable'); });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    otherId = bootProjectId;
    const expected = { status: 503, error: 'run feed unavailable' };
    const { batch, stream } = await answers();
    expect({ batch, stream }).toEqual({ batch: expected, stream: expected });
    expect(log).not.toHaveBeenCalled();
  });
});
