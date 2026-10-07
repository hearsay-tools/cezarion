import { spawn } from 'node:child_process';
import { readlinkSync } from 'node:fs';
import { once } from 'node:events';
import { createInterface } from 'node:readline';

/** A real same-user Linux holder: only enumeration may be scoped by callers. Its cwd is
 * unreadable, so it is no evidence of holding anything (hearsay-tools/cezarion#889). */
export function nonDumpableHolder(cwd: string) {
  return holder(cwd, false);
}

/** The same holder with a readable cwd: the one kind of unrecorded process that blocks. */
export function readableHolder(cwd: string) {
  return holder(cwd, true);
}

async function holder(cwd: string, dumpable: boolean) {
  const child = spawn('python3', ['-u', '-c', `
import ctypes, sys
${dumpable ? '' : 'assert ctypes.CDLL(None).prctl(4, 0, 0, 0, 0) == 0'}
print('ready', flush=True)
for line in sys.stdin:
    with open('holder-writes', 'a') as f: f.write(line)
    print('written', flush=True)
`], { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(child, 'exit');
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const expectLine = async (expected: string) => {
    const line = await lines.next();
    if (line.done || line.value !== expected) throw Error(`Expected holder acknowledgment: ${expected}`);
  };
  await Promise.race([expectLine('ready'), exited.then(() => { throw Error('Python holder fixture exited before readiness'); })]);
  // Assert the real kernel boundary; do not simulate EACCES.
  if (dumpable) readlinkSync(`/proc/${child.pid}/cwd`);
  else {
    try { readlinkSync(`/proc/${child.pid}/cwd`); throw Error('non-dumpable cwd unexpectedly readable'); }
    catch (error) { if (!['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) { child.kill(); await exited; throw error; } }
  }
  return { pid: child.pid!,
    /** Still running: nothing signalled it, even after its working directory was deleted. */
    get running() { return child.exitCode === null && child.signalCode === null; },
    async write() {
      const written = expectLine('written'); child.stdin.write('still writable\n'); await written;
    }, async close() { child.stdin.end(); await exited; } };
}
