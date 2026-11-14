import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { git, gitEnv } from './git-command.ts';

/** Git for Windows prints forward slashes even for native absolute paths. */
const slashes = (path: string) => path.replaceAll('\\', '/');

/** The one git() helper: it acts on `cwd` even when the process env points git at another
 *  repository (hearsay-tools/squawk#3207), and it reports an output over the buffer cap by name
 *  (hearsay-tools/squawk#1843). */
describe('git', () => {
  let root: string;
  let repo: string;
  let other: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'cez-git-command-')));
    repo = join(root, 'repo');
    other = join(root, 'other');
    for (const dir of [repo, other]) execFileSync('git', ['init', '-q', dir], { env: gitEnv() });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('acts on cwd when inherited location variables name another repository', async () => {
    vi.stubEnv('GIT_DIR', join(other, '.git'));
    vi.stubEnv('GIT_WORK_TREE', other);
    vi.stubEnv('GIT_INDEX_FILE', join(other, '.git', 'index'));
    const res = await git(repo, ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-path', 'index']);
    expect(res.ok).toBe(true);
    expect(res.stdout.trim().split('\n').map(slashes)).toEqual([repo, join(repo, '.git'), '.git/index'].map(slashes));
  });

  it("keeps a caller's own location variable", async () => {
    vi.stubEnv('GIT_INDEX_FILE', join(other, '.git', 'index'));
    const index = join(root, 'private-index');
    const res = await git(repo, ['rev-parse', '--git-path', 'index'], { env: { GIT_INDEX_FILE: index } });
    expect(slashes(res.stdout.trim())).toBe(slashes(index));
  });

  it('reports an output over the buffer cap as an overflow', async () => {
    const res = await git(repo, ['rev-parse', '--show-toplevel'], { maxBuffer: 4 });
    expect(res).toMatchObject({ ok: false, overflow: true });
  });

  it('reports an ordinary failure without an overflow', async () => {
    const res = await git(repo, ['rev-parse', '--verify', 'no-such-ref']);
    expect(res).toMatchObject({ ok: false, overflow: false });
  });
});
