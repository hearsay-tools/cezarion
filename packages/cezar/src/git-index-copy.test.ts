import { mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyGitIndex } from './git-index-copy.ts';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe('copyGitIndex', () => {
  // hearsay-tools/cezarion#1088: the copy must look exactly as old as the index it copies.
  it('copies the bytes and keeps the source mtime', async () => {
    const root = mkdtempSync(join(tmpdir(), 'cez-index-copy-'));
    roots.push(root);
    const source = join(root, 'index');
    writeFileSync(source, 'DIRC');
    const past = new Date('2020-01-02T03:04:05.678Z');
    utimesSync(source, past, past);
    await copyGitIndex(source, join(root, 'copy'));
    expect(statSync(join(root, 'copy')).mtimeMs).toBe(statSync(source).mtimeMs);
  });
});
