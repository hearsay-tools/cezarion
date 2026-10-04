import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { once } from 'node:events';

/** A real same-user Linux holder: only enumeration may be scoped by callers. */
export async function nonDumpableHolder(cwd: string) {
  const child = spawn('python3', ['-u', '-c', `
import ctypes, sys
assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0
print('ready', flush=True)
for line in sys.stdin:
    with open('holder-writes', 'a') as f: f.write(line)
    print('written', flush=True)
`], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  await Promise.race([once(child.stdout, 'data'), exited.then(() => { throw Error('Python non-dumpable fixture exited before readiness'); })]);
  // Assert the real kernel boundary; do not simulate EACCES.
  try { readlinkSync(`/proc/${child.pid}/cwd`); throw Error('non-dumpable cwd unexpectedly readable'); }
  catch (error) { if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { child.kill(); await exited; throw error; } }
  return { pid: child.pid!, async write() {
    const written = once(child.stdout, 'data'); child.stdin.write('still writable\n'); await written;
  }, async close() { child.stdin.end(); await exited; } };
}
