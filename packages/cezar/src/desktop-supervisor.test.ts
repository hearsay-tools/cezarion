import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { supervisorGone, watchSupervisor } from './desktop-supervisor.ts';
describe('desktop supervisor liveness', () => {
  const alive = (() => true) as typeof process.kill;
  it('detects reparenting even if a PID has been reused', () => expect(supervisorGone(22, 22, 1, alive)).toBe(true));
  it('does not kill a service already adopted at startup', () => expect(supervisorGone(22, 1, 1, alive)).toBe(false));
  it('requires ESRCH, not EPERM', () => {
    for (const code of ['ESRCH', 'EPERM']) {
      const probe = (() => { throw Object.assign(new Error(), { code }); }) as typeof process.kill;
      expect(supervisorGone(22, 22, 22, probe)).toBe(code === 'ESRCH');
    }
  });
});

// The shell closes the cockpit's stdin to ask for a graceful stop (quit, version switch).
describe('desktop stop request on stdin', () => {
  const desktop = { CEZ_DESKTOP: '1', CEZ_SUPERVISOR_STDIN: '1' };

  it('shuts down once when the shell closes stdin', () => {
    const stdin = new PassThrough();
    const shutdown = vi.fn();
    watchSupervisor(shutdown, desktop, stdin);
    stdin.end();
    stdin.emit('close');
    // `end` is emitted on a later tick once the stream drains.
    return vi.waitFor(() => expect(shutdown).toHaveBeenCalledOnce(), { timeout: 10_000 });
  });

  // An older shell passes /dev/null: an immediate EOF there is not a stop request.
  it('ignores stdin unless the shell opted in', () => {
    const stdin = new PassThrough();
    const shutdown = vi.fn();
    watchSupervisor(shutdown, { CEZ_DESKTOP: '1' }, stdin);
    stdin.emit('end');
    stdin.emit('close');
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('ignores stdin outside the desktop shell', () => {
    const stdin = new PassThrough();
    const shutdown = vi.fn();
    watchSupervisor(shutdown, { CEZ_SUPERVISOR_STDIN: '1' }, stdin);
    stdin.emit('end');
    expect(shutdown).not.toHaveBeenCalled();
  });

  it('stops listening once cancelled', () => {
    const stdin = new PassThrough();
    const shutdown = vi.fn();
    watchSupervisor(shutdown, desktop, stdin)();
    stdin.emit('end');
    expect(shutdown).not.toHaveBeenCalled();
  });
});

// D11: the shell's legacy pins must survive ambient preferred aliases.
it.each([
  {CEZ_DESKTOP: '1', CEZ_SUPERVISOR_STDIN: '1', HSQ_DESKTOP: '', HSQ_SUPERVISOR_STDIN: ''},
  {CEZ_DESKTOP: '1', CEZ_SUPERVISOR_STDIN: '1', HSQ_DESKTOP: '0', HSQ_SUPERVISOR_STDIN: '0'},
  {CEZ_DESKTOP: '1', CEZ_SUPERVISOR_STDIN: '1', HSQ_DESKTOP: '1', HSQ_SUPERVISOR_STDIN: '1'},
  {HSQ_DESKTOP: '1', HSQ_SUPERVISOR_STDIN: '1'},
])('follows the shell stdin pins despite inherited aliases (%j)', env => {
  const shutdown = vi.fn(); const stdin = new PassThrough();
  const cancel = watchSupervisor(shutdown, env, stdin);
  try {
    stdin.emit('end'); stdin.emit('close');
    expect(shutdown).toHaveBeenCalledOnce();
  } finally { cancel(); }
});

it.each(['', '999', '42'])('watches the shell PID despite inherited HSQ_SUPERVISOR_PID=%s', preferred => {
  vi.useFakeTimers();
  const probe = vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error(), {code: 'ESRCH'}); });
  const shutdown = vi.fn();
  const cancel = watchSupervisor(shutdown, {CEZ_DESKTOP: '1', CEZ_SUPERVISOR_PID: '42', HSQ_SUPERVISOR_PID: preferred});
  try {
    vi.advanceTimersByTime(2000);
    expect(probe).toHaveBeenCalledWith(42, 0);
    expect(shutdown).toHaveBeenCalledOnce();
  } finally { cancel(); probe.mockRestore(); vi.useRealTimers(); }
});

it('honors a legacy shell opt-out despite preferred opt-ins', () => {
  const stdin = new PassThrough(); const shutdown = vi.fn();
  const cancel = watchSupervisor(shutdown, {CEZ_DESKTOP: '', HSQ_DESKTOP: '1', HSQ_SUPERVISOR_STDIN: '1'}, stdin);
  try { stdin.emit('end'); expect(shutdown).not.toHaveBeenCalled(); }
  finally { cancel(); }
});
