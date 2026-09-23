import { spawn } from 'node:child_process';

/** A lock abort is complete only after the npm process has actually exited. */
export async function runOwnedNpm(command: string, args: string[], env: NodeJS.ProcessEnv, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new Error('update lock ownership changed');
  const child = spawn(command, args, { env, stdio: 'ignore' });
  await new Promise<void>((resolve, reject) => {
    let cancelled = false;
    let timedOut = false;
    let spawnError: Error | undefined;
    let escalation: ReturnType<typeof setTimeout> | undefined;
    const cancel = () => {
      if (cancelled) return;
      cancelled = true;
      child.kill('SIGTERM');
      escalation = setTimeout(() => child.kill('SIGKILL'), 2_000);
    };
    const deadline = setTimeout(() => { timedOut = true; cancel(); }, 120_000);
    const onAbort = () => cancel();
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) cancel();
    child.once('error', (error) => { spawnError = error; });
    child.once('close', (code) => {
      clearTimeout(deadline);
      if (escalation) clearTimeout(escalation);
      signal?.removeEventListener('abort', onAbort);
      if (signal?.aborted) reject(new Error('update lock ownership changed'));
      else if (spawnError) reject(new Error('npm could not start'));
      else if (timedOut) reject(new Error('npm operation timed out'));
      else if (cancelled) reject(new Error('npm operation cancelled'));
      else if (code !== 0) reject(new Error('npm operation failed'));
      else resolve();
    });
  });
}
