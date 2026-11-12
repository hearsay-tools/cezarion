import { Home } from '../home/home.ts';
import { useTestHome } from '../home/test-home.testkit.ts';
import { testHome } from '../home/test-home.testkit.ts';
import { STEP_KIND } from '@open-mercato/cezar-contract/test-factories.testkit';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderAuthService } from '../core/provider-auth.ts';
import { emitUsageForTest, type ProcessUsage } from '../core/process-usage.ts';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { ProjectContexts } from './project-context.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { WorkspaceEventBus, createApp } from './server.ts';
import { createRunner } from '../core/runner-factory.ts';
import { createRunManager } from './run-manager.testkit.ts';

/**
 * Workspace SSE stream (spec 2026-07-20-multi-project-workspace, step 2.8):
 * `GET /api/v1/workspace/events` carries EVERY instantiated project's events,
 * each payload stamped with its `project` id; `usage` is split per project
 * (one stamped event per project with live rows); workspace-level bus events
 * (`project-added`, `project-removed`, `checkout-progress`) and the host-wide
 * unstamped `provider-status` event ride the same stream. Subscribing never
 * force-instantiates a project — late-built contexts join dynamically. The
 * legacy `/api/v1/events` alias stays boot-filtered with its UN-stamped,
 * byte-identical shape (protected).
 */
describe('GET /api/v1/workspace/events', () => {
  const savedHome = process.env.CEZ_HOME;
  const savedRemote = process.env.CEZ_REMOTE;
  const savedDryRun = process.env.CEZ_DRY_RUN;
  let home: string;
  let repoRoot: string;
  let otherRoot: string;
  let store: RunStore;
  let contexts: ProjectContexts;
  let bus: WorkspaceEventBus;
  let app: Hono;
  let bootId: string;
  const closers: Array<() => Promise<void>> = [];

  beforeEach(async () => {
    home = mkdtempSync(join(tmpdir(), 'cez-wsev-home-'));
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-wsev-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-wsev-other-'));
    useTestHome(home ? Home.sandbox(home) : undefined);
    delete process.env.CEZ_REMOTE;
    process.env.CEZ_DRY_RUN = '1';
    for (const root of [repoRoot, otherRoot]) {
      mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    }
    clearProjectProbeCache();
    store = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    contexts = new ProjectContexts({ createRunner, createManager: createRunManager, home: testHome(), listProjects: () => listProjects(undefined, testHome())});
    bus = new WorkspaceEventBus();
    bootId = (await registerProject(repoRoot, undefined, testHome())).id;
    app = createApp({ home: testHome(),
      repoRoot,
      store,
      manager: { isActive: () => false } as unknown as RunManager,
      version: '0.0.0-test',
      contexts,
      workspaceEvents: bus,
      providerAuth: new ProviderAuthService({
        createAuthFailureId: () => 'auth-incident-1',
      }),
    });
  });

  afterEach(async () => {
    for (const close of closers.splice(0)) await close().catch(() => undefined);
    contexts.disposeAll();
    store.flush();
    for (const dir of [home, repoRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    if (savedHome === undefined) useTestHome(undefined);
    else useTestHome(savedHome ? Home.sandbox(savedHome) : undefined);
    if (savedRemote === undefined) delete process.env.CEZ_REMOTE;
    else process.env.CEZ_REMOTE = savedRemote;
    if (savedDryRun === undefined) delete process.env.CEZ_DRY_RUN;
    else process.env.CEZ_DRY_RUN = savedDryRun;
  });

  /** Register the other project and build its context via a first API touch. */
  const buildOtherContext = async (): Promise<{
    id: string;
    store: RunStore;
  }> => {
    const other = await registerProject(otherRoot, undefined, testHome());
    expect((await apiRequest(app, `/api/v1/p/${other.id}/runs`)).status).toBe(200);
    const otherStore = contexts.peek(other.id)?.store;
    expect(otherStore).toBeDefined();
    return { id: other.id, store: otherStore as RunStore };
  };

  /** Open one SSE stream and return an incremental until-reader. */
  const openStream = async (url: string): Promise<{ readUntil: (marker: string) => Promise<string> }> => {
    const res = await apiRequest(app, url);
    expect(res.status, url).toBe(200);
    expect(res.body, url).not.toBeNull();
    const reader = (res.body as ReadableStream<Uint8Array>).getReader();
    closers.push(() => reader.cancel());
    const decoder = new TextDecoder();
    let body = '';
    return {
      async readUntil(marker: string): Promise<string> {
        const deadline = Date.now() + 5_000;
        while (!body.includes(marker) && Date.now() < deadline) {
          const timeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), Math.max(1, deadline - Date.now())),
          );
          const next = await Promise.race([reader.read(), timeout]);
          if (next === null || next.done) break;
          body += decoder.decode(next.value, { stream: true });
        }
        expect(body, `${url} never delivered ${JSON.stringify(marker)}`).toContain(marker);
        return body;
      },
    };
  };

  /** All payloads of one SSE event name delivered so far, in arrival order. */
  const payloadsOf = <T>(body: string, event: string): T[] =>
    [...body.matchAll(new RegExp(`event: ${event}\\ndata: (.*)\\n`, 'g'))].map((m) => JSON.parse(m[1] as string) as T);

  it("carries BOTH projects' store events, each stamped with its project id", async () => {
    const other = await buildOtherContext();

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    const bootRun = store.createRun({
      title: 'boot-run',
      workflow: 'quick-task',
      task: 'b',
      steps: [],
    });
    const otherRun = other.store.createRun({
      title: 'other-run',
      workflow: 'quick-task',
      task: 'o',
      steps: [],
    });

    const body = await ws.readUntil(`"id":"${otherRun.id}"`);
    const runs = payloadsOf<{ id: string; project: string }>(body, 'run');
    expect(runs).toEqual([
      { ...JSON.parse(JSON.stringify(bootRun)), project: bootId },
      { ...JSON.parse(JSON.stringify(otherRun)), project: other.id },
    ]);

    // Deletions are stamped too.
    other.store.deleteRun(otherRun.id);
    const withDeleted = await ws.readUntil('event: run-deleted');
    expect(payloadsOf(withDeleted, 'run-deleted')).toEqual([{ id: otherRun.id, project: other.id }]);
  });

  it('legacy /api/v1/events stays boot-filtered with the byte-identical, UN-stamped shape', async () => {
    const other = await buildOtherContext();

    const legacy = await openStream('/api/v1/events');
    await legacy.readUntil('event: ping');

    // Other project first: were it going to leak, it would arrive BEFORE the
    // boot event we wait for below.
    other.store.createRun({
      title: 'other-run',
      workflow: 'quick-task',
      task: 'o',
      steps: [],
    });
    const bootRun = store.createRun({
      title: 'boot-run',
      workflow: 'quick-task',
      task: 'b',
      steps: [],
    });

    const body = await legacy.readUntil(`"id":"${bootRun.id}"`);
    // Byte-identical regression (BACKWARD_COMPATIBILITY.md): the data line is
    // EXACTLY the run record — no `project` stamp, nothing reordered.
    expect(body).toContain(`event: run\ndata: ${JSON.stringify(bootRun)}\n`);
    expect(body).not.toContain('"project"');
    // …and only the boot project's events are on this stream.
    expect(body).not.toContain('other-run');
  });

  it('splits usage per project: one stamped event per project with live rows, none for row-less projects', async () => {
    const other = await buildOtherContext();
    const bootRunId = store.createRun({
      title: 'boot',
      workflow: 'quick-task',
      task: 'b',
      steps: [],
    }).id;
    const otherRunId = other.store.createRun({
      title: 'other',
      workflow: 'quick-task',
      task: 'o',
      steps: [],
    }).id;

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    const bootSample: ProcessUsage = {
      cpuPct: 12.5,
      rssBytes: 111 * 1024,
      procCount: 2,
    };
    const otherSample: ProcessUsage = {
      cpuPct: 99.9,
      rssBytes: 222 * 1024,
      procCount: 5,
    };
    emitUsageForTest({ [bootRunId]: bootSample, [otherRunId]: otherSample });

    const body = await ws.readUntil(`"project":"${other.id}","usage"`);
    await ws.readUntil(`"project":"${bootId}","usage"`);
    const events = payloadsOf<{
      project: string;
      usage: Record<string, ProcessUsage>;
    }>(body, 'usage');
    expect(events).toHaveLength(2);
    expect(events).toContainEqual({
      project: bootId,
      usage: { [bootRunId]: bootSample },
    });
    expect(events).toContainEqual({
      project: other.id,
      usage: { [otherRunId]: otherSample },
    });

    // A snapshot owned entirely by one project → exactly ONE more event; the
    // row-less project emits nothing (no empty-record clears on this stream).
    // Distinct cpuPct so the readUntil marker can't match the first event.
    emitUsageForTest({ [bootRunId]: { ...bootSample, cpuPct: 50 } });
    const after = await ws.readUntil('"cpuPct":50');
    const all = payloadsOf<{ project: string }>(after, 'usage');
    expect(all).toHaveLength(3);
    expect(all.filter((e) => e.project === other.id)).toHaveLength(1);
  });

  it("a late-built context's events appear after its first touch — and subscribing never force-instantiates", async () => {
    const other = await registerProject(otherRoot, undefined, testHome());

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');
    // Opening the stream did NOT build the registered-but-untouched project.
    expect(contexts.peek(other.id)).toBeUndefined();

    // First API touch builds the context; the stream picks it up dynamically
    // via onContextBuilt.
    expect((await apiRequest(app, `/api/v1/p/${other.id}/runs`)).status).toBe(200);
    const otherStore = contexts.peek(other.id)?.store;
    expect(otherStore).toBeDefined();
    const run = (otherStore as RunStore).createRun({
      title: 'late',
      workflow: 'quick-task',
      task: 'late',
      steps: [],
    });

    const body = await ws.readUntil(`"id":"${run.id}"`);
    expect(payloadsOf<{ id: string; project: string }>(body, 'run')).toEqual([
      { ...JSON.parse(JSON.stringify(run)), project: other.id },
    ]);
  });

  it("announces a built context as project-ready, so cockpits refetch what its recovery changed (#667)", async () => {
    const other = await registerProject(otherRoot, undefined, testHome());
    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    expect((await apiRequest(app, `/api/v1/p/${other.id}/runs`)).status).toBe(200);

    const body = await ws.readUntil('event: project-ready');
    expect(payloadsOf(body, 'project-ready')).toEqual([{ project: other.id }]);
  });

  it("broadcasts a late-built context's runtime provider invalidation without a project stamp", async () => {
    const other = await buildOtherContext();
    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    try {
      delete process.env.CEZ_DRY_RUN;
      const run = other.store.createRun({
        title: 'auth',
        workflow: 'quick-task',
        task: 'work',
        runner: 'opencode',
        steps: [{ id: 'work', name: 'Work', kind: STEP_KIND.agent }],
      });
      other.store.updateStep(run.id, 'work', { backend: 'opencode' });
      other.store.appendEvent(run.id, {
        type: 'session.error',
        stepId: 'work',
        message: 'OAuth access token is invalid',
      });

      const body = await ws.readUntil('event: provider-status');
      expect(body).toContain(
        'event: provider-status\n'
        + 'data: {"provider":"opencode","status":"disconnected",'
        + '"hint":"Authentication was rejected during a run. Reconnect, then try again.",'
        + '"authFailureId":"auth-incident-1"}\n',
      );
      expect(payloadsOf<Record<string, unknown>>(body, 'provider-status')).toEqual([{
        provider: 'opencode',
        status: 'disconnected',
        hint: 'Authentication was rejected during a run. Reconnect, then try again.',
        authFailureId: 'auth-incident-1',
      }]);
    } finally {
      process.env.CEZ_DRY_RUN = '1';
    }
  });

  it('broadcasts a global provider preference change with its enablement state', async () => {
    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    const response = await apiRequest(app, '/api/v1/providers/codex/enabled', {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ enabled: false }),
    });

    expect(response.status).toBe(200);
    const body = await ws.readUntil('event: provider-status');
    expect(payloadsOf<Record<string, unknown>>(body, 'provider-status')).toEqual([{
      provider: 'codex',
      status: 'connected',
      enabled: false,
    }]);
  });

  it('broadcasts an enabled provider row after an incident-safe retry', async () => {
    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');
    const run = store.createRun({
      title: 'auth retry',
      workflow: 'quick-task',
      task: 'work',
      runner: 'claude',
      steps: [],
    });

    try {
      delete process.env.CEZ_DRY_RUN;
      store.appendEvent(run.id, {
        type: 'error',
        message: 'Failed to authenticate. API Error: 401 OAuth access token has been revoked.',
      });
      await ws.readUntil('event: provider-status');
      process.env.CEZ_DRY_RUN = '1';

      const response = await apiRequest(app, '/api/v1/providers/claude/retry', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ authFailureId: 'auth-incident-1' }),
      });

      expect(response.status).toBe(200);
      const body = await ws.readUntil('"enabled":true');
      expect(payloadsOf<Record<string, unknown>>(body, 'provider-status')).toContainEqual({
        provider: 'claude',
        status: 'connected',
        enabled: true,
      });
    } finally {
      process.env.CEZ_DRY_RUN = '1';
    }
  });

  it('a removed project re-added on the same slug resumes flowing on an already-open stream', async () => {
    const other = await buildOtherContext();

    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    // Remove the project through the API — the stream must drop its attach
    // entry with the disposed context…
    const del = await apiRequest(app, `/api/v1/projects/${other.id}`, {
      method: 'DELETE',
    });
    expect(del.status).toBe(200);
    await ws.readUntil('event: project-removed');

    // …so that the SAME slug, re-registered and rebuilt, attaches its NEW
    // store (regression: the attach guard kept the stale entry, and the
    // rebuilt context's events were silently lost until reconnect).
    const readded = await registerProject(otherRoot, undefined, testHome());
    expect(readded.id).toBe(other.id);
    expect((await apiRequest(app, `/api/v1/p/${readded.id}/runs`)).status).toBe(200);
    const rebuilt = contexts.peek(readded.id)?.store;
    expect(rebuilt).toBeDefined();
    expect(rebuilt).not.toBe(other.store);
    const run = (rebuilt as RunStore).createRun({
      title: 're-added',
      workflow: 'quick-task',
      task: 'r',
      steps: [],
    });

    const body = await ws.readUntil(`"id":"${run.id}"`);
    expect(payloadsOf<{ id: string; project: string }>(body, 'run')).toEqual([
      { ...JSON.parse(JSON.stringify(run)), project: readded.id },
    ]);
  });

  it('without ?runs=summary stays byte-identical: full records, unnumbered deletions, no clearing usage (hearsay-tools/cezarion#2730)', async () => {
    const other = await buildOtherContext();
    // The frames the stream wrote before the shared feed, built from the same store events.
    const expected: string[] = [];
    const record = (project: string) => (run: unknown) => expected.push(`event: run\ndata: ${JSON.stringify({ ...(run as object), project })}\n\n`);
    const deleted = (project: string) => (id: string) => expected.push(`event: run-deleted\ndata: ${JSON.stringify({ id, project })}\n\n`);
    store.on('run', record(bootId));
    store.on('deleted', deleted(bootId));
    other.store.on('run', record(other.id));
    other.store.on('deleted', deleted(other.id));

    const ws = await openStream('/api/v1/workspace/events');
    const head = await ws.readUntil('event: ping');
    const generation = payloadsOf<{ generation: string }>(head, 'ready')[0]?.generation;
    expect(head).toBe(`event: ready\ndata: ${JSON.stringify({ generation })}\n\nevent: ping\ndata: \n\n`);

    const bootRun = store.createRun({ title: 'boot', workflow: 'quick-task', task: 'b', steps: [] });
    const otherRun = other.store.createRun({ title: 'other', workflow: 'quick-task', task: 'o', steps: [] });
    store.updateRun(bootRun.id, { title: 'renamed' });
    other.store.deleteRun(otherRun.id);
    emitUsageForTest({ [bootRun.id]: { cpuPct: 1, rssBytes: 2, procCount: 3 } });
    expected.push(`event: usage\ndata: ${JSON.stringify({ project: bootId, usage: { [bootRun.id]: { cpuPct: 1, rssBytes: 2, procCount: 3 } } })}\n\n`);
    // The project's last live row stopped: the legacy stream sends no clearing frame.
    emitUsageForTest({});
    bus.emit('project-added', { project: { id: 'newbie', name: 'newbie' } });
    expected.push(`event: project-added\ndata: ${JSON.stringify({ project: { id: 'newbie', name: 'newbie' } })}\n\n`);

    const body = await ws.readUntil('event: project-added');
    expect(body.slice(head.length)).toBe(expected.join(''));
    expect(body).not.toContain('"seq"');
  });

  it('?runs=summary sends index rows numbered from ready, and the index names the same generation and seq (hearsay-tools/cezarion#2730)', async () => {
    const other = await buildOtherContext();
    const ws = await openStream('/api/v1/workspace/events?runs=summary');
    const head = await ws.readUntil('event: ping');
    const ready = payloadsOf<{ generation: string; seq: number }>(head, 'ready')[0];
    expect(ready).toEqual({ generation: expect.any(String), seq: expect.any(Number) });

    const bootRun = store.createRun({ title: 'boot', workflow: 'quick-task', task: 'secret prompt', steps: [] });
    const otherRun = other.store.createRun({ title: 'other', workflow: 'quick-task', task: 'o', steps: [] });
    other.store.deleteRun(otherRun.id);
    const body = await ws.readUntil('event: run-deleted');
    expect(body).not.toContain('event: run\n');
    expect(body).not.toContain('secret prompt');

    const summaries = payloadsOf<{ project: string; seq: number; run: { id: string }; relationships: string }>(body, 'run-summary');
    const deletions = payloadsOf<{ project: string; seq: number; id: string }>(body, 'run-deleted');
    expect(summaries.map((frame) => [frame.project, frame.run.id, frame.seq])).toEqual([
      [bootId, bootRun.id, ready!.seq + 1], [other.id, otherRun.id, ready!.seq + 2],
    ]);
    expect(deletions).toEqual([{ project: other.id, seq: ready!.seq + 3, id: otherRun.id }]);

    // The frame's row is the row the index answers for the same run.
    const index = await (await apiRequest(app, '/api/v1/workspace/runs-index')).json() as {
      runs: Array<{ projectId: string; id: string }>; generation: string; eventSeq: number;
    };
    expect(index.generation).toBe(ready!.generation);
    expect(index.eventSeq).toBe(ready!.seq + 3);
    const { projectId: _project, ...row } = index.runs.find((run) => run.id === bootRun.id)!;
    expect(summaries[0]!.run).toEqual(row);
  });

  it('refuses an unknown stream mode', async () => {
    expect((await apiRequest(app, '/api/v1/workspace/events?runs=full')).status).toBe(400);
  });

  it('relays workspace-level bus events under their own names (projects, checkout, provider status)', async () => {
    const ws = await openStream('/api/v1/workspace/events');
    await ws.readUntil('event: ping');

    bus.emit('project-added', { project: { id: 'newbie', name: 'newbie' } });
    bus.emit('checkout-progress', { url: 'octo/repo', phase: 'cloning' });
    bus.emit('project-removed', { id: 'newbie' });
    bus.emit('automation-change', { project: 'newbie', automationId: 'review-prs', revision: 2 });

    const body = await ws.readUntil('event: automation-change');
    expect(payloadsOf(body, 'project-added')).toEqual([{ project: { id: 'newbie', name: 'newbie' } }]);
    expect(payloadsOf(body, 'checkout-progress')).toEqual([{ url: 'octo/repo', phase: 'cloning' }]);
    expect(payloadsOf(body, 'project-removed')).toEqual([{ id: 'newbie' }]);
    expect(payloadsOf(body, 'automation-change')).toEqual([{ project: 'newbie', automationId: 'review-prs', revision: 2 }]);
  });
});
