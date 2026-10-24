import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore, type RunRecord } from '../runs/store.js';
import type { RunManager } from '../workflows/run.js';
import { createApp } from './server.js';
import { apiRequest } from './loopback-request.testkit.js';

/**
 * Read receipts (#unread-done-items): `POST /api/v1/runs/:id/read` and `POST /api/v1/runs/read-all`
 * through the real Hono app. Like the archive routes they mirror, these touch only the store, so
 * the manager can be an empty stub.
 */
describe('read receipts (#unread-done-items)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-read-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    app = createApp({
      repoRoot,
      store,
      manager: {} as unknown as RunManager, // the read routes never touch it
      version: '0.0.0-test',
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  /** A finished run with a real finishedAt, so the unread rule has an instant to compare against. */
  function finished(status: 'done' | 'failed' | 'cancelled'): string {
    const run = store.createRun({ title: 't', workflow: 'quick-task', task: 't', steps: [] });
    store.updateRun(run.id, { status, finishedAt: '2026-08-01T10:00:00.000Z' });
    return run.id;
  }

  const post = (path: string) => apiRequest(app, path, { method: 'POST' });
  const postJson = (path: string, body: unknown) =>
    apiRequest(app, path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

  describe('POST /api/v1/runs/:id/read', () => {
    it('stamps seenAt, answers the record, and persists', async () => {
      const id = finished('done');
      expect(store.getRun(id)?.seenAt).toBeUndefined();

      const res = await post(`/api/v1/runs/${id}/read`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as RunRecord;
      expect(body.seenAt).toBeDefined();
      expect(store.getRun(id)?.seenAt).toBe(body.seenAt);
    });

    it('404s an unknown id', async () => {
      expect((await post('/api/v1/runs/nope/read')).status).toBe(404);
    });
  });

  describe('POST /api/v1/runs/read-all', () => {
    it('marks every unread done/failed run read and answers the count', async () => {
      const doneUnread = finished('done');
      const failedUnread = finished('failed');
      const cancelled = finished('cancelled');

      const res = await post('/api/v1/runs/read-all');
      expect(res.status).toBe(200);
      expect((await res.json()) as { read: number }).toEqual({ read: 2 });
      expect(store.getRun(doneUnread)?.seenAt).toBeDefined();
      expect(store.getRun(failedUnread)?.seenAt).toBeDefined();
      // Cancelled runs are never unread — you stopped them yourself.
      expect(store.getRun(cancelled)?.seenAt).toBeUndefined();
    });

    it('is a no-op zero when nothing is unread', async () => {
      const res = await post('/api/v1/runs/read-all');
      expect((await res.json()) as { read: number }).toEqual({ read: 0 });
    });

    it('narrows the sweep to the origin the Tasks filter names (hearsay-tools/cezarion#1616)', async () => {
      const direct = finished('done');
      const automated = finished('done');
      store.updateRun(automated, {
        automationTrigger: { automationId: 'nightly', automationRevision: 1, receiptId: 'r1', trigger: 'schedule', occurrenceAt: '2026-08-01T09:00:00.000Z' },
      });
      // A direct autonomous task stays direct: origin is the recorded provenance, not the flag.
      const autonomous = finished('failed');
      store.updateRun(autonomous, { autonomous: true });

      const automations = await postJson('/api/v1/runs/read-all', { automation: true });
      expect((await automations.json()) as { read: number }).toEqual({ read: 1 });
      expect(store.getRun(automated)?.seenAt).toBeDefined();
      expect(store.getRun(direct)?.seenAt).toBeUndefined();
      expect(store.getRun(autonomous)?.seenAt).toBeUndefined();

      const directOnly = await postJson('/api/v1/runs/read-all', { automation: false });
      expect((await directOnly.json()) as { read: number }).toEqual({ read: 2 });
      expect(store.getRun(direct)?.seenAt).toBeDefined();
    });

    it('refuses a wrong-typed origin rather than sweeping everything', async () => {
      const id = finished('done');
      const res = await postJson('/api/v1/runs/read-all', { automation: 'yes' });
      expect(res.status).toBe(400);
      expect(store.getRun(id)?.seenAt).toBeUndefined();
    });
  });

  describe('POST /api/v1/runs/:id/unread (#775)', () => {
    it('clears seenAt, answers the record, and persists', async () => {
      const id = finished('done');
      await post(`/api/v1/runs/${id}/read`);
      expect(store.getRun(id)?.seenAt).toBeDefined();

      const res = await post(`/api/v1/runs/${id}/unread`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as RunRecord;
      expect(body.seenAt).toBeUndefined();
      expect(store.getRun(id)?.seenAt).toBeUndefined();
    });

    it('404s an unknown id', async () => {
      expect((await post('/api/v1/runs/nope/unread')).status).toBe(404);
    });

    it('round-trips read → unread → read without leaving the record inconsistent', async () => {
      // The grammar the cockpit relies on: after the round-trip the run is read again with a
      // fresh receipt, and the sweep that would have claimed it mid-trip finds nothing left.
      const id = finished('done');

      await post(`/api/v1/runs/${id}/read`);
      const firstReceipt = store.getRun(id)?.seenAt;
      expect(firstReceipt).toBeDefined();

      await post(`/api/v1/runs/${id}/unread`);
      expect(store.getRun(id)?.seenAt).toBeUndefined();
      // Back in the unread population the badge counts.
      expect((await (await post('/api/v1/runs/read-all')).json()) as { read: number }).toEqual({ read: 1 });

      const secondReceipt = store.getRun(id)?.seenAt;
      expect(secondReceipt).toBeDefined();
      expect(secondReceipt! >= firstReceipt!).toBe(true);
    });
  });
});
