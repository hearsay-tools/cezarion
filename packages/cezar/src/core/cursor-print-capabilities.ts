import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRunSpec } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { NATIVE_CURSOR_DELEGATION_TOOLS, SAFE_CURSOR_PRINT_TOOLS } from './cursor-print-tool-catalog.ts';
import { parseCursorModels } from './cursor-model-catalog.ts';
import type { ModelOption } from './runner-model-catalog.ts';

const execute = promisify(execFile);
const QUALIFIED_VERSION = '2026.10.01-e373342';
const INVALID_TOOL = '__cezar_probe_invalid__';
const EXPECTED_TOOLS = new Set<string>([...SAFE_CURSOR_PRINT_TOOLS, ...NATIVE_CURSOR_DELEGATION_TOOLS]);
export type CursorPrintCapabilityResult =
  | { supported: true; models?: readonly ModelOption[]; model?: string }
  | { supported: false; reason: string };

/** Bounded, pre-inference checks against the exact build and native tool schema qualified for print. */
export async function inspectCursorPrintCapabilities(
  bin: string,
  spec: AgentRunSpec,
  signal?: AbortSignal,
): Promise<CursorPrintCapabilityResult> {
  const options = {
    cwd: spec.cwd,
    env: buildChildEnv({ backend: 'cursor', extraEnv: spec.env }),
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    signal,
  };
  let version: string;
  try { version = (await execute(bin, ['--version'], options)).stdout.trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Cursor CLI is not installed or is unavailable on PATH');
    }
    throw new Error('Cursor print capability preflight could not read CLI version');
  }
  if (version !== QUALIFIED_VERSION) {
    return { supported: false, reason: `Cursor print marketplace support is qualified for ${QUALIFIED_VERSION}; installed build is not qualified` };
  }
  let output: string;
  try {
    await execute(bin, ['--print', '--allowed-tools', INVALID_TOOL, 'capability validation only'], options);
    throw new Error('Cursor print capability preflight did not reject an invalid native tool');
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('Cursor print capability preflight')) throw error;
    const failure = error as Error & { stderr?: string; stdout?: string; code?: number };
    if (failure.code !== 1) throw new Error('Cursor print capability preflight could not inspect native tools');
    output = `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`;
  }
  const match = /Invalid --allowed-tools value\(s\): __cezar_probe_invalid__\. Expected one of: ([a-z_, ]+)/.exec(output);
  if (!match) throw new Error('Cursor print capability preflight returned an unknown native tool response');
  const names = match[1]!.split(',').map(name => name.trim()).filter(Boolean);
  if (names.length !== EXPECTED_TOOLS.size || new Set(names).size !== EXPECTED_TOOLS.size ||
    names.some(name => !EXPECTED_TOOLS.has(name))) {
    return { supported: false, reason: 'Cursor native tool catalog differs from the qualified print build' };
  }
  if (!spec.model && !spec.effort) return { supported: true };
  let models: ModelOption[];
  try { models = parseCursorModels((await execute(bin, ['--list-models'], options)).stdout); }
  catch { throw new Error('Cursor print capability preflight could not read selected-account models'); }
  const model = spec.model ?? models.find(option => option.description === 'Default model')?.id;
  if (!model || !models.some(option => option.id === model)) {
    throw new Error('Cursor print requested model is not advertised for the selected account');
  }
  if (spec.effort) {
    const base = model.replace(/-(?:none|low|medium|high|xhigh|extra-high|max)$/, '');
    const suffixes = spec.effort === 'xhigh' ? ['xhigh', 'extra-high'] : [spec.effort];
    if (!suffixes.some(suffix => models.some(option => option.id === `${base}-${suffix}`))) {
      throw new Error('Cursor print requested effort is not advertised for the selected account');
    }
  }
  return { supported: true, models, model };
}
