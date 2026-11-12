import { productName } from '../home/display.ts';
import { logPrefix } from '../home/display.ts';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CiToolController, ToolsUnavailableError } from './controller.ts';
import { acquireCiResources } from './resources.ts';

// hearsay-tools/cezarion#2397: every agent session needs the lifecycle tools, so a failed start is
// never kept. The next launch after a repair starts the controller again.
describe('the shared tool controller', () => {
  afterEach(() => vi.restoreAllMocks());

  it('forgets a failed start, so the next launch starts the controller again', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const failure = new ToolsUnavailableError("ENOSPC: no space left on device, mkdtemp '/tmp/cez-ci-XXXXXX'", '/tmp');
    const start = vi.spyOn(CiToolController, 'start').mockRejectedValueOnce(failure);
    const resources = acquireCiResources({});
    try {
      await expect(resources.controller()).rejects.toBe(failure);
      expect(warn).toHaveBeenCalledWith(`${logPrefix()} ${failure.message}`);
      const controller = await resources.controller();
      expect(controller).toBeInstanceOf(CiToolController);
      expect(await resources.controller()).toBe(controller);
      expect(start).toHaveBeenCalledTimes(2);
    } finally {
      resources.release();
    }
  });

  it('shares one start between launches that ask while it is pending', async () => {
    const start = vi.spyOn(CiToolController, 'start');
    const resources = acquireCiResources({});
    try {
      const [first, second] = await Promise.all([resources.controller(), resources.controller()]);
      expect(first).toBe(second);
      expect(start).toHaveBeenCalledTimes(1);
    } finally {
      resources.release();
    }
  });

  it.skipIf(process.platform === 'win32')('a failed start keeps the OS error', async () => {
    vi.stubEnv('TMPDIR', '/nonexistent-cez-2397');
    try {
      await expect(CiToolController.start()).rejects.toThrow(
        new RegExp(String.raw`^${productName('Cezar')} tools could not start: ENOENT: no such file or directory, mkdtemp '\/nonexistent-cez-2397\/cez-ci-\w+'\. .*Free space in \/nonexistent-cez-2397 `));
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it('names the cause and the fix', () => {
    expect(new ToolsUnavailableError("EACCES: permission denied, mkdtemp '/tmp/cez-ci-XXXXXX'", '/tmp').message).toBe(
      `${productName('Cezar')} tools could not start: EACCES: permission denied, mkdtemp '/tmp/cez-ci-XXXXXX'. Every agent session needs a private socket directory in /tmp. Free space in /tmp or fix its permissions, then Continue the task.`);
    expect(new ToolsUnavailableError('the server stopped', undefined).message).toBe(
      `${productName('Cezar')} tools could not start: the server stopped. Every agent session needs a private named pipe. Fix the cause, then Continue the task.`);
  });
});

// spec 2026-11-05-live-activity-view: the activity view reads the progress the workspace's one
// supervisor publishes, whichever manager the view reaches it through.
describe('the shared check progress', () => {
  it('is one registry per workspace, shared by every manager of it, and a fresh one after the last release', () => {
    const workspace = {};
    const first = acquireCiResources(workspace);
    const second = acquireCiResources(workspace);
    const other = acquireCiResources({});
    try {
      expect(second.progress).toBe(first.progress);
      expect(other.progress).not.toBe(first.progress);
    } finally {
      for (const resources of [first, second, other]) resources.release();
    }
    const again = acquireCiResources(workspace);
    expect(again.progress).not.toBe(first.progress);
    again.release();
  });
});
