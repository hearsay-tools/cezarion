import { execFile } from 'node:child_process';

export interface GitResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  /** True when git wrote more than `maxBuffer`; `stdout` then holds only the start of it. */
  overflow: boolean;
}

export interface GitOptions {
  timeout?: number;
  /** Set over the cleaned process env, so a caller's own value (a private `GIT_INDEX_FILE`) wins. */
  env?: Record<string, string>;
  maxBuffer?: number;
}

const MAX_BUFFER_MIB = 32;

/** The reason a caller reports when `overflow` is true. */
export const GIT_OVERFLOW_REASON = `the diff is too large: git output is over the ${MAX_BUFFER_MIB} MiB limit`;

/** Variables that point git at a repository or index. A server started from a Git hook or a
 *  `rebase --exec` step inherits them, and git would then ignore `cwd` (hearsay-tools/squawk#3207). */
const LOCATION_VARS = [
  'GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'GIT_COMMON_DIR',
  'GIT_OBJECT_DIRECTORY', 'GIT_ALTERNATE_OBJECT_DIRECTORIES', 'GIT_PREFIX',
];

/** The process env without the location variables, with `overrides` on top. */
export function gitEnv(overrides: Record<string, string | undefined> = {}, source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const name of LOCATION_VARS) delete env[name];
  return { ...env, ...overrides };
}

/** Run git in `cwd`, never throw — degradation is the caller's policy. */
export function git(cwd: string, args: string[], options: GitOptions = {}): Promise<GitResult> {
  return new Promise((resolve) => {
    execFile(
      'git',
      args,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: options.maxBuffer ?? MAX_BUFFER_MIB * 1024 * 1024,
        timeout: options.timeout,
        env: gitEnv(options.env),
      },
      (err, stdout, stderr) => resolve({
        ok: !err,
        stdout: stdout ?? '',
        stderr: stderr ?? '',
        overflow: err?.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
      }),
    );
  });
}
