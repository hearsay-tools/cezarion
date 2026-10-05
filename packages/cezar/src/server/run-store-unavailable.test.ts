import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { RUNS_DB_FILE } from '../runs/run-database.ts';
import { RunStore } from '../runs/store.ts';
import { RunStoreOpenError } from '../runs/store-open-error.ts';
import type { RunManager } from '../workflows/run.ts';
import { clearProjectProbeCache, listProjects, registerProject } from '../workspace/projects.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp } from './server.ts';

/**
 * A project whose run store cannot be opened (#779, plan step 4) answers every route with why,
 * as a 409 `{ error }` — the shape a project that cannot be built already answers with — and
 * never as an empty project. Other projects and the workspace routes are unaffected.
 */

const DAMAGED = 'not a database '.repeat(100);
const post = (body: unknown): RequestInit => ({ method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('a project whose run store cannot be opened', () => {
  const saved = { home: process.env.CEZ_HOME, dryRun: process.env.CEZ_DRY_RUN, single: process.env.CEZ_SINGLE_PROJECT };
  let home: string;
  let bootRoot: string;
  let otherRoot: string;
  let contexts: ProjectContexts;
  const stores: RunStore[] = [];

  const app = (store: RunStore): Hono => createApp({
    repoRoot: bootRoot,
    store,
    manager: { isActive: () => false, finishBlockedReason: () => 'no open session' } as unknown as RunManager,
    version: '0.0.0-test',
    contexts,
  });

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'cez-unavailable-home-'));
    bootRoot = mkdtempSync(join(tmpdir(), 'cez-unavailable-boot-'));
    otherRoot = mkdtempSync(join(tmpdir(), 'cez-unavailable-other-'));
    process.env.CEZ_HOME = home;
    process.env.CEZ_DRY_RUN = '1';
    delete process.env.CEZ_SINGLE_PROJECT;
    for (const root of [bootRoot, otherRoot]) mkdirSync(join(root, '.ai/cezar'), { recursive: true });
    clearProjectProbeCache();
    contexts = new ProjectContexts({ listProjects });
  });

  afterEach(() => {
    contexts.disposeAll();
    for (const store of stores.splice(0)) store.close();
    for (const dir of [home, bootRoot, otherRoot]) rmSync(dir, { recursive: true, force: true });
    for (const [key, value] of [['CEZ_HOME', saved.home], ['CEZ_DRY_RUN', saved.dryRun], ['CEZ_SINGLE_PROJECT', saved.single]] as const) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('another project: 409 with the reason, nothing cached, and the next request after the fix opens it', async () => {
    const boot = RunStore.open(join(bootRoot, '.ai/cezar'));
    stores.push(boot);
    const server = app(boot);
    await registerProject(bootRoot);
    const other = await registerProject(otherRoot);
    const database = join(otherRoot, '.ai/cezar', RUNS_DB_FILE);
    writeFileSync(database, DAMAGED);

    for (const path of [`/api/v1/p/${other.id}/run-summaries`, `/api/v1/p/${other.id}/runs/some-id/archive`]) {
      const res = await apiRequest(server, path, path.endsWith('archive') ? post({ archived: true }) : undefined);
      expect(res.status, path).toBe(409);
      expect(((await res.json()) as { error: string }).error).toMatch(/runs\.db is damaged \(.*\)\. cezar left it and its -wal and -shm files exactly as they are/);
    }
    expect(contexts.peek(other.id)).toBeUndefined();
    expect(readFileSync(database, 'utf8')).toBe(DAMAGED);
    // The project still works as a project: the workspace lists it, and the boot project is fine.
    expect((await apiRequest(server, '/api/v1/projects')).status).toBe(200);
    expect((await apiRequest(server, '/api/v1/run-summaries')).status).toBe(200);

    // The user restores the file (here: moves the damaged one aside); the next request opens it.
    rmSync(database);
    const res = await apiRequest(server, `/api/v1/p/${other.id}/run-summaries`);
    expect(res.status).toBe(200);
    expect(contexts.peek(other.id)).toBeDefined();
  });

  it('the boot project: every spelling of every route answers 409 with the reason; workspace routes still answer', async () => {
    const failure = new RunStoreOpenError('unsupported-schema', join(bootRoot, '.ai/cezar', RUNS_DB_FILE), 'runs.db was written by a newer cezar. Upgrade cezar to open this project\'s runs.');
    const server = app(RunStore.unavailable(join(bootRoot, '.ai/cezar'), failure));
    const boot = await registerProject(bootRoot);
    for (const prefix of ['/api/v1', `/api/v1/p/${boot.id}`, '/api/v1/p/default']) {
      for (const [method, path] of [['GET', '/run-summaries'], ['GET', '/runs'], ['POST', '/runs'], ['GET', '/workflows']] as const) {
        const res = await apiRequest(server, `${prefix}${path}`, method === 'POST' ? post({ task: 'x' }) : undefined);
        expect(res.status, `${method} ${prefix}${path}`).toBe(409);
        expect(await res.json()).toEqual({ error: failure.message });
      }
    }
    for (const path of ['/api/v1/health', '/api/v1/projects']) {
      const res = await apiRequest(server, path);
      expect(res.status, `${path}: ${await res.clone().text()}`).toBe(200);
    }
  });
});
