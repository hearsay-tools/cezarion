import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { artifactDirectory, publishArtifact } from '../artifacts/store.ts';
import { artifactListSchema, artifactMetadataResponseSchema, fileLinkResultSchema, filePreviewDataSchema } from '@open-mercato/cezar-contract/artifacts';
import type { RunManager } from '../workflows/run.ts';
import { ProjectContexts } from './project-context.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';

describe('task file links', () => {
  let root: string, working: string, dataDir: string, runId: string, store: RunStore;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-file-link-'));
    working = join(root, 'worktree'); mkdirSync(working);
    dataDir = join(root, '.ai/cezar'); store = RunStore.open(dataDir);
    runId = store.createRun({ title: 'Files', workflow: 'quick-task', task: 'read files', steps: [] }).id;
    store.updateRun(runId, { worktreePath: working });
    writeFileSync(join(working, 'ADR space.md'), '# working copy');
    writeFileSync(join(root, 'ADR space.md'), '# project copy');
  });
  afterEach(() => { store.flush(); rmSync(root, { recursive: true, force: true }); });
  const get = (suffix: string, alias = '') => apiRequest(createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' }), `/api/v1${alias}/runs/${runId}${suffix}`);
  const link = (path: string, alias = '') => get(`/file-link?path=${encodeURIComponent(path)}`, alias);

  it('previews an absolute task path rather than resolving it against the web origin', async () => {
    const response = await link(join(working, 'ADR space.md'));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ type: 'file', content: '# working copy', source: 'worktree' });
  });
  it('resolves relative paths against the task, and checkout absolute paths without substitution', async () => {
    expect(await (await link('ADR space.md')).json()).toMatchObject({ content: '# working copy' });
    writeFileSync(join(working, 'literal%20.md'), 'literal percent');
    expect(await (await link('literal%20.md')).json()).toMatchObject({ content: 'literal percent' });
    expect(await (await link(join(root, 'ADR space.md'))).json()).toMatchObject({ content: '# project copy', source: 'project' });
  });
  it('accepts local file URLs and the project alias', async () => {
    expect(await (await link(pathToFileURL(join(working, 'ADR space.md')).href, '/p/default')).json()).toMatchObject({ content: '# working copy' });
  });
  it('does not read an unpublished host path', async () => {
    expect(await (await link('/etc/passwd')).json()).toMatchObject({ type: 'unpublished' });
  });
  it('rejects symlink escapes and private state', async () => {
    symlinkSync('/etc', join(working, 'escape'));
    expect(await (await link('escape/passwd')).json()).toMatchObject({ type: 'unavailable' });
    expect(await (await link(join(dataDir, 'runs.json'))).json()).toMatchObject({ type: 'unavailable' });
    expect(await (await link(join(dataDir, 'runs.db'))).json()).toMatchObject({ type: 'unavailable' });
    mkdirSync(join(working, '.git')); writeFileSync(join(working, '.git', 'config'), 'private config');
    symlinkSync(join(working, '.git'), join(working, 'alias'));
    expect(await (await link('alias/config')).json()).toMatchObject({ type: 'unavailable' });
  });
  it('refuses network file authorities and malformed paths without fetching them', async () => {
    for (const path of ['file://server/share/a.md', 'file:///tmp/%zz', 'javascript:bad', 'bad\0path']) {
      const response = await link(path);
      expect([200, 400]).toContain(response.status);
      if (response.status === 200) expect(await response.json()).toMatchObject({ type: 'unavailable' });
    }
  });
  it('does not serve active content as raw bytes', async () => {
    writeFileSync(join(working, 'bad.svg'), '<svg><script>alert(1)</script></svg>');
    expect((await get('/file-link?path=bad.svg&raw=1')).status).toBe(409);
  });
  it('previews and downloads the exact published bytes after the external original disappears', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'cez-external-artifact-'));
    try {
      const path = join(outside, 'decision.md'); writeFileSync(path, '# published');
      const artifact = await publishArtifact(artifactDirectory(dataDir, runId), runId, path);
      rmSync(outside, { recursive: true, force: true });
      const lookup = fileLinkResultSchema.parse(await (await link(path)).json());
      expect(lookup).toMatchObject({ type: 'file', source: 'artifact', content: '# published' });
      rmSync(working, { recursive: true, force: true });
      const preview = await get(`/artifacts/${artifact.id}`, '/p/default');
      expect(preview.status).toBe(200);
      expect(filePreviewDataSchema.parse(await preview.json())).toMatchObject({ content: '# published', artifact: { id: artifact.id } });
      const download = await get(`/artifacts/${artifact.id}/download`);
      expect(await download.text()).toBe('# published');
      expect(download.headers.get('content-disposition')).toContain('attachment;');
      expect(download.headers.get('x-content-type-options')).toBe('nosniff');
      expect((await get(`/artifacts/${artifact.id}/image`)).status).toBe(409);
      expect(artifactListSchema.parse(await (await get('/artifacts')).json()).artifacts).toHaveLength(1);
      const other = store.createRun({ title: 'other', task: 'other', workflow: 'quick-task', steps: [] });
      const app = createApp({ repoRoot: root, store, manager: {} as RunManager, version: 'test' });
      expect((await apiRequest(app, `/api/v1/runs/${other.id}/artifacts/${artifact.id}`)).status).toBe(404);
    } finally { rmSync(outside, { recursive: true, force: true }); }
  });
  it('keeps hostile artifact content inert and validates selectors', async () => {
    const path = join(working, 'bad.html'); writeFileSync(path, '<script>alert(1)</script>');
    const artifact = await publishArtifact(artifactDirectory(dataDir, runId), runId, path);
    expect(filePreviewDataSchema.parse(await (await get(`/artifacts/${artifact.id}`)).json()).content).toContain('<script>');
    expect((await get(`/artifacts/${artifact.id}/image`)).status).toBe(409);
    expect((await get('/artifacts/not-a-uuid')).status).toBe(400);
    expect((await get('/file-link?path=a&raw=unexpected')).status).toBe(400);
  });
  it('returns metadata and a title without content through the scoped mount', async () => {
    const path = join(working, 'report.html');
    writeFileSync(path, '<title>Report &amp; results</title><p>private body</p>');
    const artifact = await publishArtifact(artifactDirectory(dataDir, runId), runId, path);
    const response = await get(`/artifacts/${artifact.id}/metadata`, '/p/default');
    expect(response.status).toBe(200);
    const body = artifactMetadataResponseSchema.parse(await response.json());
    expect(body).toEqual({ artifact: { ...artifact, title: 'Report & results' } });
    expect(JSON.stringify(body)).not.toContain('private body');
  });
  it('does not expose a boot-project artifact through another project', async () => {
    const path = join(working, 'report.html'); writeFileSync(path, '<title>Owned</title>');
    const artifact = await publishArtifact(artifactDirectory(dataDir, runId), runId, path);
    const otherRoot = join(root, 'other'); mkdirSync(otherRoot);
    const contexts = new ProjectContexts({ listProjects: async () => [{ id: 'other', root: otherRoot, status: 'not-git' }] });
    try {
      const app = createApp({ repoRoot: root, store, contexts, manager: {} as RunManager, version: 'test' });
      expect((await apiRequest(app, `/api/v1/p/default/runs/${runId}/artifacts/${artifact.id}/metadata`)).status).toBe(200);
      expect((await apiRequest(app, `/api/v1/p/other/runs/${runId}/artifacts/${artifact.id}/metadata`)).status).toBe(404);
    } finally { contexts.disposeAll(); }
  });
  it('returns 404 for unknown, deleted and size-mismatched metadata selections', async () => {
    expect((await get(`/artifacts/${randomUUID()}/metadata`)).status).toBe(404);
    const path = join(working, 'report.html'); writeFileSync(path, '<title>Report</title>');
    const artifact = await publishArtifact(artifactDirectory(dataDir, runId), runId, path);
    const content = join(artifactDirectory(dataDir, runId), artifact.id, 'content');
    writeFileSync(content, 'short');
    expect((await get(`/artifacts/${artifact.id}/metadata`)).status).toBe(404);
    rmSync(content);
    expect((await get(`/artifacts/${artifact.id}/metadata`)).status).toBe(404);
    expect((await get('/artifacts/not-a-uuid/metadata')).status).toBe(400);
  });
  it('does not hash content for metadata, while content reads still verify it', async () => {
    const path = join(working, 'report.txt'); writeFileSync(path, 'original');
    const artifact = await publishArtifact(artifactDirectory(dataDir, runId), runId, path);
    writeFileSync(join(artifactDirectory(dataDir, runId), artifact.id, 'content'), 'modified');
    expect((await get(`/artifacts/${artifact.id}/metadata`)).status).toBe(200);
    expect((await get(`/artifacts/${artifact.id}`)).status).toBe(404);
  });
  it('lists no publications for old tasks', async () => {
    expect(await (await get('/artifacts')).json()).toEqual({ artifacts: [] });
  });
});
