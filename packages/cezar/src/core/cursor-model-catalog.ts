import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface CursorModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, args: readonly string[], cwd: string) => ChildProcessWithoutNullStreams;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
const KILL_GRACE_MS = 2_000;
const MAX_MODELS = 500;
const MAX_OUTPUT_CHARS = 512 * 1_024;
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

export function resolveCursorExecutable(bin?: string): string {
  return bin ?? process.env.CEZ_CURSOR_BIN ?? 'agent';
}

/**
 * Ask the installed CLI for its account's models, without starting a model turn or session.
 * https://cursor.com/docs/cli/reference/parameters documents this listing flag.
 * The catalog handles failures as cached/unavailable results; no credential files are read.
 */
export async function discoverCursorModels(options: CursorModelDiscoveryOptions): Promise<ModelOption[]> {
  if (options.bin === undefined && process.env.CEZ_CURSOR_BIN === undefined && process.env.CEZ_DRY_RUN === '1') {
    return [];
  }
  const child = (options.spawn ?? spawnCursor)(resolveCursorExecutable(options.bin), ['--list-models'], options.cwd);
  const hasExited = trackChildExit(child);
  let signalled = false;
  const kill = () => {
    if (signalled || hasExited()) return;
    signalled = true;
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      // `killed` only means a signal was delivered, not that the child terminated.
      if (!hasExited()) child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    escalation.unref?.();
  };
  let timeout: NodeJS.Timeout | undefined;
  try {
    const stdout = await new Promise<string>((resolve, reject) => {
      let output = '';
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(`Cursor model discovery ${message}`));
        kill();
      };
      timeout = setTimeout(() => fail('timed out'), options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
      timeout.unref?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        output += chunk;
        if (output.length > MAX_OUTPUT_CHARS) fail('exceeded the output limit');
      });
      // Drain diagnostics, but never surface raw CLI output in an error.
      child.stderr.resume();
      child.stdin.once('error', () => fail('stdin failed'));
      child.once('error', () => fail('child failed'));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(`child exited (${code ?? 'unknown'})`);
          return;
        }
        settled = true;
        resolve(output);
      });
      child.stdin.end();
    });
    return parseCursorModels(stdout);
  } finally {
    if (timeout) clearTimeout(timeout);
    kill();
  }
}

/** Parse the CLI's `Available models` listing, retaining its order and opaque model IDs. */
export function parseCursorModels(stdout: string): ModelOption[] {
  const lines = stdout.replace(ANSI_RE, '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const header = lines.indexOf('Available models');
  if (header < 0) throw new Error('Cursor model discovery returned unrecognized output');
  const models: ModelOption[] = [];
  const ids = new Set<string>();
  for (const line of lines.slice(header + 1)) {
    if (line.startsWith('Tip:')) break;
    const match = /^(\S+)\s+-\s+(.+)$/.exec(line);
    if (!match) throw new Error('Cursor model discovery returned unrecognized output');
    const [, id, display] = match;
    if (!id || !display || ids.has(id)) continue;
    if (models.length >= MAX_MODELS) throw new Error('Cursor model discovery exceeded the size limit');
    ids.add(id);
    const isDefault = display.endsWith(' (default)');
    models.push({
      id,
      label: isDefault ? display.slice(0, -' (default)'.length) : display,
      description: isDefault ? 'Default model' : '',
    });
  }
  return models;
}

export function spawnCursor(
  bin: string,
  args: readonly string[],
  cwd: string,
  spawnImpl: (
    bin: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams = nodeSpawn,
): ChildProcessWithoutNullStreams {
  return spawnImpl(bin, [...args], { cwd, env: buildChildEnv({ backend: 'cursor' }) });
}
