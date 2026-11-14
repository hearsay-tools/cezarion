import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'hsq-blocked-move-'));
  execFileSync('git', ['init', '-q', root]);
  mkdirSync(join(root, '.ai/cezar'), { recursive: true });
  writeFileSync(join(root, '.ai/cezar/config.json'), '{}');
  // Fresh modules per test: the legacy-project notice is printed once per process.
  vi.resetModules();
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  vi.resetModules();
});

function blockDestination(kind: string): string {
  const destination = join(root, '.ai/squawk');
  if (kind === 'symlink') {
    mkdirSync(join(root, '.ai/target'));
    symlinkSync('target', destination);
    execFileSync('git', ['add', '.ai/squawk'], { cwd: root });
    return `${destination} exists and is not a directory`;
  }
  mkdirSync(destination);
  writeFileSync(join(destination, 'config.json'), '{}');
  return `${join(root, '.ai/cezar/config.json')} would replace an existing path`;
}

describe.each(['symlink', 'conflict'])('blocked project migration (%s)', kind => {
  it('prints one reason notice even when no moves remain', async () => {
    const reason = blockDestination(kind);
    const { moveProjectWhenIdle } = await import('./auto.ts');
    const { noticeLegacyProject, projectPaths } = await import('../project-paths.ts');
    const lines: string[] = [];
    const warn = (line: string) => lines.push(line);
    const result = await moveProjectWhenIdle(root, { homes: [], log: warn });
    noticeLegacyProject(root, { warn });
    expect(result).toMatchObject({ status: 'blocked', reason: expect.stringContaining(reason) });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('[hsq] Project ');
    expect(lines[0]).toContain(reason);
    expect(projectPaths(root).write).toBe(join(root, '.ai/cezar'));
  });

  it('returns exit 1 and keeps the dry-run plan on stdout', async () => {
    const reason = blockDestination(kind);
    const { runMigrateProjectCommand } = await import('./cli.ts');
    const out: string[] = [], err: string[] = [];
    const code = await runMigrateProjectCommand(['--dry-run'], {
      homes: [], getRepoInfo: async () => null, cwd: () => root,
      log: line => out.push(line), error: line => err.push(line),
    });
    expect(code).toBe(1);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain(reason);
    expect(out.join('\n')).toContain('Moves: none');
    expect(out.join('\n')).toContain('Dry run: nothing was moved or rewritten.');
  });
});
