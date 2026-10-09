import { afterEach, describe, expect, it, vi } from 'vitest';
import { owningProjectId, runArtifactCommand } from './cli.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { artifactDirectory, readArtifact } from './store.ts';
afterEach(() => vi.restoreAllMocks());
it('dispatches artifact help before ordinary CLI parsing', async () => {
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', fileURLToPath(new URL('../index.ts', import.meta.url)), 'artifact', '--help']);
  expect(stdout).toContain('cez artifact publish');
  expect(stdout).not.toContain('start the cockpit');
}, 15000);
it('returns immutable metadata, a task-relative link and escaped Markdown', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cez-artifact-cli-'));
  const runId = randomUUID();
  const source = join(root, 'report [final] <v2>\\.md');
  const dir = artifactDirectory(root, runId);
  try {
    await writeFile(source, 'original');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runArtifactCommand(['publish', source], { CEZ_HOME: join(root, 'home'), CEZ_ARTIFACTS_DIR: dir, CEZ_TASK_ID: runId })).toBe(0);
    const result = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(result).toMatchObject({ runId, sourcePath: source, name: 'report [final] <v2>\\.md', size: 8 });
    expect(result.sha256).toBe('0682c5f2076f099c34cfdd15a9e063849ed437a49677e6fcc5b4198c76575be5');
    expect(result.link).toBe(`/tasks/${runId}/files?artifact=${result.id}`);
    expect(result.markdown).toContain('\\[final\\]');
    expect(result.markdown).toContain('\\<v2\\>');
    expect(result.markdown).toContain(`](${result.link})`);
    await rm(source);
    expect((await readArtifact(dir, runId, result.id))?.bytes.toString()).toBe('original');
  } finally { await rm(root, { recursive: true, force: true }); }
});
it('rejects publication without task context', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(await runArtifactCommand(['publish', '/tmp/report.md'], {})).toBe(1);
  expect(JSON.parse(String(error.mock.calls[0]?.[0])).error).toMatch(/context/i);
});
it('shows help successfully without context', async () => {
  const output = vi.spyOn(console, 'log').mockImplementation(() => {});
  expect(await runArtifactCommand(['--help'], {})).toBe(0);
  expect(output.mock.calls[0]?.[0]).toContain('cez artifact publish');
});

it.each(['boot', 'owner', 'aliased-owner'])('preserves the registered %s project in publication links, independent of cwd', async (owner) => {
  const root = await mkdtemp(join(tmpdir(), 'cez-artifact-owner-'));
  try {
    const home = join(root, 'home');
    const project = join(root, owner);
    await mkdir(home);
    await mkdir(join(project, '.ai/cezar'), { recursive: true });
    const alias = join(root, 'alias');
    if (owner === 'aliased-owner') await symlink(project, alias, 'dir');
    const registry = JSON.stringify({ projects: [
      { id: 'unrelated', root: process.cwd() },
      { id: owner, root: owner === 'aliased-owner' ? alias : project },
    ] });
    await writeFile(join(home, 'config.json'), registry);
    const runId = randomUUID();
    const source = join(root, 'report.md');
    await writeFile(source, 'owned snapshot');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await runArtifactCommand(['publish', source], {
      CEZ_HOME: home, CEZ_TASK_ID: runId,
      CEZ_ARTIFACTS_DIR: artifactDirectory(join(project, '.ai/cezar'), runId),
    })).toBe(0);
    const result = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(result.link).toBe(`/p/${owner}/tasks/${runId}/files?artifact=${result.id}`);
    expect(result.markdown).toBe(`[report\\.md](${result.link})`);
    expect(await readFile(join(home, 'config.json'), 'utf8')).toBe(registry);
    expect(await readdir(home)).toEqual(['config.json']);
  } finally { await rm(root, { recursive: true, force: true }); }
});
it.each(['missing', 'corrupt', 'unreadable', 'empty', 'unmatched'])('keeps publication working with a %s registry', async (state) => {
  const root = await mkdtemp(join(tmpdir(), 'cez-artifact-fallback-'));
  try {
    const home = join(root, 'home');
    await mkdir(home);
    const config = join(home, 'config.json');
    if (state === 'corrupt') await writeFile(config, '{');
    // A directory gives a deterministic read failure even when tests run as root.
    if (state === 'unreadable') await mkdir(config);
    if (state === 'empty') await writeFile(config, '{"projects":[]}');
    if (state === 'unmatched') await writeFile(config, JSON.stringify({ projects: [{ id: 'other', root: join(root, 'other') }] }));
    const before = await readdir(home);
    const runId = randomUUID();
    const source = join(root, 'report.md');
    await writeFile(source, 'fallback snapshot');
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(await runArtifactCommand(['publish', source], {
      CEZ_HOME: home, CEZ_TASK_ID: runId, CEZ_ARTIFACTS_DIR: artifactDirectory(root, runId),
    })).toBe(0);
    const result = JSON.parse(String(output.mock.calls[0]?.[0]));
    expect(result.link).toBe(`/tasks/${runId}/files?artifact=${result.id}`);
    expect(result.markdown).toContain(`](${result.link})`);
    expect(await readdir(home)).toEqual(before);
  } finally { await rm(root, { recursive: true, force: true }); }
});

// #925: the ownership match must be realpath-SYMMETRIC — canonicalizing both spellings before
// comparing — so an artifacts directory reached through an OS alias still names its owner. The
// registry side is pinned above (`aliased-owner`); this pins the env side, whose spelling the
// match site must never trust to arrive canonical.
describe('owningProjectId (#925)', () => {
  it('matches the owner when CEZ_ARTIFACTS_DIR is spelled through a symlink alias', async () => {
    const root = await mkdtemp(join(tmpdir(), 'cez-artifact-symmetric-'));
    try {
      const project = join(root, 'owner');
      const alias = join(root, 'alias');
      await mkdir(join(project, '.ai/cezar/runs'), { recursive: true });
      await symlink(project, alias, 'dir');
      const runId = randomUUID();
      const dir = artifactDirectory(join(project, '.ai/cezar'), runId);
      await mkdir(dir, { mode: 0o700 });
      // The aliased spelling survives `resolve` untouched — only a symmetric canonicalization
      // can see it names the same directory the registry knows.
      const aliased = join(alias, '.ai/cezar/runs', `${runId}-artifacts`);
      expect(aliased).not.toBe(dir);

      expect(owningProjectId(
        [{ id: 'owner', root: project }, { id: 'unrelated', root: process.cwd() }],
        aliased,
        runId,
      )).toBe('owner');
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('never names a project whose storage is a different directory', () => {
    const runId = randomUUID();
    expect(owningProjectId([{ id: 'other', root: process.cwd() }], join(process.cwd(), '.ai/cezar/runs', `${runId}-artifacts`), randomUUID())).toBeUndefined();
  });

  it('reads an absent directory as unowned rather than throwing', () => {
    expect(owningProjectId([{ id: 'other', root: process.cwd() }], join(process.cwd(), 'absent-runs', `${randomUUID()}-artifacts`), randomUUID())).toBeUndefined();
  });
});
