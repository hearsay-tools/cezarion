import { execFile } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** Run git, never throw — degradation is the caller's policy. */
export function git(cwd: string, args: string[], timeout?: number, env?: NodeJS.ProcessEnv): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      { cwd, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8', timeout, ...(env ? { env } : {}) },
      (err, stdout, stderr) => resolve({ ok: !err, stdout: stdout ?? '', stderr: stderr ?? '' }),
    );
  });
}
