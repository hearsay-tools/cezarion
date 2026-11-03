import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ContentBlock } from '../core/agent-runner.ts';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import type { WorkflowDef } from './types.ts';
import { RUN_STATUS } from '@open-mercato/cezar-contract/test-factories.testkit';
import './run-fixture.testkit.ts';
describe('RunManager queued-stack mutators (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const PNG = Buffer.from('png').toString('base64');

  const WORKFLOW: WorkflowDef = {
    name: '(planned)',
    source: 'built-in',
    steps: [{ id: 'task', name: 'Do the task', prompt: '{{task}}' }],
  };

  const text = (t: string): ContentBlock[] => [{ type: 'text', text: t }];
  const image = (): ContentBlock => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: PNG },
  });

  /** Seed a run that the engine still holds as queued. */
  const seedQueued = (task = 'ship it') => {
    const record = store.createRun({ title: 't', workflow: 'w', task, steps: [] });
    runInternals(manager).line.pendingJobs.set(record.id, { workflow: WORKFLOW, input: { task } });
    return record;
  };
  const dequeue = (id: string) =>
    runInternals(manager).line.pendingJobs.delete(id);
  const imagesDir = (id: string) => join(repoRoot, '.ai/cezar', 'runs', `${id}-images`);

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-stack-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('appends messages in order while queued', () => {
    const r = seedQueued();
    const first = manager.enqueueMessage(r.id, text('also update the changelog'));
    const second = manager.enqueueMessage(r.id, text('and bump the version'));
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(store.getRun(r.id)?.queuedMessages?.map((m) => m.text)).toEqual([
      'also update the changelog',
      'and bump the version',
    ]);
  });

  it('notes a document persistence failure instead of silently losing the upload', () => {
    const r = seedQueued();
    writeFileSync(imagesDir(r.id), 'not a directory');
    manager.enqueueMessage(r.id, [{ type: 'file', mediaType: 'application/pdf', data: 'YQ==' }]);
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes('could not be saved'))).toBe(true);
    store.flush();
    const reopened = RunStore.open(join(repoRoot, '.ai/cezar'), { keepLive: true });
    expect(reopened.getRun(r.id)?.queuedMessages?.[0]?.text).toContain('could not be saved');
  });

  it('retains a delivery explanation when a document-only queued edit cannot be saved', () => {
    const r = seedQueued();
    const message = manager.enqueueMessage(r.id, text('replace me'))!;
    writeFileSync(imagesDir(r.id), 'not a directory');
    const edited = manager.editQueuedMessage(r.id, message.id, {
      text: '', images: [{ type: 'file', mediaType: 'application/pdf', data: 'YQ==' }],
    });
    expect(edited?.text).toContain('could not be saved');
  });

  it('persists attached images and records their URLs', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image(), { type: 'text', text: 'like this' }]);
    expect(msg?.images).toEqual([`/api/v1/runs/${r.id}/images/pasted-1.png`]);
    expect(existsSync(join(imagesDir(r.id), 'pasted-1.png'))).toBe(true);
  });

  it('hydrates edits and stacked messages into a queued restart continuation', async () => {
    const r = store.createRun({
      title: 'interrupted task',
      workflow: 'quick-task',
      task: 'original recovery goal',
      steps: [],
    });
    store.updateRun(r.id, { status: RUN_STATUS.queued });

    const internals = manager as unknown as {
      runContinuation(
        runId: string,
        stepId: string,
        sessionId: string | undefined,
        backend: 'claude',
        prompt: string,
        images: ContentBlock[],
        persistedImages: ContentBlock[],
        persistedAttachments: Array<{ name: string; url: string; path: string }>,
      ): Promise<void>;
    };
    runInternals(manager).line.pendingContinuations.set(r.id, {
      stepId: 'continue-1',
      sessionId: 'session-interrupted',
      backend: 'claude',
      prompt: 'restart recovery',
      images: [],
      lineJoinedAt: Date.parse(r.createdAt),
    });
    runInternals(manager).line.queue.push(r.id);

    expect(manager.editTask(r.id, 'amended recovery goal')).toBe(true);
    expect(
      manager.enqueueMessage(r.id, [image(), { type: 'file', mediaType: 'text/markdown', data: Buffer.from('# queued brief').toString('base64') }, { type: 'text', text: 'also verify the queue' }]),
    ).not.toBeNull();

    let delivered:
      | {
          prompt: string;
          images: ContentBlock[];
          persistedImages: ContentBlock[];
          persistedAttachments: Array<{ name: string; url: string; path: string }>;
        }
      | undefined;
    internals.runContinuation = async (
      _runId,
      _stepId,
      _sessionId,
      _backend,
      prompt,
      images,
      persistedImages,
      persistedAttachments,
    ) => {
      delivered = { prompt, images, persistedImages, persistedAttachments };
    };
    await runInternals(manager).line.pump();

    expect(delivered?.prompt).toBe(
      'restart recovery\n\nCurrent task and queued updates:\n\n' +
        'amended recovery goal\n\nalso verify the queue',
    );
    expect(delivered?.images).toEqual([]);
    expect(delivered?.persistedImages).toEqual([image()]);
    expect(delivered?.persistedAttachments).toEqual([
      {
        name: 'pasted-1.png',
        url: `/api/v1/runs/${r.id}/images/pasted-1.png`,
        path: join(imagesDir(r.id), 'pasted-1.png'),
      },
      { name: 'pasted-2.md', url: `/api/v1/runs/${r.id}/images/pasted-2.md`, path: join(imagesDir(r.id), 'pasted-2.md') },
    ]);
    expect(readdirSync(imagesDir(r.id)).sort()).toEqual(['pasted-1.png', 'pasted-2.md']);
    expect(runInternals(manager).line.pendingContinuations.has(r.id)).toBe(false);
    expect(manager.editTask(r.id, 'too late')).toBe(false);
  });

  it('refuses every mutation once the run has been dequeued', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, text('while queued'))!;
    dequeue(r.id);

    expect(manager.enqueueMessage(r.id, text('too late'))).toBeNull();
    expect(manager.editQueuedMessage(r.id, msg.id, { text: 'too late' })).toBeNull();
    expect(manager.removeQueuedMessage(r.id, msg.id)).toBe(false);
    expect(manager.editTask(r.id, 'too late')).toBe(false);
    // …and the stack is untouched by the refused calls.
    expect(store.getRun(r.id)?.queuedMessages?.map((m) => m.text)).toEqual(['while queued']);
  });

  it('edits a message in place, keeping its id and createdAt', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, text('typo here'))!;
    const edited = manager.editQueuedMessage(r.id, msg.id, { text: 'fixed now' })!;
    expect(edited.id).toBe(msg.id);
    expect(edited.createdAt).toBe(msg.createdAt);
    expect(store.getRun(r.id)?.queuedMessages).toEqual([edited]);
  });

  it('keeps existing attachments when an edit only changes the text', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image(), { type: 'text', text: 'typo' }])!;
    const file = join(imagesDir(r.id), 'pasted-1.png');

    const edited = manager.editQueuedMessage(r.id, msg.id, { text: 'fixed' })!;

    expect(edited.images).toEqual(msg.images);
    expect(existsSync(file)).toBe(true);
  });

  it('returns null when the message id is unknown', () => {
    const r = seedQueued();
    expect(manager.editQueuedMessage(r.id, 'nope', { text: 'x' })).toBeNull();
    expect(manager.removeQueuedMessage(r.id, 'nope')).toBe(false);
  });

  it('removes a message and unlinks its orphaned images', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image()])!;
    const file = join(imagesDir(r.id), 'pasted-1.png');
    expect(existsSync(file)).toBe(true);

    expect(manager.removeQueuedMessage(r.id, msg.id)).toBe(true);
    expect(store.getRun(r.id)?.queuedMessages).toEqual([]);
    expect(existsSync(file)).toBe(false);
  });

  /** Never delete a file another entry still points at. */
  it('keeps an image that a surviving message still references', () => {
    const r = seedQueued();
    const first = manager.enqueueMessage(r.id, [image()])!;
    const shared = first.images![0]!;
    // A second entry deliberately pointing at the same file.
    const second = manager.enqueueMessage(r.id, text('see above'))!;
    store.updateRun(r.id, {
      queuedMessages: store
        .getRun(r.id)!
        .queuedMessages!.map((m) => (m.id === second.id ? { ...m, images: [shared] } : m)),
    });

    manager.removeQueuedMessage(r.id, first.id);
    expect(existsSync(join(imagesDir(r.id), 'pasted-1.png'))).toBe(true);
  });

  /** Same rule against the initial prompt's own attachments. */
  it('keeps an image still referenced by taskImages', () => {
    const r = seedQueued();
    const msg = manager.enqueueMessage(r.id, [image()])!;
    store.updateRun(r.id, { taskImages: [msg.images![0]!] });

    manager.removeQueuedMessage(r.id, msg.id);
    expect(existsSync(join(imagesDir(r.id), 'pasted-1.png'))).toBe(true);
  });

  it('edits the task and re-derives the heuristic title and refs', () => {
    const r = seedQueued('fix the thing');
    expect(manager.editTask(r.id, 'fix the login bug in issue #123')).toBe(true);
    const updated = store.getRun(r.id)!;
    expect(updated.task).toBe('fix the login bug in issue #123');
    expect(updated.title).not.toBe('t');
    expect(updated.issueNumber).toBe(123);
  });

  /** Hand-edited titles always win (#389). */
  it('leaves a user-owned title alone when the task is edited', () => {
    const r = seedQueued('fix the thing');
    store.updateRun(r.id, { titleSummary: 'My own title', titleOrigin: 'user' });
    manager.editTask(r.id, 'completely different task now');
    expect(store.getRun(r.id)?.titleSummary).toBe('My own title');
    expect(store.getRun(r.id)?.title).toBe('t');
  });

  it('defers a message only while the run is starting up', () => {
    const r = seedQueued();
    const starting = runInternals(manager).line.starting;

    // Not starting yet → the ladder falls through to 409.
    expect(manager.deferMessage(r.id, text('nope'))).toBe(false);

    starting.add(r.id);
    expect(manager.deferMessage(r.id, text('buffer me'))).toBe(true);
    expect(
      runInternals(manager).queuedInput.deferredMessages.get(
        r.id,
      ),
    ).toHaveLength(1);
  });

  /**
   * The sub-window that `starting` alone misses: `execute()` drops the run from
   * `starting` as soon as it builds the ActiveRun, seconds before the backend is
   * spawned. A message arriving there must still buffer, not 409.
   */
  it('still defers after `starting` is cleared but before the session opens', () => {
    const r = seedQueued();
    (manager as unknown as { active: Map<string, unknown> }).active.set(r.id, {
      cancelled: false,
      sessionEverOpened: undefined,
    });
    expect(manager.deferMessage(r.id, text('mid-spawn'))).toBe(true);
  });

  /**
   * Review fix: `flushDeferred` used to drop its buffer before sending, so a message the
   * session refused was silently lost — precisely the failure `deferMessage` exists to
   * prevent. Anything unsent must stay buffered for the next session that opens.
   */
  it('re-buffers a deferred message the session refuses, instead of dropping it', () => {
    const r = seedQueued();
    const starting = runInternals(manager).line.starting;
    const buffer = runInternals(manager).queuedInput.deferredMessages;

    starting.add(r.id);
    manager.deferMessage(r.id, text('buffer me'));
    expect(buffer.get(r.id)).toHaveLength(1);

    // Flush with no open session — `sendMessage` refuses.
    ;runInternals(manager).queuedInput.flushDeferred(r.id);
    expect(buffer.get(r.id)).toHaveLength(1);

    // Now a session that accepts it: the buffer drains.
    const delivered: ContentBlock[][] = [];
    (manager as unknown as { sendMessage(id: string, c: ContentBlock[]): boolean }).sendMessage = (
      _id,
      content,
    ) => {
      delivered.push(content);
      return true;
    };
    ;runInternals(manager).queuedInput.flushDeferred(r.id);
    expect(delivered).toHaveLength(1);
    expect(buffer.has(r.id)).toBe(false);
  });

  it('stops deferring once a session has opened (a closed session is a real 409)', () => {
    const r = seedQueued();
    (manager as unknown as { active: Map<string, unknown> }).active.set(r.id, {
      cancelled: false,
      sessionEverOpened: true,
    });
    expect(manager.deferMessage(r.id, text('too late'))).toBe(false);
  });
});
