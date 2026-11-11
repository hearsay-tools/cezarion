import { projectPaths } from '../project-paths.ts';
import { productIdentity } from './identity.ts';
import { productName } from './display.ts';
import { REBRAND_SWITCH } from './switch.ts';
import { expect, it, vi } from 'vitest';
import * as homes from './resolve.ts';

it('prints global CLI help without preparing a Home', async () => {
  const argv = process.argv;
  const resolve = vi.spyOn(homes, 'resolveHome');
  let printed!: () => void;
  const help = new Promise<void>(done => { printed = done; });
  const log = vi.spyOn(console, 'log').mockImplementation(message => {
    if (String(message).startsWith(`${productName('cezar')} —`)) printed();
  });
  process.argv = [process.execPath, 'cez', '--help'];
  try {
    await import('../index.ts');
    await help;
    expect(log).toHaveBeenCalledWith(expect.stringContaining('Usage:'));
    // With the switch on, help resolves (never prepares) Home to name its versions directory.
    expect(resolve).toHaveBeenCalledTimes(REBRAND_SWITCH ? 1 : 0);
  } finally {
    process.argv = argv;
    vi.restoreAllMocks();
  }
});

it('keeps init command generation inside the CLI home boundary', async () => {
  const { mkdtempSync, rmSync, readFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = mkdtempSync(join(tmpdir(), 'cli-init-'));
  const expectedWriteRoot = projectPaths(root).write;
  const argv = process.argv;
  let completed!: () => void;
  const done = new Promise<void>(resolve => { completed = resolve; });
  const log = vi.spyOn(console, 'log').mockImplementation(message => {
    if (String(message).startsWith('\nDone.')) completed();
  });
  process.argv = [process.execPath, 'cez', 'init', '--repo', root];
  try {
    vi.resetModules();
    await import('../index.ts');
    await done;
    expect(log).toHaveBeenCalledWith(`\nDone. Start the cockpit with: ${productIdentity().npx}`);
    expect(readFileSync(join(expectedWriteRoot, 'workflows/fix-and-verify.yaml'), 'utf8')).toContain('name: fix-and-verify');
  } finally {
    process.argv = argv;
    vi.restoreAllMocks();
    rmSync(root, { recursive: true, force: true });
  }
});

it('keeps the missing-task usage on stderr', async () => {
  const argv = process.argv;
  const exitCode = process.exitCode;
  let completed!: () => void;
  const done = new Promise<void>(resolve => { completed = resolve; });
  const error = vi.spyOn(console, 'error').mockImplementation(message => {
    if (String(message).startsWith('usage: cez run')) completed();
  });
  process.argv = [process.execPath, 'cez', 'run'];
  try {
    vi.resetModules();
    await import('../index.ts');
    await done;
    expect(error).toHaveBeenCalledWith('usage: cez run "<task>" [--workflow name] [--model model] [--no-workers] [--no-messaging]');
    expect(process.exitCode).toBe(1);
  } finally {
    process.argv = argv;
    process.exitCode = exitCode;
    vi.restoreAllMocks();
  }
});
