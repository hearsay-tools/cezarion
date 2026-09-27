import type { ChildProcess } from 'node:child_process';

export async function stopChild(child: ChildProcess, name: string, timeoutMs = 3_000): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;

  await new Promise<void>((resolve, reject) => {
    const onExit = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('exit', onExit);
    const timer = setTimeout(() => {
      child.off('exit', onExit);
      child.kill('SIGKILL');
      reject(new Error(`${name} ignored SIGTERM for ${timeoutMs}ms; sent SIGKILL`));
    }, timeoutMs);
    child.kill('SIGTERM');
  });
}
