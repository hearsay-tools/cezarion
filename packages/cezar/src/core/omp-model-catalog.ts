import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { effortLevelSchema, type EffortLevel } from '@open-mercato/cezar-contract';
import { trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface OmpModelDiscoveryOptions {
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

/** The host binary, resolved exactly like `OmpRunner` and the backend probe. */
export function resolveOmpExecutable(bin?: string): string {
  return bin ?? process.env.CEZ_OMP_BIN ?? 'omp';
}

/**
 * Discover the models the host's own OMP installation offers, by asking it: `omp models --json`
 * prints `{ "models": [...] }`, the same list OMP's own picker routes to, so no RPC session is
 * needed (unlike Pi, whose thinking levels need a second probe).
 *
 * Best-effort by contract — `RunnerModelCatalog` turns any throw here into a cached or
 * `unavailable` answer, and `auto` stays selectable either way. The throw messages are stable
 * one-line categories (never the child's output); the catalog does not surface them to the
 * client, they are for logs and direct callers. No config is read or written; the child is
 * short-lived and bounded by a deadline, a stdout cap and a model cap.
 */
export async function discoverOmpModels(options: OmpModelDiscoveryOptions): Promise<ModelOption[]> {
  // `OmpRunner` swaps in the bundled mock under CEZ_DRY_RUN=1. Without an explicit binary, skip
  // the host probe so an offline dry-run cockpit never shells out to a real `omp`.
  if (options.bin === undefined && process.env.CEZ_OMP_BIN === undefined && process.env.CEZ_DRY_RUN === '1') {
    return [];
  }

  const bin = resolveOmpExecutable(options.bin);
  const spawn = options.spawn ?? spawnOmp;
  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(bin, ['models', '--json'], options.cwd);
  } catch (error) {
    throw spawnFailure(error);
  }
  const output = collectOmpOutput(child, options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
  child.stdin.end();
  return parseOmpModels(await output);
}

async function collectOmpOutput(child: ChildProcessWithoutNullStreams, timeoutMs: number): Promise<string> {
  const kill = teardown(child);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let settled = false;
      const fail = (error: Error) => {
        if (settled) return;
        settled = true;
        reject(error);
        kill();
      };

      timeout = setTimeout(() => fail(new Error('OMP model discovery timed out')), timeoutMs);
      timeout.unref?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        stdout += chunk;
        // A listing that outgrows the cap cannot be a model list we may trust.
        if (stdout.length > MAX_OUTPUT_CHARS) fail(malformed());
      });
      child.stderr.resume();
      child.stdin.once('error', () => undefined);
      child.once('error', (error) => fail(spawnFailure(error)));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(new Error(`OMP model discovery failed (exit ${code ?? 'unknown'})`));
          return;
        }
        settled = true;
        resolve(stdout);
      });
    });
  } finally {
    if (timeout) clearTimeout(timeout);
    kill();
  }
}

function malformed(): Error {
  return new Error('OMP model discovery returned malformed output');
}

function spawnFailure(error: unknown): Error {
  if (isRecord(error) && error.code === 'ENOENT') return new Error('OMP CLI not installed');
  return new Error('OMP model discovery failed to start');
}

/**
 * Turn `omp models --json` output into picker options, preserving OMP's own order.
 *
 * v18.4.11 prints an object, `{ "models": [...] }`; a bare array is accepted too. Each entry
 * carries `provider`, `kind`, `id`, `selector`, `name` and `thinking` (null, or the levels the
 * model accepts). Entries with another `kind` than `chat` (absent counts as chat) are not
 * runnable tasks and are skipped. `thinking` is intersected with cezar's `EffortLevel`s: OMP's
 * own extras (`minimal`) are dropped, never remapped, so a pinned effort always means what the
 * picker said it means.
 *
 * Anything that is not that shape is a failure — the CLI said something we cannot read, and
 * "unavailable" is more honest than an empty catalog that looks like "you have no models".
 */
export function parseOmpModels(stdout: string): ModelOption[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    throw malformed();
  }
  const entries = Array.isArray(parsed) ? parsed : isRecord(parsed) ? parsed.models : undefined;
  if (!Array.isArray(entries)) throw malformed();

  const models: ModelOption[] = [];
  const ids = new Set<string>();
  for (const entry of entries) {
    if (!isRecord(entry)) continue;
    if (entry.kind !== undefined && entry.kind !== 'chat') continue;
    const { provider, id, name } = entry;
    if (typeof provider !== 'string' || !provider || typeof id !== 'string' || !id) continue;
    const modelId = `${provider}/${id}`;
    if (ids.has(modelId)) continue;
    if (models.length >= MAX_MODELS) throw new Error('OMP model discovery exceeded the size limit');
    ids.add(modelId);
    const effortLevels = effortLevelsOf(entry.thinking);
    models.push({
      id: modelId,
      label: typeof name === 'string' && name ? name : id,
      description: provider,
      ...(effortLevels ? { effortLevels } : {}),
    });
  }
  if (models.length === 0) throw new Error('OMP reported no models (run omp login)');
  return models;
}

function effortLevelsOf(thinking: unknown): EffortLevel[] | undefined {
  if (!Array.isArray(thinking)) return undefined;
  const levels: EffortLevel[] = [];
  for (const value of thinking) {
    const level = effortLevelSchema.safeParse(value);
    if (level.success && !levels.includes(level.data)) levels.push(level.data);
  }
  return levels.length > 0 ? levels : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

// Copy of `spawnPi` (pi-model-catalog.ts) with OMP's child env.
export function spawnOmp(
  bin: string,
  args: readonly string[],
  cwd: string,
  spawnImpl: (
    bin: string,
    args: string[],
    options: { cwd: string; env: NodeJS.ProcessEnv },
  ) => ChildProcessWithoutNullStreams = nodeSpawn,
): ChildProcessWithoutNullStreams {
  return spawnImpl(bin, [...args], {
    cwd,
    env: buildChildEnv({ backend: 'omp' }),
  });
}

/**
 * Returns the probe's teardown: SIGTERM now, SIGKILL once the grace window elapses.
 * Copy of `teardown` in pi-model-catalog.ts.
 *
 * Both steps gate on the child's *real* termination, never on `child.killed` — Node flips that
 * flag the moment a signal is delivered. Called from both the failure path and the `finally`,
 * so the escalation is armed at most once.
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
