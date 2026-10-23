import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { RunManager } from '../workflows/run.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('generated inbox retirement — hearsay-tools/cezarion#1543', () => {
  let root: string;
  let store: RunStore;
  const bytes = '[\n {"summary":"retained without an id","unknown":"keep me"},\n {"invalid":true}\n]\n';
  const previous = process.env.CEZ_FOLLOWUPS;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-inbox-retired-'));
    store = RunStore.open(join(root, '.ai/cezar'));
    writeFileSync(join(root, '.ai/cezar/todos.json'), bytes);
    process.env.CEZ_FOLLOWUPS = '1';
  });
  afterEach(() => {
    store.flush();
    rmSync(root, { recursive: true, force: true });
    if (previous === undefined) delete process.env.CEZ_FOLLOWUPS;
    else process.env.CEZ_FOLLOWUPS = previous;
  });
  it('removes todo endpoints under every alias without touching retained bytes', async () => {
    const app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: '0.0.0-test' });
    for (const prefix of ['/api/v1', '/api/v1/p/default']) {
      for (const [method, path] of [['GET', '/todos'], ['DELETE', '/todos/old'], ['POST', '/todos/old/start']]) {
        const response = await apiRequest(app, `${prefix}${path}`, { method });
        expect(response.status, `${method} ${prefix}${path}`).toBe(404);
        expect(readFileSync(join(root, '.ai/cezar/todos.json'), 'utf8')).toBe(bytes);
      }
    }
  });
});
