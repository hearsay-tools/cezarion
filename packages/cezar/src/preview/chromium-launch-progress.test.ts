import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { afterEach, expect, it, vi } from 'vitest';

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async original => ({ ...await original<typeof import('node:child_process')>(), spawn }));
import { launchChromium } from './chromium.ts';

let dir: string;
afterEach(() => { vi.useRealTimers(); vi.clearAllMocks(); if (dir) rmSync(dir, { recursive: true, force: true }); });
function launcher() {
  vi.useFakeTimers();
  dir = mkdtempSync(join(tmpdir(), 'cez-launch-progress-'));
  const children: Array<ReturnType<typeof child>> = [];
  spawn.mockImplementation(() => { const proc = child(); children.push(proc); return proc; });
  return children;
}
function child() {
  const proc = Object.assign(new EventEmitter(), {
    pid: 99999999,
    stderr: new PassThrough(),
    stdio: [null, null, null, new PassThrough(), new PassThrough()],
    kill: vi.fn(() => { proc.emit('exit', null, 'SIGKILL'); proc.emit('close', null, 'SIGKILL'); return true; }),
  });
  return proc;
}
function answer(proc: ReturnType<typeof child>) { proc.stdio[4]!.write('{"id":1,"result":{"product":"Fake"}}\u0000'); }

it('allows a silent cold launch beyond 30 seconds while process counters advance', async () => {
  const children = launcher();
  const pending = launchChromium('fake', join(dir, 'profile'), {}, {
    readProgress: () => String(Math.floor(Date.now() / 1000)),
  });
  await vi.advanceTimersByTimeAsync(35_000);
  expect(children).toHaveLength(1);
  expect(children[0]!.kill).not.toHaveBeenCalled();
  answer(children[0]!);
  const result = await pending;
  expect(result.proc).toBe(children[0] as unknown as ChildProcess);
  result.browser.close();
});

it('allows a launch beyond 30 seconds while stderr arrives', async () => {
  const children = launcher();
  const pending = launchChromium('fake', join(dir, 'profile'), {}, { readProgress: () => undefined });
  for (let i = 0; i < 4; i++) {
    await vi.advanceTimersByTimeAsync(10_000);
    children[0]!.stderr.write('loading\n');
  }
  expect(children).toHaveLength(1);
  expect(children[0]!.kill).not.toHaveBeenCalled();
  answer(children[0]!);
  (await pending).browser.close();
});

it('kills and retries a silent process with unchanged counters at the silence window', async () => {
  const children = launcher();
  const pending = launchChromium('fake', join(dir, 'profile'), {}, { readProgress: () => 'unchanged' }).catch(error => error);
  await vi.advanceTimersByTimeAsync(29_999);
  expect(children[0]!.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
  expect(children).toHaveLength(2);
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await pending).toMatchObject({ kind: 'timeout', message: expect.stringContaining('silent for 30 s') });
});

it('kills a progressing launch at the hard hang guard without retrying', async () => {
  const children = launcher();
  const pending = launchChromium('fake', join(dir, 'profile'), {}, { readProgress: () => String(Date.now()) }).catch(error => error);
  await vi.advanceTimersByTimeAsync(120_000);
  expect(await pending).toMatchObject({ kind: 'timeout', message: expect.stringContaining('exceeded the 120 s hang guard') });
  expect(children).toHaveLength(1);
  expect(children[0]!.kill).toHaveBeenCalledWith('SIGKILL');
});


it('counts inbound DevTools bytes as progress before the complete ready reply', async () => {
  const children = launcher();
  const pending = launchChromium('fake', join(dir, 'profile'), {}, { readProgress: () => undefined });
  await vi.advanceTimersByTimeAsync(20_000);
  children[0]!.stdio[4]!.write('{"id":1,');
  await vi.advanceTimersByTimeAsync(20_000);
  expect(children[0]!.kill).not.toHaveBeenCalled();
  children[0]!.stdio[4]!.write('"result":{}}\u0000');
  (await pending).browser.close();
  // A successful launch releases all launch timers; later quiet must not kill the browser.
  await vi.advanceTimersByTimeAsync(120_000);
  expect(children[0]!.kill).not.toHaveBeenCalled();
});
