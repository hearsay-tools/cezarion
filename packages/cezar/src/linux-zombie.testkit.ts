import { spawn, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';

export const hasLinuxPython = process.platform === 'linux' && spawnSync('python3', ['-I', '-c', 'import ctypes'], { stdio: 'ignore' }).status === 0;

/** A zombie leader with another thread holding a listening socket. */
export async function threadHoldingPort() {
  const child = spawn('python3', ['-I', '-c', `
import ctypes, signal, socket, threading, time
signal.signal(signal.SIGTERM, signal.SIG_IGN)
s = socket.socket(); s.bind(('127.0.0.1', 0)); s.listen()
print(s.getsockname()[1], flush=True)
threading.Thread(target=lambda: time.sleep(60)).start()
ctypes.CDLL(None).pthread_exit(None)
`], { detached: true, stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<void>(resolve => child.once('exit', () => resolve()));
  try {
    const port = Number(await new Promise<string>(resolve => child.stdout!.once('data', data => resolve(String(data).trim()))));
    const deadline = Date.now() + 10_000;
    while (true) {
      const fields = readFileSync(`/proc/${child.pid}/stat`, 'utf8').split(')').at(-1)!.trim().split(/\s+/);
      if (fields[0] === 'Z' && Number(fields[17]) > 1) break;
      if (Date.now() >= deadline) throw Error('main thread did not exit');
      await delay(20);
    }
    await new Promise<void>((resolve, reject) => {
      const socket = connect(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', reject);
    });
    return { pid: child.pid!, port, stop: async () => { child.kill('SIGKILL'); await exited; } };
  } catch (error) { child.kill('SIGKILL'); await exited; throw error; }
}

/** A single-thread zombie, held unreaped by its sleeping parent. */
export async function singleThreadZombie() {
  const parent = spawn('sh', ['-c', "setsid sh -c 'echo $$; exit' & exec sleep 60"], { stdio: ['ignore', 'pipe', 'ignore'] });
  const exited = new Promise<void>(resolve => parent.once('exit', () => resolve()));
  try {
    const pid = Number(await new Promise<string>(resolve => parent.stdout!.once('data', data => resolve(String(data).trim()))));
    const deadline = Date.now() + 10_000;
    while (true) {
      const fields = readFileSync(`/proc/${pid}/stat`, 'utf8').split(')').at(-1)!.trim().split(/\s+/);
      if (fields[0] === 'Z' && Number(fields[17]) === 1) break;
      if (Date.now() >= deadline) throw Error('child did not become a zombie');
      await delay(20);
    }
    return { pid, stop: async () => { parent.kill('SIGKILL'); await exited; } };
  } catch (error) { parent.kill('SIGKILL'); await exited; throw error; }
}
