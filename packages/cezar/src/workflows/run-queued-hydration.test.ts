import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
import './run-fixture.testkit.ts';
describe('QueuedInput.hydrateQueuedInput (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;

  const hydrate = (id: string, task: string) =>
    runInternals(manager).queuedInput.hydrateQueuedInput(id, { task });

  const stack = (id: string, ...messages: Array<{ text: string; images?: string[] }>) =>
    store.updateRun(id, {
      queuedMessages: messages.map((m, i) => ({
        id: `m${i}`,
        text: m.text,
        ...(m.images ? { images: m.images } : {}),
        createdAt: `2026-07-21T10:0${i}:00.000Z`,
      })),
    });

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-hydrate-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('folds the task and every stacked message, in order, blank-line joined', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'build the thing', steps: [] });
    stack(r.id, { text: 'also update the changelog' }, { text: 'and bump the version' });

    expect(hydrate(r.id, r.task).task).toBe(
      'build the thing\n\nalso update the changelog\n\nand bump the version',
    );
  });

  it('leaves the input untouched when nothing is stacked', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'build the thing', steps: [] });
    expect(hydrate(r.id, r.task).task).toBe('build the thing');
  });

  /**
   * The compounding guard. Hydration composes from `run.task` + the stack and
   * never writes the folded string back, so a restart cannot re-append. Without
   * this rule every recovery would grow the prompt without bound.
   */
  it('never writes the folded prompt back to the record, and is idempotent', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'build the thing', steps: [] });
    stack(r.id, { text: 'also update the changelog' });

    const once = hydrate(r.id, r.task).task;
    const twice = hydrate(r.id, r.task).task;
    const thrice = hydrate(r.id, hydrate(r.id, r.task).task).task;

    expect(twice).toBe(once);
    // Even feeding an already-folded string back in yields the same result —
    // the helper reads `run.task`, not whatever `input.task` happens to hold.
    expect(thrice).toBe(once);
    // …and the record itself is byte-identical to what the user typed.
    expect(store.getRun(r.id)?.task).toBe('build the thing');
    expect(store.getRun(r.id)?.queuedMessages).toHaveLength(1);
  });

  it('re-encodes stacked attachments from disk into stackedImages', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'look at this', steps: [] });
    const dir = join(repoRoot, '.ai/cezar', 'runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pasted-1.png'), 'the-bytes');
    stack(r.id, { text: 'see the mock', images: [`/api/v1/runs/${r.id}/images/pasted-1.png`] });

    const images = hydrate(r.id, r.task).stackedImages;
    expect(images).toHaveLength(1);
    expect(images?.[0]).toMatchObject({
      type: 'image',
      source: { media_type: 'image/png', data: Buffer.from('the-bytes').toString('base64') },
    });
  });

  it.each(['pasted-1.png', 'pasted-1.pdf'])('excludes outside symlinks from restart hydration: %s', (name) => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'keep text', steps: [] });
    const dir = join(repoRoot, '.ai/cezar/runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    const outside = join(repoRoot, 'outside');
    writeFileSync(outside, 'outside-secret');
    symlinkSync(outside, join(dir, name));
    store.updateRun(r.id, { taskImages: [`/api/v1/runs/${r.id}/images/${name}`] });
    const hydrated = hydrate(r.id, r.task);
    expect(hydrated.images).toBeUndefined();
    expect(hydrated.task).toBe('keep text');
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes(name))).toBe(true);
  });

  it('notes an unreadable document instead of advertising its path on recovery', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'keep text', steps: [] });
    const dir = join(repoRoot, '.ai/cezar/runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    const path = join(dir, 'pasted-1.pdf');
    writeFileSync(path, 'private document');
    chmodSync(path, 0);
    try {
      store.updateRun(r.id, { taskImages: [`/api/v1/runs/${r.id}/images/pasted-1.pdf`] });
      expect(hydrate(r.id, r.task).task).toBe('keep text');
      expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes('pasted-1.pdf'))).toBe(true);
    } finally { chmodSync(path, 0o600); }
  });

  it('re-encodes initial task images from disk after a queued-run restart (#612)', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'look at this', steps: [] });
    const dir = join(repoRoot, '.ai/cezar', 'runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pasted-1.png'), 'the-task-bytes');
    store.updateRun(r.id, { taskImages: [`/api/v1/runs/${r.id}/images/pasted-1.png`] });

    expect(hydrate(r.id, r.task).images).toEqual([
      {
        type: 'image',
        source: {
          type: 'base64',
          media_type: 'image/png',
          data: Buffer.from('the-task-bytes').toString('base64'),
        },
      },
    ]);
  });

  /**
   * #950 — the re-read branches on the NAME, not on the list. A `.pdf` sitting in the same
   * `images` list as a screenshot must come back as a path only: re-encoding it into a base64
   * image block would compose a message no backend can accept, and would put the whole document
   * into the prompt on the one path (restart) where nobody is watching.
   */
  it('never re-encodes a non-image attachment into an image block on restart', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'read the brief', steps: [] });
    const dir = join(repoRoot, '.ai/cezar', 'runs', `${r.id}-images`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pasted-1.png'), 'the-task-bytes');
    writeFileSync(join(dir, 'pasted-2.pdf'), '%PDF-1.4 the-document-bytes');
    store.updateRun(r.id, {
      taskImages: [
        `/api/v1/runs/${r.id}/images/pasted-1.png`,
        `/api/v1/runs/${r.id}/images/pasted-2.pdf`,
      ],
    });

    const images = hydrate(r.id, r.task).images;
    expect(images).toHaveLength(1);
    expect(images?.[0]).toMatchObject({ type: 'image', source: { media_type: 'image/png' } });
    expect(JSON.stringify(images)).not.toContain(Buffer.from('%PDF-1.4 the-document-bytes').toString('base64'));
  });

  /** Degrade, never fail the boot (AGENTS.md). */
  it('skips an unreadable attachment, notes it, and still starts', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'look at this', steps: [] });
    stack(r.id, { text: 'see the mock', images: [`/api/v1/runs/${r.id}/images/gone-1.png`] });

    const hydrated = hydrate(r.id, r.task);
    expect(hydrated.task).toBe('look at this\n\nsee the mock');
    expect(hydrated.stackedImages).toBeUndefined();
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes('gone-1.png'))).toBe(true);
  });

  /** A file has no bytes to fail on — it is only ever `stat`ed — so it needs its own case: a
   *  deleted `.md` must be dropped and noted, not handed to the agent as a path to nothing. */
  it('notes a non-image attachment whose file is gone instead of naming a dead path', () => {
    const r = store.createRun({ title: 't', workflow: 'w', task: 'read the brief', steps: [] });
    stack(r.id, { text: 'see the brief', images: [`/api/v1/runs/${r.id}/images/pasted-7.md`] });

    const hydrated = hydrate(r.id, r.task);
    expect(hydrated.stackedImages).toBeUndefined();
    expect(store.readEvents(r.id).some((e) => e.type === 'note' && String(e.message).includes('pasted-7.md'))).toBe(true);
  });
});
