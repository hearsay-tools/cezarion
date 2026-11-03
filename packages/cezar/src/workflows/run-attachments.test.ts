import './run-fixture.testkit.ts';
import { runInternals } from './run-internals.testkit.ts';
import { createFixtureManager, drainFixtureManagers } from './fixture-cleanup.testkit.ts';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { RunStore } from '../runs/store.ts';
import { RunManager } from './run.ts';
describe('AttachmentWriter.persistAttachment without a session (#472)', () => {
  let repoRoot: string;
  let store: RunStore;
  let manager: RunManager;
  const PNG = Buffer.from('fake-png-bytes').toString('base64');

  const persist = (id: string, prefix?: string) =>
    runInternals(manager).attachments.persistAttachment(id, 'image/png', PNG, prefix);
  const imagesDir = (id: string) => join(repoRoot, '.ai/cezar', 'runs', `${id}-images`);

  beforeEach(() => {
    repoRoot = mkdtempSync(join(tmpdir(), 'cez-persist-'));
    store = RunStore.open(join(repoRoot, '.ai/cezar'));
    manager = createFixtureManager(store, repoRoot);
  });

  afterEach(async () => {
    await drainFixtureManagers(repoRoot);
    rmSync(repoRoot, { recursive: true, force: true });
  });

  it('persists two attachments with no ActiveRun and gives them distinct names', () => {
    const first = persist('run-a', 'pasted');
    const second = persist('run-a', 'pasted');
    expect(first?.name).toBe('pasted-1.png');
    expect(second?.name).toBe('pasted-2.png');
    expect(first?.url).toBe('/api/v1/runs/run-a/images/pasted-1.png');
  });

  /** The count-based bug this replaces: one file on disk named `pasted-3.png` is a
   *  count of 1, so a counting seed would issue `pasted-2.png` — a number BELOW a
   *  live one. Seeding from the highest suffix yields 4. */
  it('seeds from the highest existing suffix, not the file count', () => {
    mkdirSync(imagesDir('run-b'), { recursive: true });
    writeFileSync(join(imagesDir('run-b'), 'pasted-3.png'), 'x');
    expect(persist('run-b', 'pasted')?.name).toBe('pasted-4.png');
  });

  /** `screenshot-*` and `pasted-*` share one numbering space. */
  it('shares one numbering space across screenshot- and pasted- prefixes', () => {
    mkdirSync(imagesDir('run-c'), { recursive: true });
    writeFileSync(join(imagesDir('run-c'), 'screenshot-7.png'), 'x');
    expect(persist('run-c', 'pasted')?.name).toBe('pasted-8.png');
  });

  /** A stale seed (in-memory map ahead of/behind disk) must never overwrite: the
   *  exclusive-create flag makes it retry onto the next free suffix. */
  it('retries past a pre-existing file rather than overwriting it', () => {
    mkdirSync(imagesDir('run-d'), { recursive: true });
    // Force a stale counter: the map says 0, but pasted-1 already exists.
    writeFileSync(join(imagesDir('run-d'), 'pasted-1.png'), 'original');
    runInternals(manager).attachments.queuedImageSeq.set('run-d', 0);

    const saved = persist('run-d', 'pasted');
    expect(saved?.name).toBe('pasted-2.png');
    expect(readFileSync(join(imagesDir('run-d'), 'pasted-1.png'), 'utf8')).toBe('original');
  });
});
