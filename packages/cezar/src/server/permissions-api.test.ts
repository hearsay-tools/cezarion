import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('permission decision API (hearsay-tools/cezarion#1049)', () => {
  let root: string;
  let store: RunStore;
  let id: string;
  const respondPermission = vi.fn();
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-permissions-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    id = store.createRun({ title: 'approval', workflow: 'quick-task', task: 'approval', steps: [] }).id;
    respondPermission.mockReset().mockReturnValue(true);
  });
  afterEach(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const request = (body: unknown, runId = id, prefix = '/api/v1') => apiRequest(createApp({
    repoRoot: root, store, manager: { respondPermission } as unknown as RunManager, version: 'test',
  }), `${prefix}/runs/${runId}/permissions`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });

  it.each(['/api/v1', '/api/v1/p/default'])('delivers only opaque request/option IDs through %s', async prefix => {
    const response = await request({ requestId: 'request-1', optionId: 'choice-2' }, id, prefix);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ delivered: true });
    expect(respondPermission).toHaveBeenCalledExactlyOnceWith(id, 'request-1', 'choice-2');
  });
  it.each([{}, { requestId: 'r', optionId: '' }, { requestId: 'r', optionId: 'a', decision: 'accept' }])(
    'rejects malformed decisions before delivery: %j', async body => {
      expect((await request(body)).status).toBe(400);
      expect(respondPermission).not.toHaveBeenCalled();
    },
  );
  it('refuses stale requests and unknown options without claiming delivery', async () => {
    respondPermission.mockReturnValue(false);
    const response = await request({ requestId: 'expired', optionId: 'accept' });
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'permission request is no longer available or option is invalid' });
  });
  it('does not deliver to a missing run', async () => {
    expect((await request({ requestId: 'r', optionId: 'a' }, 'missing')).status).toBe(404);
    expect(respondPermission).not.toHaveBeenCalled();
  });
});
