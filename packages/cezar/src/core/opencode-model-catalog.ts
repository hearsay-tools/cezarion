import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { effortLevelSchema, type EffortLevel } from '@open-mercato/cezar-contract/effort';
import { trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface OpencodeModelDiscoveryOptions {
  cwd: string;
  bin?: string;
  timeoutMs?: number;
  spawn?: (bin: string, args: readonly string[], cwd: string) => ChildProcessWithoutNullStreams;
}

const DEFAULT_DISCOVERY_TIMEOUT_MS = 10_000;
/** Grace between the probe's SIGTERM and the SIGKILL that follows it. */
export const KILL_GRACE_MS = 2_000;
const MAX_MODELS = 500;
/** Defensive cap on what we buffer from a misbehaving child (characters of stdout). */
const MAX_OUTPUT_CHARS = 512 * 1_024;

/**
 * One `provider/model` id per line — the shape `opencode models` prints (#794). Deliberately
 * strict: anything else (a banner, a prompt, a stack trace, a bare model name that OpenCode
 * could not route) is NOT a model id, and silently turning it into a picker entry would
 * recreate the very defect this replaces.
 */
const MODEL_LINE_RE = /^[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._:/-]*$/i;

/** SGR/CSI sequences, in case a future CLI colorizes even a piped stdout. */
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** The host binary, resolved exactly like `OpencodeServerRunner` and the backend probe. */
export function resolveOpencodeExecutable(bin?: string): string {
  return bin ?? process.env.CEZ_OPENCODE_BIN ?? 'opencode';
}

/**
 * Discover the models the host's own OpenCode installation offers, by asking it: `opencode
 * models` lists every `provider/model` id the configured providers expose, which is the same
 * list OpenCode's own picker routes to.
 *
 * Best-effort by contract — `RunnerModelCatalog` turns any throw here into a cached or
 * `unavailable` answer, and `auto` stays selectable either way. No config is read or written,
 * no session is started; the child is short-lived and bounded by a deadline, a stdout cap and
 * a model cap.
 */
export async function discoverOpencodeModels(
  options: OpencodeModelDiscoveryOptions,
): Promise<ModelOption[]> {
  const bin = resolveOpencodeExecutable(options.bin);
  const spawn = options.spawn ?? spawnOpencode;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
  try {
    return await runOpencodeProbe(bin, ['models', '--verbose'], options.cwd, spawn, deadline);
  } catch (error) {
    if (!(error instanceof OpencodeNonzeroExitError) || Date.now() >= deadline) throw error;
    // Older OpenCode releases know `models` but not `--verbose`. Preserve their existing model
    // picker and let every model use the cockpit's metadata fallback.
    return runOpencodeProbe(bin, ['models'], options.cwd, spawn, deadline);
  }
}

class OpencodeNonzeroExitError extends Error {}

async function runOpencodeProbe(
  bin: string,
  args: readonly string[],
  cwd: string,
  spawn: NonNullable<OpencodeModelDiscoveryOptions['spawn']>,
  deadline: number,
): Promise<ModelOption[]> {
  const child = spawn(bin, args, cwd);
  const kill = teardown(child);
  let timeout: NodeJS.Timeout | undefined;
  try {
    const result = new Promise<ModelOption[]>((resolve, reject) => {
      let stdout = '';
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
        kill();
      };

      timeout = setTimeout(
        () => fail(new Error('OpenCode model discovery timed out')),
        Math.max(1, deadline - Date.now()),
      );
      timeout.unref?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_CHARS) {
          fail(new Error('OpenCode model discovery exceeded the output limit'));
        }
      });
      child.stderr.resume();
      child.stdin.once('error', () => fail(new Error('OpenCode model discovery stdin failed')));
      child.once('error', () => fail(new Error('OpenCode model discovery child failed')));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(new OpencodeNonzeroExitError(`OpenCode model discovery child exited (${code ?? 'unknown'})`));
          return;
        }
        try {
          const models = parseOpencodeModels(stdout);
          settled = true;
          resolve(models);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      });
    });
    child.stdin.end();
    return await result;
  } finally {
    if (timeout) clearTimeout(timeout);
    kill();
  }
}

/**
 * Turn `opencode models --verbose` output into picker options, preserving OpenCode's own order.
 * Each model id starts a segment whose remaining lines are its JSON metadata. Invalid metadata is
 * isolated to that model: the id remains usable and the cockpit applies its per-model fallback.
 *
 * Empty output is a legitimate answer (no provider configured yet) and yields no models. Output
 * that contains lines but NO recognizable id is treated as a failure instead.
 */
export function parseOpencodeModels(stdout: string): ModelOption[] {
  const lines = stdout
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const segments: Array<{ id: string; metadata: string[] }> = [];
  let current: { id: string; metadata: string[] } | undefined;
  for (const line of lines) {
    if (MODEL_LINE_RE.test(line)) {
      current = { id: line, metadata: [] };
      segments.push(current);
    } else if (current) {
      current.metadata.push(line);
    }
  }

  const models: ModelOption[] = [];
  const indexes = new Map<string, number>();
  for (const segment of segments) {
    const effortLevels = effortLevelsFromMetadata(segment.metadata);
    const existingIndex = indexes.get(segment.id);
    if (existingIndex !== undefined) {
      const existing = models[existingIndex]!;
      if (!existing.effortLevels && effortLevels) {
        models[existingIndex] = { ...existing, effortLevels };
      }
      continue;
    }
    if (models.length >= MAX_MODELS) throw new Error('OpenCode model discovery exceeded the size limit');
    const provider = segment.id.slice(0, segment.id.indexOf('/'));
    indexes.set(segment.id, models.length);
    models.push({
      id: segment.id,
      label: segment.id,
      description: `via ${provider}`,
      ...(effortLevels ? { effortLevels } : {}),
    });
  }

  if (models.length === 0 && lines.length > 0) {
    throw new Error('OpenCode model discovery returned unrecognized output');
  }
  return models;
}

function effortLevelsFromMetadata(lines: readonly string[]): EffortLevel[] | undefined {
  if (lines.length === 0) return undefined;
  let metadata: unknown;
  try {
    metadata = JSON.parse(lines.join('\n'));
  } catch {
    return undefined;
  }
  if (!isRecord(metadata) || !isRecord(metadata.variants)) return undefined;

  const levels: EffortLevel[] = [];
  for (const name of Object.keys(metadata.variants)) {
    const parsed = effortLevelSchema.safeParse(name);
    if (parsed.success && !levels.includes(parsed.data)) levels.push(parsed.data);
  }
  return levels.length > 0 ? levels : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function spawnOpencode(
  bin: string,
  args: readonly string[],
  cwd: string,
): ChildProcessWithoutNullStreams {
  return nodeSpawn(bin, [...args], {
    cwd,
    env: buildChildEnv({ backend: 'opencode' }),
  });
}

/**
 * Returns the probe's teardown: SIGTERM now, SIGKILL once the grace window elapses.
 *
 * Both steps gate on the child's *real* termination, never on `child.killed` — Node flips that
 * flag the moment a signal is delivered, so the old `exitCode === null && !child.killed` test
 * went false the instant our own SIGTERM landed. A probe that installs a SIGTERM handler then
 * survived every teardown, leaking one process per cache refresh (#858, the shape #841 fixed for
 * the Claude probe in `a67b327d`).
 *
 * Called from both the failure path and the `finally`, so the escalation is armed at most once.
 */
function teardown(child: ChildProcessWithoutNullStreams): () => void {
  const hasExited = trackChildExit(child);
  let signalled = false;
  return () => {
    if (signalled || hasExited()) return;
    signalled = true;
    child.kill('SIGTERM');
    const escalation = setTimeout(() => {
      if (hasExited()) return;
      child.kill('SIGKILL');
    }, KILL_GRACE_MS);
    escalation.unref?.();
  };
}
