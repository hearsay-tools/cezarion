import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ensureDataGitignore } from './data-gitignore.ts';

describe('ensureDataGitignore', () => {
  let repo: string;
  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'cez-gitignore-'));
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it('ignores the voice decision log', () => {
    ensureDataGitignore(repo);
    const read = () => readFileSync(join(repo, '.ai/cezar/.gitignore'), 'utf8');
    const first = read();
    expect(first.split('\n')).toContain('voice/');
    ensureDataGitignore(repo);
    expect(read()).toBe(first);
    expect(read().split('\n').filter((line) => line === 'voice/')).toHaveLength(1);
  });
});
