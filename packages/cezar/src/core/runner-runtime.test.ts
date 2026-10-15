import { spawn } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  afterExitDrain, boundOutputDrainAfterExit, CRASH_EXIT_DRAIN_MS, EXIT_DRAIN_CAP_MS, EXIT_DRAIN_MS, exitDrainBudget,
} from './runner-runtime.ts';

// hearsay-tools/cezarion#887: the post-exit drain must survive a host stall.
describe('afterExitDrain', () => {
  afterEach(() => { vi.useRealTimers(); });

  it('does not spend its budget on a stall, and the wall-clock cap still bounds it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date'] });
    const expired = vi.fn();
    afterExitDrain(expired, EXIT_DRAIN_MS);
    vi.setSystemTime(Date.now() + 1_000); // the host stalls before the first tick
    await vi.advanceTimersByTimeAsync(EXIT_DRAIN_MS - 100);
    expect(expired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100);
    expect(expired).toHaveBeenCalledOnce();

    const capped = vi.fn();
    afterExitDrain(capped, CRASH_EXIT_DRAIN_MS);
    vi.setSystemTime(Date.now() + EXIT_DRAIN_CAP_MS);
    await vi.advanceTimersByTimeAsync(50);
    expect(capped).toHaveBeenCalledOnce();
  });

  it('cancels', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setImmediate', 'clearImmediate', 'Date'] });
    const expired = vi.fn();
    afterExitDrain(expired, EXIT_DRAIN_MS)();
    await vi.advanceTimersByTimeAsync(EXIT_DRAIN_CAP_MS);
    expect(expired).not.toHaveBeenCalled();
  });

  it('gives a crash the longer budget and signal teardown the default', () => {
    expect(exitDrainBudget(1)).toBe(CRASH_EXIT_DRAIN_MS);
    expect(exitDrainBudget(0)).toBe(EXIT_DRAIN_MS);
    expect(exitDrainBudget(143)).toBe(EXIT_DRAIN_MS);
    expect(exitDrainBudget(null)).toBe(EXIT_DRAIN_MS);
  });
});

describe('boundOutputDrainAfterExit', () => {
  it('reads a descendant diagnostic written while the event loop was blocked, then bounds held pipes', async () => {
    // The leader exits once a pipe-inheriting descendant is ready; the descendant
    // writes on the leader's exit and then holds both pipes for 5s.
    const leader = `
      const c = require('node:child_process').spawn(process.execPath, ['-e', \`
        process.stderr;
        process.on('disconnect', () => {
          process.stderr.write('late crash diagnostic\\\\n');
          setTimeout(() => {}, 5000);
        });
        process.send('ready');
      \`], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
      c.once('message', () => process.exit(1));
    `;
    const child = spawn(process.execPath, ['-e', leader], { detached: true });
    try {
      boundOutputDrainAfterExit(child);
      let stderr = '';
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk: string) => { stderr += chunk; });
      child.stdout.resume();
      let exitedAt = 0;
      child.once('exit', () => {
        exitedAt = Date.now();
        // Block past a plain 250ms timer: an overdue timer used to close the
        // pipes before the poll phase read the diagnostic already in them.
        const until = exitedAt + EXIT_DRAIN_MS + 300;
        while (Date.now() < until) { /* busy */ }
      });
      await new Promise(resolve => child.once('close', resolve));
      expect(stderr).toContain('late crash diagnostic');
      expect(Date.now() - exitedAt).toBeLessThan(EXIT_DRAIN_CAP_MS + 1_000);
    } finally {
      try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ }
    }
  });
});
