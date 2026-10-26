import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { startCursorPrintProcess } from './cursor-print-process.ts';
import { killFromPidFile, readPids, requirePidText } from '../pid-file.testkit.ts';

const env = { ...process.env };

/** A zombie has exited; only its reaper's wait remains. */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch { return false; }
  if (process.platform !== 'linux') return true;
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 1).trim()[0] !== 'Z';
  } catch { return false; }
}

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
    const descendantPid = requirePidText(stdout, 'cursor stdout');
    // bound: wait for the fixture's native process receipt on a loaded host.
    await expect.poll(() => {
      try { process.kill(descendantPid, 0); return true; } catch { return false; }
    }, { timeout: 10_000 }).toBe(false);
  });

  // Cursor's `agent -p` starts a `worker-server` daemon (`detached: false`, `stdio: 'ignore'`)
  // that starts a language server, and exits 0 leaving both in its process group
  // (hearsay-tools/cezarion#1285).
  it.skipIf(process.platform === 'win32')('ends a daemon the leader leaves in its group, as Cursor\'s worker-server, and signals nothing outside it', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'cez-cursor-ws-'));
    const otherWorkspace = mkdtempSync(join(tmpdir(), 'cez-cursor-other-'));
    const pidFile = join(workspace, 'daemon.pids');
    const termFile = join(workspace, 'daemon.term');
    // The daemon records the graceful TERM and exits; the language server ignores TERM, so only
    // the SIGKILL escalation ends it. It reports ready once its handler is in place, and the
    // daemon, whose own handler comes first, publishes both pids only then.
    const lsp = `process.on('SIGTERM',()=>{}); process.stdout.write('ready\\n'); setInterval(()=>{},1000);`;
    const daemon = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
      process.on('SIGTERM',()=>{ const tmp=${JSON.stringify(termFile)}+'.tmp'; fs.writeFileSync(tmp,'TERM'); fs.renameSync(tmp,${JSON.stringify(termFile)}); process.exit(0); });
      const c=spawn(process.execPath,['-e',${JSON.stringify(lsp)}],{detached:false,stdio:'pipe'});
      c.stdout.once('data',()=>{ const tmp=${JSON.stringify(pidFile)}+'.tmp'; fs.writeFileSync(tmp,process.pid+'\\n'+c.pid+'\\n'); fs.renameSync(tmp,${JSON.stringify(pidFile)}); });
      setInterval(()=>{},1000);`;
    // bound: the leader's hang guard while two node processes start on a loaded host; it exits 3 if they never report.
    const leader = `const {spawn}=require('node:child_process'); const fs=require('node:fs');
      spawn(process.execPath,['-e',${JSON.stringify(daemon)}],{detached:false,stdio:'ignore'}).unref();
      const ready=()=>{ let t=''; try{t=fs.readFileSync(${JSON.stringify(pidFile)},'utf8');}catch{} return t.split('\\n').filter(l=>/^\\d+$/.test(l)).length===2; };
      setTimeout(()=>process.exit(3),15000); setInterval(()=>{ if(ready()) process.exit(0); },20);`;
    // Another worktree's Cursor session, and the user's own Cursor in this workspace.
    const other = startCursorPrintProcess({
      bin: process.execPath, args: ['-e', 'setInterval(()=>{},1000);'],
      cwd: otherWorkspace, env, drainMs: 50, termGraceMs: 30, killGraceMs: 50,
    }, { onStdout: () => {}, onStderr: () => {} });
    const outsider = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000);'], { cwd: workspace, detached: true, stdio: 'ignore' });
    try {
      const proc = startCursorPrintProcess({
        bin: process.execPath, args: ['-e', leader],
        // bound: the TERM-to-KILL window the daemon's handler must write its receipt in; settling waits it out in full, as the language server ignores TERM.
        cwd: workspace, env, drainMs: 5_000, termGraceMs: 30, killGraceMs: 50,
      }, { onStdout: () => {}, onStderr: () => {} });
      expect((await proc.exit).code).toBe(0);
      await proc.settled;
      const pids = readPids(pidFile);
      expect(pids).toHaveLength(2);
      // bound: signal delivery and reaping by the subreaper have no product signal to wait on.
      await expect.poll(() => pids.filter(alive), { timeout: 15_000 }).toEqual([]);
      // Written before the daemon exits, so present once its pid is gone: TERM came first.
      expect(existsSync(termFile)).toBe(true);
      expect(other.pid !== undefined && alive(other.pid)).toBe(true);
      expect(outsider.pid !== undefined && alive(outsider.pid)).toBe(true);
    } finally {
      killFromPidFile(pidFile);
      outsider.kill('SIGKILL');
      await other.stop('interrupt');
      rmSync(workspace, { recursive: true, force: true });
      rmSync(otherWorkspace, { recursive: true, force: true });
    }
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
