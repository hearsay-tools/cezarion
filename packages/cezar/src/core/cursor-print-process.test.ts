import { describe, expect, it } from 'vitest';
import { startCursorPrintProcess } from './cursor-print-process.ts';

const env = { ...process.env };

describe('Cursor print process ownership', () => {
  it('separates leader exit from bounded stream and descendant cleanup', async () => {
    let stdout = '';
    const proc = startCursorPrintProcess({
      bin: process.execPath,
      args: ['-e', `const {spawn}=require('node:child_process');
        const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});
        process.stdout.write(String(c.pid)+'\\n'); setTimeout(()=>process.exit(0),10);`],
      cwd: process.cwd(), env,
      drainMs: 50, termGraceMs: 30, killGraceMs: 50,
    }, { onStdout: chunk => { stdout += chunk; }, onStderr: () => {} });
    expect((await proc.exit).code).toBe(0);
    await proc.settled;
    const descendantPid = Number(stdout.trim());
    expect(descendantPid).toBeGreaterThan(0);
    await expect.poll(() => {
      try { process.kill(descendantPid, 0); return true; } catch { return false; }
    }, { timeout: 1_000 }).toBe(false);
  });

  it('escalates an interrupt when the leader ignores TERM', async () => {
    let markReady!: () => void;
    const ready = new Promise<void>(resolve => { markReady = resolve; });
    const proc = startCursorPrintProcess({
      bin: process.execPath,
      args: ['-e', `process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000);`],
      cwd: process.cwd(), env,
      drainMs: 30, termGraceMs: 30, killGraceMs: 50,
    }, { onStdout: chunk => { if (chunk.includes('ready')) markReady(); }, onStderr: () => {} });
    await ready;
    await proc.stop('interrupt');
    const result = await proc.exit;
    expect(result.signal).toBe('SIGKILL');
    await proc.settled;
    expect(proc.pid).toBeGreaterThan(0);
  });

  it('writes to stdin while open and refuses after input closes', async () => {
    let stdout = '';
    const proc = startCursorPrintProcess({
      bin: process.execPath,
      args: ['-e', `let b=''; process.stdin.on('data',x=>b+=x); process.stdin.on('end',()=>process.stdout.write(b));`],
      cwd: process.cwd(), env,
      drainMs: 30, termGraceMs: 30, killGraceMs: 50,
    }, { onStdout: chunk => { stdout += chunk; }, onStderr: () => {} });
    await proc.write('hello');
    proc.closeInput();
    await proc.settled;
    expect(stdout).toBe('hello');
    await expect(proc.write('late')).rejects.toThrow();
  });
});
