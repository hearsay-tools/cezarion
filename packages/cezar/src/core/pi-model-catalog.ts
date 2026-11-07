import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { effortLevelSchema, type EffortLevel } from '@open-mercato/cezar-contract/effort';
import { trackChildExit } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import type { ModelOption } from './runner-model-catalog.ts';

export interface PiModelDiscoveryOptions {
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
const RPC_ARGS = [
  '--mode',
  'rpc',
  '--no-session',
  '--no-tools',
  '--no-skills',
  '--no-prompt-templates',
] as const;

/** SGR/CSI sequences — `pi --list-models` colorizes a TTY. */
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

/** The host binary, resolved exactly like `PiRunner` and the backend probe. */
export function resolvePiExecutable(bin?: string): string {
  return bin ?? process.env.CEZ_PI_BIN ?? 'pi';
}

/**
 * Discover the models the host's own pi installation offers, by asking it: `pi --list-models`
 * prints a provider/model table, which is the same list pi's own picker routes to.
 *
 * Best-effort by contract — `RunnerModelCatalog` turns any throw here into a cached or
 * `unavailable` answer, and `auto` stays selectable either way. No config is read or written,
 * no session is started; the child is short-lived and bounded by a deadline, a stdout cap and
 * a model cap.
 */
export async function discoverPiModels(options: PiModelDiscoveryOptions): Promise<ModelOption[]> {
  // `PiRunner` swaps in the bundled mock under CEZ_DRY_RUN=1. Without an explicit binary, skip
  // both host probes so an offline dry-run cockpit never shells out to a real `pi`.
  if (options.bin === undefined && process.env.CEZ_PI_BIN === undefined && process.env.CEZ_DRY_RUN === '1') {
    return [];
  }

  const bin = resolvePiExecutable(options.bin);
  const spawn = options.spawn ?? spawnPi;
  const deadline = Date.now() + (options.timeoutMs ?? DEFAULT_DISCOVERY_TIMEOUT_MS);
  const listChild = spawn(bin, ['--list-models'], options.cwd);
  const listOutputPromise = collectPiOutput(
    listChild,
    Math.max(1, deadline - Date.now()),
    'Pi model discovery',
  );
  listChild.stdin.end();
  const listOutput = await listOutputPromise;
  const models = parsePiModels(listOutput);
  if (models.length === 0 || Date.now() >= deadline) return models;

  try {
    const rpcChild = spawn(bin, RPC_ARGS, options.cwd);
    const outputPromise = collectPiOutput(
      rpcChild,
      Math.max(1, deadline - Date.now()),
      'Pi effort discovery',
    );
    try {
      models.forEach((model, index) => {
        const slash = model.id.indexOf('/');
        rpcChild.stdin.write(`${JSON.stringify({
          id: `set:${index}`,
          type: 'set_model',
          provider: model.id.slice(0, slash),
          modelId: model.id.slice(slash + 1),
        })}\n`);
        rpcChild.stdin.write(`${JSON.stringify({
          id: `levels:${index}`,
          type: 'get_available_thinking_levels',
        })}\n`);
      });
      rpcChild.stdin.end();
    } catch (error) {
      rpcChild.stdin.destroy();
      await outputPromise.catch(() => undefined);
      throw error;
    }
    const output = await outputPromise;
    const levels = parsePiEffortLevels(output, models.length);
    return models.map((model, index) => {
      const effortLevels = levels.get(index);
      return effortLevels ? { ...model, effortLevels } : model;
    });
  } catch {
    // Effort metadata is enrichment. A missing/older RPC path must not discard a valid model list.
    return models;
  }
}

async function collectPiOutput(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number,
  label: string,
): Promise<string> {
  const kill = teardown(child);
  let timeout: NodeJS.Timeout | undefined;
  try {
    return await new Promise<string>((resolve, reject) => {
      let stdout = '';
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        reject(new Error(message));
        kill();
      };

      timeout = setTimeout(() => fail(`${label} timed out`), timeoutMs);
      timeout.unref?.();
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        if (settled) return;
        stdout += chunk;
        if (stdout.length > MAX_OUTPUT_CHARS) fail(`${label} exceeded the output limit`);
      });
      child.stderr.resume();
      child.stdin.once('error', () => fail(`${label} stdin failed`));
      child.once('error', () => fail(`${label} child failed`));
      child.once('close', (code) => {
        if (settled) return;
        if (code !== 0) {
          fail(`${label} child exited (${code ?? 'unknown'})`);
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

/**
 * Turn `pi --list-models` output into picker options, preserving pi's own order.
 *
 * The listing is a whitespace-aligned table whose first two columns are `provider` and
 * `model`. Anything without that header is treated as a failure: the CLI said something we
 * cannot read, and reporting "unavailable" is more honest than an empty catalog that looks
 * like "you have no models".
 */
export function parsePiModels(stdout: string): ModelOption[] {
  const lines = stdout
    .replace(ANSI_RE, '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const headerIndex = lines.findIndex((line) => {
    const cols = line.split(/\s+/);
    return cols[0]?.toLowerCase() === 'provider' && cols[1]?.toLowerCase() === 'model';
  });
  if (headerIndex < 0) {
    throw new Error('Pi model discovery returned unrecognized output');
  }

  const models: ModelOption[] = [];
  const ids = new Set<string>();
  for (const line of lines.slice(headerIndex + 1)) {
    const cols = line.split(/\s+/);
    const provider = cols[0];
    const model = cols[1];
    if (!provider || !model) continue;
    const id = `${provider}/${model}`;
    if (ids.has(id)) continue;
    if (models.length >= MAX_MODELS) throw new Error('Pi model discovery exceeded the size limit');
    ids.add(id);
    models.push({ id, label: model, description: `via ${provider}` });
  }
  return models;
}

/** One parsed RPC response line: which half of the probe pair answered, for which model. */
interface PiEffortRecord {
  readonly index: number;
  readonly kind: 'set' | 'levels';
  readonly record: Record<string, unknown>;
}

/**
 * Parse one RPC response line into a `set`/`levels` record for a known model index, or
 * `undefined` for anything else on the wire: malformed JSON, non-responses, foreign ids,
 * out-of-range indexes.
 */
function parsePiEffortRecord(line: string, modelCount: number): PiEffortRecord | undefined {
  let record: unknown;
  try {
    record = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (!isRecord(record) || record.type !== 'response' || record.success !== true) return undefined;
  const id = typeof record.id === 'string' ? record.id : '';
  const match = /^(set|levels):(\d+)$/.exec(id);
  if (!match) return undefined;
  const index = Number(match[2]);
  if (!Number.isInteger(index) || index < 0 || index >= modelCount) return undefined;
  return { index, kind: match[1] as PiEffortRecord['kind'], record };
}

/**
 * Parse the `levels` payload of a `get_available_thinking_levels` response, keeping
 * schema-valid levels in wire order without duplicates; `undefined` when the payload is
 * malformed or every level is invalid.
 */
function parsePiLevelCandidates(record: Record<string, unknown>): EffortLevel[] | undefined {
  if (!isRecord(record.data) || !Array.isArray(record.data.levels)) return undefined;
  const levels: EffortLevel[] = [];
  for (const value of record.data.levels) {
    const parsed = effortLevelSchema.safeParse(value);
    if (parsed.success && !levels.includes(parsed.data)) levels.push(parsed.data);
  }
  return levels.length > 0 ? levels : undefined;
}

/** Parse model-indexed Pi RPC responses without letting a failed model switch reuse prior state. */
export function parsePiEffortLevels(
  stdout: string,
  modelCount: number,
): Map<number, EffortLevel[]> {
  const successfulSets = new Set<number>();
  const candidates = new Map<number, EffortLevel[]>();

  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    const parsed = parsePiEffortRecord(line, modelCount);
    if (!parsed) continue;

    if (parsed.kind === 'set' && parsed.record.command === 'set_model') {
      successfulSets.add(parsed.index);
      continue;
    }
    if (parsed.kind !== 'levels' || parsed.record.command !== 'get_available_thinking_levels') continue;
    const levels = parsePiLevelCandidates(parsed.record);
    if (levels) candidates.set(parsed.index, levels);
  }

  const result = new Map<number, EffortLevel[]>();
  for (const [index, levels] of candidates) {
    if (successfulSets.has(index)) result.set(index, levels);
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function spawnPi(
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
    env: buildChildEnv({ backend: 'pi' }),
  });
}

/**
 * Returns the probe's teardown: SIGTERM now, SIGKILL once the grace window elapses.
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
