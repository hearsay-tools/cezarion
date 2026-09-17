import { spawn as nodeSpawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { z } from 'zod';
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
// ACP initializes provider services before listing parameters; the installed build
// exceeded the legacy listing's 10s deadline under load. Keep a finite startup bound.
const DEFAULT_ACP_DISCOVERY_TIMEOUT_MS = 30_000;
const KILL_GRACE_MS = 2_000;
const MAX_MODELS = 500;
const MAX_OUTPUT_CHARS = 512 * 1_024;
const ANSI_RE = /\u001B\[[0-9;]*[A-Za-z]/g;

export function resolveCursorExecutable(bin?: string): string {
  return bin ?? process.env.CEZ_CURSOR_BIN ?? 'agent';
}

const effortLevelSchema = z.enum(['low', 'medium', 'high', 'xhigh', 'max']);
const parameterizedModelsSchema = z.object({
  models: z.array(z.object({
    value: z.string().min(1),
    name: z.string(),
    configOptions: z.array(z.object({
      id: z.string(),
      type: z.string(),
      options: z.array(z.object({ value: z.string() })).optional(),
    })).optional(),
  })).max(MAX_MODELS),
});
const rpcResponseSchema = z.object({
  jsonrpc: z.literal('2.0'),
  id: z.number(),
  result: z.unknown().optional(),
  error: z.object({ code: z.number() }).optional(),
});

class UnsupportedPickerError extends Error {}

/** Prefer the read-only ACP extension. Older agents still expose the opaque variant listing. */
export async function discoverCursorModels(options: CursorModelDiscoveryOptions): Promise<ModelOption[]> {
  if (options.bin === undefined && process.env.CEZ_CURSOR_BIN === undefined && process.env.CEZ_DRY_RUN === '1') {
    return [];
  }
  try {
    return await discoverParameterizedModels(options);
  } catch (error) {
    if (!(error instanceof UnsupportedPickerError)) throw error;
    return discoverCursorVariantModels(options);
  }
}

function discoverParameterizedModels(options: CursorModelDiscoveryOptions): Promise<ModelOption[]> {
  const child = (options.spawn ?? spawnCursor)(resolveCursorExecutable(options.bin), ['acp'], options.cwd);
  const hasExited = trackChildExit(child);
  return new Promise((resolve, reject) => {
    let settled = false;
    let pending = '';
    let outputChars = 0;
    let responseId = 1;
    const finish = (error?: Error, models?: ModelOption[]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.stdin.end();
      if (!hasExited()) {
        child.kill('SIGTERM');
        const escalation = setTimeout(() => {
          if (!hasExited()) child.kill('SIGKILL');
        }, KILL_GRACE_MS);
        escalation.unref?.();
      }
      if (error) reject(error);
      else resolve(models ?? []);
    };
    const fail = (reason: string) => finish(new Error(`Cursor model discovery ${reason}`));
    const timeout = setTimeout(() => fail('timed out'), options.timeoutMs ?? DEFAULT_ACP_DISCOVERY_TIMEOUT_MS);
    timeout.unref?.();
    const send = (id: number, method: string, params: unknown) => {
      try {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
      } catch { fail('stdin failed'); }
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      if (settled) return;
      outputChars += chunk.length;
      if (outputChars > MAX_OUTPUT_CHARS) return fail('exceeded the output limit');
      pending += chunk;
      let newline: number;
      while (!settled && (newline = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 1);
        if (!line.trim()) continue;
        let raw: unknown;
        try { raw = JSON.parse(line); } catch { fail('returned unrecognized output'); return; }
        const parsed = rpcResponseSchema.safeParse(raw);
        if (!parsed.success) {
          // ACP notifications have no response id and can be ignored during discovery.
          if (raw && typeof raw === 'object' && !('id' in raw) && 'method' in raw) continue;
          fail('returned unrecognized output');
          return;
        }
        const response = parsed.data;
        if (response.id !== responseId) continue;
        if (response.error) {
          if (responseId === 2 && response.error.code === -32601) {
            finish(new UnsupportedPickerError('Cursor model discovery picker unsupported'));
          } else fail('request failed');
          return;
        }
        if (responseId === 1) {
          const initialized = z.object({ protocolVersion: z.literal(1) }).safeParse(response.result);
          if (!initialized.success) return fail('returned unrecognized initialization');
          responseId = 2;
          send(2, 'cursor/list_available_models', {});
          continue;
        }
        const catalog = parameterizedModelsSchema.safeParse(response.result);
        if (!catalog.success) return fail('returned unrecognized models');
        const seen = new Set<string>();
        const models: ModelOption[] = [];
        for (const model of catalog.data.models) {
          if (seen.has(model.value)) continue;
          seen.add(model.value);
          const levels: NonNullable<ModelOption['effortLevels']> = [];
          for (const config of model.configOptions ?? []) {
            if (!['effort', 'reasoning', 'reasoning_effort'].includes(config.id) || config.type !== 'select') continue;
            for (const option of config.options ?? []) {
              const level = effortLevelSchema.safeParse(option.value);
              if (level.success && !levels.includes(level.data)) levels.push(level.data);
            }
          }
          models.push({ id: model.value, label: model.name, description: '', effortLevels: levels });
        }
        finish(undefined, models);
      }
    });
    // Drain diagnostics without retaining or surfacing potentially private output.
    child.stderr.resume();
    child.stdin.once('error', () => fail('stdin failed'));
    child.once('error', () => fail('child failed'));
    child.once('close', () => fail('child closed before discovery completed'));
    send(1, 'initialize', { protocolVersion: 1, clientCapabilities: { _meta: { parameterizedModelPicker: true } } });
  });
}

/**
 * Ask the installed CLI for its account's models, without starting a model turn or session.
 * https://cursor.com/docs/cli/reference/parameters documents this listing flag.
 * The catalog handles failures as cached/unavailable results; no credential files are read.
 */
export async function discoverCursorVariantModels(options: CursorModelDiscoveryOptions): Promise<ModelOption[]> {
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
