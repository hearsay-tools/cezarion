import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { stall } from '../../scripts/mock-lifecycle.mjs';

// The no-progress stall runs inside native mock processes; this drives it in-process with the
// process hooks it touches replaced, so a test can read its files and its SIGTERM handler.
describe('mock no-progress stall', () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), 'cez-mock-lifecycle-'));
    process.chdir(dir);
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    process.chdir(cwd);
    rmSync(dir, { recursive: true, force: true });
  });

  const exitSpy = () => vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

  it('leaves other prompts alone', () => {
    expect(stall('mock:hold')).toBe(false);
    expect(existsSync('watchdog.pid')).toBe(false);
  });

  it('ignore-term installs a no-op SIGTERM handler before readiness, and the handler writes its receipt', () => {
    const handlers: Array<{ handler: () => void; readyAtInstall: boolean }> = [];
    const on = process.on.bind(process);
    const removeAll = vi.spyOn(process, 'removeAllListeners').mockReturnValue(process);
    vi.spyOn(process, 'on').mockImplementation(((event: string | symbol, handler: () => void) => {
      if (event !== 'SIGTERM') return on(event, handler);
      handlers.push({ handler, readyAtInstall: existsSync('watchdog.pid') });
      return process;
    }) as typeof process.on);
    const exit = exitSpy();

    expect(stall('mock:no-progress-ignore-term')).toBe(true);
    expect(removeAll).toHaveBeenCalledWith('SIGTERM');
    expect(handlers).toEqual([{ handler: expect.any(Function), readyAtInstall: false }]);
    expect(readFileSync('watchdog.pid', 'utf8')).toBe(String(process.pid));
    expect(existsSync('sigterm-ignored.pid')).toBe(false);

    handlers[0]!.handler();
    expect(readFileSync('sigterm-ignored.pid', 'utf8')).toBe(String(process.pid));
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(12_000);
    expect(exit).toHaveBeenCalledWith(0);
  });

  it('input-closed closes input, publishes its pid and exits after 300 ms', () => {
    const exit = exitSpy();
    const closeInput = vi.fn();
    expect(stall('mock:no-progress input-closed', { closeInput })).toBe(true);
    expect(closeInput).toHaveBeenCalledTimes(1);
    expect(readFileSync('input-closed.pid', 'utf8')).toBe(String(process.pid));
    vi.advanceTimersByTime(299);
    expect(exit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(exit).toHaveBeenCalledWith(0);
  });
});
