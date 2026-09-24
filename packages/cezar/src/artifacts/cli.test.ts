import { afterEach, expect, it, vi } from 'vitest';
import { runArtifactCommand } from './cli.ts';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    expect(await runArtifactCommand(['publish', source], { CEZ_ARTIFACTS_DIR: dir, CEZ_TASK_ID: runId })).toBe(0);
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
