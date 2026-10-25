import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { WriteBoundary } from '../worktree-manifest.ts';
import { readManifest, uncoveredPaths } from '../worktree-manifest.testkit.ts';
import { isPreserved, seedAgentConfigLocalLayer } from './seed.ts';

let repo: string;
const env = process.env;

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

beforeEach(() => {
  repo = mkdtempSync(join(tmpdir(), 'cez-seed-'));
  git(repo, 'init', '-q');
  git(repo, 'config', 'user.email', 't@t.t');
  git(repo, 'config', 'user.name', 't');
  writeFileSync(join(repo, '.gitignore'), '.claude/settings.local.json\nCLAUDE.local.md\n');
  writeFileSync(join(repo, 'README.md'), '# x');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'init');
});
afterEach(() => rmSync(repo, { recursive: true, force: true }));

/** A linked worktree off HEAD, like a real run. */
function makeWorktree(): string {
  const wt = `${repo}-wt`;
  git(repo, 'worktree', 'add', '-q', '--detach', wt, 'HEAD');
  return wt;
}

describe('seedAgentConfigLocalLayer', () => {
  it('copies a gitignored personal file into the worktree and excludes it', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{"env":{"X":"1"}}');
    const wt = makeWorktree();
    try {
      const seeded = await seedAgentConfigLocalLayer(repo, wt, env);
      expect(seeded).toContain('.claude/settings.local.json');
      expect(readFileSync(join(wt, '.claude', 'settings.local.json'), 'utf8')).toBe('{"env":{"X":"1"}}');
      // info/exclude is on the common dir (shared) — the seeded file is ignored in the worktree
      expect(
        execFileSync('git', ['check-ignore', '.claude/settings.local.json'], { cwd: wt, encoding: 'utf8' }).trim(),
      ).toBe('.claude/settings.local.json');
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  it('leaves a path in the preserve set alone and still seeds the others', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{"main":true}');
    writeFileSync(join(repo, 'CLAUDE.local.md'), 'main checkout bytes');
    const wt = makeWorktree();
    try {
      writeFileSync(join(wt, 'CLAUDE.local.md'), 'explicit parent attachment');
      const seeded = await seedAgentConfigLocalLayer(repo, wt, env, new Set(['CLAUDE.local.md']));
      expect(seeded).toEqual(['.claude/settings.local.json']);
      expect(readFileSync(join(wt, 'CLAUDE.local.md'), 'utf8')).toBe('explicit parent attachment');
      expect(readFileSync(join(wt, '.claude', 'settings.local.json'), 'utf8')).toBe('{"main":true}');
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  it('matches a nested preserve path under Windows separators', () => {
    const rel = win32.relative('C:\\repo', 'C:\\repo\\.claude\\settings.local.json');
    expect(rel).toBe('.claude\\settings.local.json');
    expect(isPreserved(new Set(['.claude/settings.local.json']), rel, win32.sep)).toBe(true);
    expect(isPreserved(new Set(['CLAUDE.local.md']), rel, win32.sep)).toBe(false);
  });

  it('no-ops when the source file is absent', async () => {
    const wt = makeWorktree();
    try {
      expect(await seedAgentConfigLocalLayer(repo, wt, env)).toEqual([]);
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  it('no-ops when the worktree cwd equals the repo root', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{}');
    expect(await seedAgentConfigLocalLayer(repo, repo, env)).toEqual([]);
  });

  it('never seeds a file the user genuinely tracked (against advice)', async () => {
    // Track settings.local.json despite the .gitignore intent (force-add).
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{"tracked":true}');
    git(repo, 'add', '-f', '.claude/settings.local.json');
    git(repo, 'commit', '-qm', 'track local');
    const wt = makeWorktree();
    try {
      const seeded = await seedAgentConfigLocalLayer(repo, wt, env);
      expect(seeded).toEqual([]); // check-ignore reports it as NOT ignored
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  it('is idempotent — a second run does not duplicate the exclude line', async () => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(join(repo, '.claude', 'settings.local.json'), '{}');
    const wt = makeWorktree();
    try {
      await seedAgentConfigLocalLayer(repo, wt, env);
      await seedAgentConfigLocalLayer(repo, wt, env);
      const exclude = readFileSync(join(repo, '.git', 'info', 'exclude'), 'utf8');
      const hits = exclude.split('\n').filter((l) => l.trim() === '.claude/settings.local.json').length;
      expect(hits).toBe(1);
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  // hearsay-tools/cezarion#1814: the seed writes only where nothing is, or cezar's unchanged copy.
  const settings = (root: string) => join(root, '.claude', 'settings.local.json');
  const seedSettings = (text: string) => {
    mkdirSync(join(repo, '.claude'), { recursive: true });
    writeFileSync(settings(repo), text);
  };

  it('keeps a seeded file the agent changed, and refreshes an unchanged one', async () => {
    seedSettings('{"v":1}');
    writeFileSync(join(repo, 'CLAUDE.local.md'), 'memory v1');
    const wt = makeWorktree();
    try {
      await seedAgentConfigLocalLayer(repo, wt, env);
      writeFileSync(settings(wt), '{"agent":true}');
      seedSettings('{"v":2}');
      writeFileSync(join(repo, 'CLAUDE.local.md'), 'memory v2');
      const seeded = await seedAgentConfigLocalLayer(repo, wt, env);
      expect(readFileSync(settings(wt), 'utf8')).toBe('{"agent":true}');
      expect(readFileSync(join(wt, 'CLAUDE.local.md'), 'utf8')).toBe('memory v2');
      expect(seeded).toEqual(['CLAUDE.local.md']);
      await seedAgentConfigLocalLayer(repo, wt, env);
      expect(readFileSync(settings(wt), 'utf8')).toBe('{"agent":true}');
      expect(await uncoveredPaths(wt, ['.claude/settings.local.json'])).toEqual([]);
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  it('keeps a file already in the worktree that cezar has no record of', async () => {
    seedSettings('{"main":true}');
    const wt = makeWorktree();
    try {
      mkdirSync(join(wt, '.claude'), { recursive: true });
      writeFileSync(settings(wt), '{"before":true}');
      expect(await seedAgentConfigLocalLayer(repo, wt, env)).toEqual([]);
      expect(readFileSync(settings(wt), 'utf8')).toBe('{"before":true}');
      expect(await readManifest(wt)).toBeNull();
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });

  it('writes nothing through an agent dir that leads out of the worktree', async () => {
    seedSettings('{"main":true}');
    const wt = makeWorktree();
    const outside = mkdtempSync(join(tmpdir(), 'cez-seed-outside-'));
    try {
      symlinkSync(outside, join(wt, '.claude'));
      expect(await seedAgentConfigLocalLayer(repo, wt, env)).toEqual([]);
      expect(existsSync(join(outside, 'settings.local.json'))).toBe(false);
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
      rmSync(outside, { recursive: true, force: true });
    }
  });

  /** Ends the seed at `boundary` of the write to the settings file, as a crash would. */
  const crashAt = (boundary: WriteBoundary, inspect: () => Promise<void>) => ({
    faults: async (at: WriteBoundary, path: string) => {
      if (path !== '.claude/settings.local.json') return;
      // A file replaces a file in one rename: there is no step between clearing and placing.
      expect(at).not.toBe('cleared');
      if (at !== boundary) return;
      await inspect();
      throw new Error(`crash at ${boundary}`);
    },
  });

  it.each([
    ['pending', '{"v":1}'],
    ['placed', '{"v":2}'],
  ] as const)('a refresh that crashes at %s is finished by the next seed', async (boundary, onDisk) => {
    seedSettings('{"v":1}');
    const wt = makeWorktree();
    try {
      await seedAgentConfigLocalLayer(repo, wt, env);
      seedSettings('{"v":2}');
      let checked = false;
      await seedAgentConfigLocalLayer(repo, wt, env, new Set(), crashAt(boundary, async () => {
        // What the crash leaves committed: a pending entry naming both copies, and one of them on disk.
        const entry = (await readManifest(wt))?.entries.find((candidate) => candidate.path === '.claude/settings.local.json');
        expect(entry).toMatchObject({ writer: 'seed', kind: 'pending' });
        expect(entry?.alternate).toBeDefined();
        expect(readFileSync(settings(wt), 'utf8')).toBe(onDisk);
        checked = true;
      }));
      expect(checked).toBe(true);
      expect(await seedAgentConfigLocalLayer(repo, wt, env)).toEqual(['.claude/settings.local.json']);
      expect(readFileSync(settings(wt), 'utf8')).toBe('{"v":2}');
      const entry = (await readManifest(wt))?.entries.find((candidate) => candidate.path === '.claude/settings.local.json');
      expect(entry).toMatchObject({ writer: 'seed', kind: 'file', source: expect.any(String) });
      expect(entry?.alternate).toBeUndefined();
      expect(await uncoveredPaths(wt)).toEqual([]);
    } finally {
      git(repo, 'worktree', 'remove', '--force', wt);
    }
  });
});
