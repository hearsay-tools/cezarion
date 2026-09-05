import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import type { PastedContent, RunManager, StartRunInput } from '../workflows/run.ts';
import type { WorkflowDef } from '../workflows/types.ts';
import { createApp } from './server.ts';
import { apiRequest } from './loopback-request.testkit.ts';
import { connectedProviderAuth } from './provider-auth.testkit.ts';

/**
 * #950 — the attachment half of the runs routes, now that an attachment is not necessarily an
 * image. Three things are worth pinning at the HTTP boundary, because none of them can be seen
 * from the engine's side:
 *
 *  - the media-type allowlist: a PDF/TXT/MD gets in, everything else is a 400, and `image/*` is
 *    as wide as it always was (narrowing it would break every client that ever pasted an SVG);
 *  - what the engine is handed: an image as a viewable block, a file as a `file` block it will
 *    turn into a path — one mapping, shared by all four attachment-carrying routes;
 *  - what the serving route hands a BROWSER: these are user-supplied bytes coming back from the
 *    cockpit's own origin, so a non-image leaves under `nosniff` + an attachment disposition,
 *    while an image answers byte-for-byte as it always has.
 */
describe('attachment routes (#950)', () => {
  let repoRoot: string;
  let store: RunStore;
  let app: Hono;
  let captured: StartRunInput | undefined;
  let delivered: PastedContent[] | undefined;

  const PNG_B64 = Buffer.from('fake-png-bytes').toString('base64');
  const MD_B64 = Buffer.from('# brief\n').toString('base64');
  const PDF_B64 = Buffer.from('%PDF-1.4 fake\n').toString('base64');

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-attachments-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    captured = undefined;
    delivered = undefined;
    const manager = {
      startRun: (_workflow: WorkflowDef, input: StartRunInput) => {
        captured = input;
        return store.createRun({ title: 't', workflow: '(planned)', task: input.task, steps: [] });
      },
      continueRun: () => ({ ok: true }),
      editQueuedMessage: (_id: string, _msgId: string, edit: { images?: PastedContent[] }) => {
        delivered = edit.images;
        return { id: 'm1', text: 'queued', createdAt: '2026-09-05T00:00:00Z' };
      },
      sendMessage: (_id: string, content: PastedContent[]) => {
        delivered = content;
        return true;
      },
    } as unknown as RunManager;
    app = createApp({
      repoRoot,
      store,
      manager,
      version: '0.0.0-test',
      providerAuth: connectedProviderAuth(),
    });
  });

  afterEach(() => {
    store.flush();
    rmSync(repoRoot, { recursive: true, force: true });
  });

  const post = (path: string, body: unknown) =>
    apiRequest(app, path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  const base = { task: 'read the brief', steps: [{ id: 'work', prompt: '{{task}}' }] };

  describe('POST /api/v1/runs', () => {
    it('takes a PDF and a markdown file, and hands the engine file blocks', async () => {
      const res = await post('/api/v1/runs', {
        ...base,
        images: [
          { mediaType: 'application/pdf', data: PDF_B64 },
          { mediaType: 'text/markdown', data: MD_B64 },
        ],
      });
      expect(res.status).toBe(201);
      expect(captured?.images).toEqual([
        { type: 'file', mediaType: 'application/pdf', data: PDF_B64 },
        { type: 'file', mediaType: 'text/markdown', data: MD_B64 },
      ]);
    });

    it('still hands an image through as a viewable block', async () => {
      const res = await post('/api/v1/runs', {
        ...base,
        images: [{ mediaType: 'image/png', data: PNG_B64 }],
      });
      expect(res.status).toBe(201);
      expect(captured?.images).toEqual([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: PNG_B64 } },
      ]);
    });

    /** The allowlist is what keeps `text/html` and SVG-as-a-document out of a folder this server
     *  serves back from its own origin. A refusal is a 400, not a silent drop. */
    it('refuses a type outside the allowlist', async () => {
      const res = await post('/api/v1/runs', {
        ...base,
        images: [{ mediaType: 'application/zip', data: PDF_B64 }],
      });
      expect(res.status).toBe(400);
    });

    it('refuses text/html, which is the type the allowlist exists for', async () => {
      const res = await post('/api/v1/runs', {
        ...base,
        images: [{ mediaType: 'text/html', data: MD_B64 }],
      });
      expect(res.status).toBe(400);
    });

    /** Images were NEVER narrowed by this change — an exotic image type a client has always been
     *  allowed to paste must still be allowed. */
    it('keeps accepting any image/* type, as it always did', async () => {
      const res = await post('/api/v1/runs', {
        ...base,
        images: [{ mediaType: 'image/svg+xml', data: PNG_B64 }],
      });
      expect(res.status).toBe(201);
    });
  });

  describe('POST /api/v1/runs/:id/messages', () => {
    it('accepts an attachment-only message and delivers it as a file block', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'chat', steps: [] });
      store.updateRun(run.id, { status: 'waiting' });
      const res = await post(`/api/v1/runs/${run.id}/messages`, {
        images: [{ mediaType: 'text/plain', data: MD_B64 }],
      });
      expect(res.status).toBe(200);
      expect(delivered).toEqual([{ type: 'file', mediaType: 'text/plain', data: MD_B64 }]);
    });

    it('refuses a message that is empty in both text and attachments', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'chat', steps: [] });
      store.updateRun(run.id, { status: 'waiting' });
      const res = await post(`/api/v1/runs/${run.id}/messages`, { text: '   ' });
      expect(res.status).toBe(400);
      expect(((await res.json()) as { error: string }).error).toContain('at least one attachment');
    });
  });

  describe.each(['create', 'message', 'edit', 'continue'] as const)('%s attachment boundaries', (route) => {
    async function request(images: Array<{ mediaType: string; data: string }>) {
      if (route === 'create') return post('/api/v1/runs', { ...base, images });
      const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
      store.updateRun(run.id, {
        status: route === 'edit' ? 'queued' : route === 'continue' ? 'done' : 'waiting',
        queuedMessages: [{ id: 'm1', text: 'queued', createdAt: '2026-09-05T00:00:00Z' }],
      });
      if (route === 'edit') return apiRequest(app, `/api/v1/runs/${run.id}/queued-messages/m1`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images }),
      });
      return post(`/api/v1/runs/${run.id}/${route === 'continue' ? 'continue' : 'messages'}`, { images });
    }
    const mixed = ['image/png', 'application/pdf', 'text/plain', 'text/markdown'].map((mediaType) => ({ mediaType, data: 'YQ==' }));
    it('accepts four mixed files and rejects a fifth', async () => {
      expect((await request(mixed)).status).toBe(route === 'create' ? 201 : 200);
      expect((await request([...mixed, mixed[0]!])).status).toBe(400);
    });
    it.each(['image/png', 'application/pdf'])('enforces encoded length independently for %s', async (mediaType) => {
      expect((await request([{ mediaType, data: 'A'.repeat(7_000_000) }])).status).toBe(route === 'create' ? 201 : 200);
      expect((await request([{ mediaType, data: 'A'.repeat(7_000_001) }])).status).toBe(400);
    });
  });

  describe('GET /api/v1/runs/:id/images/:file', () => {
    const seed = (id: string, name: string, body: string) => {
      const dir = join(repoRoot, '.ai/cezar', 'runs', `${id}-images`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, name), body);
    };

    it.each(['pasted-1.pdf', 'pasted-1.png'])('refuses an outside symlink %s', async (name) => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
      seed(run.id, 'regular.txt', 'inside');
      const outside = join(repoRoot, 'secret.txt');
      writeFileSync(outside, 'outside-secret');
      symlinkSync(outside, join(repoRoot, '.ai/cezar/runs', `${run.id}-images`, name));
      const res = await apiRequest(app, `/api/v1/runs/${run.id}/images/${name}`);
      expect(res.status).toBe(404);
      expect(await res.text()).not.toContain('outside-secret');
    });

    it('refuses a symlink replacing the attachment directory', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
      const outside = join(repoRoot, 'outside');
      mkdirSync(outside);
      writeFileSync(join(outside, 'pasted-1.pdf'), 'outside-secret');
      symlinkSync(outside, join(repoRoot, '.ai/cezar/runs', `${run.id}-images`));
      const res = await apiRequest(app, `/api/v1/runs/${run.id}/images/pasted-1.pdf`);
      expect(res.status).toBe(404);
    });

    it.each(['..%2Fpasted-1.pdf', '..%5Cpasted-1.pdf', '%252e%252e%252fpasted-1.pdf'])('rejects encoded traversal %s without basename aliasing', async (name) => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
      seed(run.id, 'pasted-1.pdf', 'inside');
      const res = await apiRequest(app, `/api/v1/runs/${run.id}/images/${name}`);
      expect([400, 404]).toContain(res.status);
    });

    it('serves an image exactly as before — no download headers in the way of an <img>', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
      seed(run.id, 'pasted-1.png', 'png-bytes');
      const res = await apiRequest(app, `/api/v1/runs/${run.id}/images/pasted-1.png`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('image/png');
      expect(res.headers.get('content-disposition')).toBeNull();
    });

    it('serves a PDF as a download, never as a document on the cockpit origin', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
      seed(run.id, 'pasted-2.pdf', '%PDF-1.4 fake');
      const res = await apiRequest(app, `/api/v1/runs/${run.id}/images/pasted-2.pdf`);
      expect(res.status).toBe(200);
      expect(res.headers.get('content-type')).toBe('application/pdf');
      expect(res.headers.get('x-content-type-options')).toBe('nosniff');
      expect(res.headers.get('content-disposition')).toBe('attachment; filename="pasted-2.pdf"');
      expect(await res.text()).toBe('%PDF-1.4 fake');
    });

    it('serves markdown and text as plain text, never as markup', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
      seed(run.id, 'pasted-3.md', '<script>alert(1)</script>');
      seed(run.id, 'pasted-4.txt', 'notes');
      const md = await apiRequest(app, `/api/v1/runs/${run.id}/images/pasted-3.md`);
      expect(md.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(md.headers.get('x-content-type-options')).toBe('nosniff');
      expect(md.headers.get('content-disposition')).toBe('attachment; filename="pasted-3.md"');
      const txt = await apiRequest(app, `/api/v1/runs/${run.id}/images/pasted-4.txt`);
      expect(txt.headers.get('content-type')).toBe('text/plain; charset=utf-8');
      expect(txt.headers.get('x-content-type-options')).toBe('nosniff');
    });

    /** The pre-existing catch-all: an `.img` (an SVG paste, historically) keeps answering
     *  `application/octet-stream` and its original inline response headers. */
    it('keeps the legacy img octet-stream response inline', async () => {
      const run = store.createRun({ title: 't', workflow: 'w', task: 'x', steps: [] });
      seed(run.id, 'pasted-5.img', 'whatever');
      const res = await apiRequest(app, `/api/v1/runs/${run.id}/images/pasted-5.img`);
      expect(res.headers.get('content-type')).toBe('application/octet-stream');
      expect(res.headers.get('x-content-type-options')).toBeNull();
      expect(res.headers.get('content-disposition')).toBeNull();
      expect(await res.text()).toBe('whatever');
    });
  });
});
