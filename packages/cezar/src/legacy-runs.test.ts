import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { removeHistory } from './runs/history-file.ts';
import { forgetLegacyRunIds, LEGACY_RUNS_FILE, legacyItemOwner, legacyRunIds, legacyRunItem, runDataDir } from './legacy-runs.ts';

/** Live tasks that keep their own items in `.ai/cezar/` after a project move (owner decision A). */

const LIVE = '20000000-0000-4000-8000-000000000002';
const OTHER = '30000000-0000-4000-8000-000000000003';

describe('the items of a task the project move left in .ai/cezar/', () => {
  let root: string;
  let moved: string;
  beforeEach(() => {
    root = mkdtempSync(join(realpathSync(tmpdir()), 'cez-legacy-runs-'));
    moved = join(root, '.ai', 'squawk');
    mkdirSync(moved, { recursive: true });
  });
  afterEach(() => {
    forgetLegacyRunIds(moved);
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  const list = (runs: string[]) => {
    writeFileSync(join(moved, LEGACY_RUNS_FILE), JSON.stringify({ version: 1, runs }));
    forgetLegacyRunIds(moved);
  };

  it('names the owner of a worktree, a scratch directory, a preview profile and every runs/<id> entry', () => {
    const ids = new Set([LIVE]);
    for (const parts of [['worktrees', LIVE], ['worktrees', LIVE, 'src', 'a.ts'], ['tmp', LIVE], ['preview', LIVE, 'agent-connected'],
      ['t', LIVE.slice(0, 8)], ['t', LIVE.slice(0, 8), 'exit'], ['runs', `${LIVE}.handoff.md`], ['runs', `${LIVE}.ndjson`],
      ['runs', `${LIVE}-artifacts`, 'x', 'content'], ['runs', `${LIVE}-worker-results`], ['runs', `${LIVE}-images`, 'pasted-1.png']]) {
      expect(legacyItemOwner(parts, ids), parts.join('/')).toBe(LIVE);
    }
    for (const parts of [['worktrees', OTHER], ['runs', `${OTHER}.handoff.md`], ['runs.db'], ['runs'], ['workflows', 'flow.yaml'],
      ['runs', `${LIVE}x`], ['t', LIVE.slice(0, 7)], ['worktrees', LIVE, '..', OTHER], ['config.json']]) {
      expect(legacyItemOwner(parts, ids), parts.join('/')).toBeUndefined();
    }
  });

  it('resolves a listed task\'s data directory to .ai/cezar/ and every other task\'s to the moved one', () => {
    expect(runDataDir(moved, LIVE)).toBe(moved);
    list([LIVE]);
    expect(runDataDir(moved, LIVE)).toBe(join(root, '.ai', 'cezar'));
    expect(runDataDir(moved, OTHER)).toBe(moved);
    // Never for a directory that is not a moved project directory: the legacy one, or a fixture's.
    expect(runDataDir(join(root, '.ai', 'cezar'), LIVE)).toBe(join(root, '.ai', 'cezar'));
    expect(runDataDir(join(root, 'data'), LIVE)).toBe(join(root, 'data'));
    expect(legacyRunItem(root, join(root, '.ai', 'cezar', 'worktrees', LIVE, 'file'))).toBe(true);
    expect(legacyRunItem(root, join(root, '.ai', 'cezar', 'runs.db'))).toBe(false);
    expect(legacyRunItem(root, join(root, '.ai', 'squawk', 'worktrees', LIVE))).toBe(false);
  });

  it('reads an unreadable list as empty, with one warning', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    writeFileSync(join(moved, LEGACY_RUNS_FILE), '{"version":1,"runs":["../escape"]}');
    forgetLegacyRunIds(moved);
    expect(legacyRunIds(moved).size).toBe(0);
    forgetLegacyRunIds(moved);
    expect(legacyRunIds(moved).size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('removes a listed task\'s history bytes from .ai/cezar/, and only its own', () => {
    list([LIVE]);
    const legacyRuns = join(root, '.ai', 'cezar', 'runs');
    mkdirSync(legacyRuns, { recursive: true });
    mkdirSync(join(moved, 'runs'), { recursive: true });
    const own = [`${LIVE}.ndjson`, `${LIVE}.ndjson.br`, `${LIVE}.ndjson.br.orphaned`, `${LIVE}.facts.json`].map(name => join(legacyRuns, name));
    const others = [join(legacyRuns, `${OTHER}.ndjson`), join(legacyRuns, `${LIVE}.handoff.md`), join(moved, 'runs', `${OTHER}.ndjson`)];
    for (const path of [...own, ...others]) writeFileSync(path, 'x');
    removeHistory(moved, LIVE);
    for (const path of own) expect(existsSync(path), path).toBe(false);
    for (const path of others) expect(existsSync(path), path).toBe(true);
  });
});
