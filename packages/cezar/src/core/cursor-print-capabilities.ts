import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { AgentRunSpec } from './agent-runner.ts';
import { buildChildEnv } from './agent-env.ts';
import { CORE_CURSOR_PRINT_TOOLS } from './cursor-print-tool-catalog.ts';
import { cursorArgs, noteCursorAutoUpdateFlagRejected, rejectsCursorAutoUpdateFlag,
  usesCursorAutoUpdateFlag } from './cursor-cli-flags.ts';
import { discoverCursorParameterizedModels, parseCursorModels } from './cursor-model-catalog.ts';
import type { ModelOption } from './runner-model-catalog.ts';

const execute = promisify(execFile);
/** The first build print was qualified on (hearsay-tools/cezarion#923). Newer builds pass the
 * same pre-inference checks instead of an exact match (hearsay-tools/cezarion#1257). */
const QUALIFIED_BASELINE = '2026.10.01-e373342';
const BUILD_VERSION = /^(\d{4})\.(\d{2})\.(\d{2})-[0-9a-z]+$/;
const INVALID_TOOL = '__cezar_probe_invalid__';
export type CursorPrintCapabilityResult =
  | { supported: true; models?: readonly ModelOption[]; model?: string; resolvedModel?: string }
  | { supported: false; reason: string };

/** `YYYYMMDD` of a Cursor build version, or undefined for a format cezar does not know. */
function buildDate(version: string): number | undefined {
  const match = BUILD_VERSION.exec(version);
  return match ? Number(`${match[1]}${match[2]}${match[3]}`) : undefined;
}

/** Bounded, pre-inference checks that the installed build can run print sessions: a dated
 * build no older than the baseline, the strict native tool validator, and the core tools. */
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
  try { version = (await execute(bin, cursorArgs(bin, ['--version']), options)).stdout.trim(); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('Cursor CLI is not installed or is unavailable on PATH');
    }
    throw new Error('Cursor print capability preflight could not read CLI version');
  }
  const date = buildDate(version);
  if (date === undefined || date < buildDate(QUALIFIED_BASELINE)!) {
    return { supported: false, reason: `Cursor print marketplace support needs a build from ${QUALIFIED_BASELINE} or newer; installed build is not qualified` };
  }
  const probe = async (): Promise<string> => {
    try {
      // Match the trusted headless invocation. In a new task worktree Cursor
      // checks workspace trust before it validates --allowed-tools otherwise.
      await execute(bin, cursorArgs(bin, ['--print', '--force', '--trust', '--allowed-tools', INVALID_TOOL, 'capability validation only']), options);
      throw new Error('Cursor print capability preflight did not reject an invalid native tool');
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Cursor print capability preflight')) throw error;
      const failure = error as Error & { stderr?: string; stdout?: string; code?: number };
      if (failure.code !== 1) throw new Error('Cursor print capability preflight could not inspect native tools');
      return `${failure.stderr ?? ''}\n${failure.stdout ?? ''}`;
    }
  };
  let output = await probe();
  if (rejectsCursorAutoUpdateFlag(output) && usesCursorAutoUpdateFlag(bin)) {
    // This build has no way to stop its own updates; it still runs, without the flag.
    noteCursorAutoUpdateFlagRejected(bin);
    output = await probe();
  }
  const match = /Invalid --allowed-tools value\(s\): __cezar_probe_invalid__\. Expected one of: ([a-z_, ]+)/.exec(output);
  if (!match) throw new Error('Cursor print capability preflight returned an unknown native tool response');
  const advertised = new Set(match[1]!.split(',').map(name => name.trim()).filter(Boolean));
  const missing = CORE_CURSOR_PRINT_TOOLS.filter(name => !advertised.has(name));
  if (missing.length) {
    return { supported: false, reason: `Cursor native tool catalog lacks core print tools: ${missing.join(', ')}` };
  }
  if (!spec.model && !spec.effort) return { supported: true };
  let models: ModelOption[];
  try { models = parseCursorModels((await execute(bin, cursorArgs(bin, ['--list-models']), options)).stdout); }
  catch { throw new Error('Cursor print capability preflight could not read selected-account models'); }
  const model = spec.model ?? models.find(option => option.description === 'Default model')?.id;
  if (!model) throw new Error('Cursor print requested model is not advertised for the selected account');
  if (!models.some(option => option.id === model)) {
    // The picker uses canonical IDs from the read-only `agent acp` model catalog; --list-models
    // lists legacy aliases. Query the same account, retaining native parameter keys and defaults.
    let catalog;
    try { catalog = await discoverCursorParameterizedModels({ cwd: spec.cwd, bin, env: spec.env, signal }); }
    catch { throw new Error('Cursor print capability preflight could not read selected-account model parameters'); }
    const selected = catalog.find(option => option.value === model);
    if (!selected) throw new Error('Cursor print requested model is not advertised for the selected account');
    let resolvedModel = model;
    if (spec.effort) {
      const parameters = (selected.configOptions ?? []).filter(option => option.type === 'select');
      const effort = parameters.find(option => ['effort', 'reasoning', 'reasoning_effort'].includes(option.id) &&
        option.options?.some(value => value.value === spec.effort));
      if (!effort) throw new Error('Cursor print requested effort is not advertised for the selected account');
      const selection = /^([^\[\]]+)(?:\[([^\[\]]+)\])?$/.exec(model);
      if (!selection) throw new Error('Cursor print cannot verify the requested model parameters');
      const embedded = new Map<string, string>();
      for (const entry of selection[2]?.split(',') ?? []) {
        const pair = /^([a-zA-Z0-9_]+)=([a-zA-Z0-9_.-]+)$/.exec(entry);
        if (!pair || embedded.has(pair[1]!)) throw new Error('Cursor print cannot verify the requested model parameters');
        embedded.set(pair[1]!, pair[2]!);
      }
      const values = parameters.map(option => ({ id: option.id,
        value: option === effort ? spec.effort! : embedded.get(option.id) ?? option.currentValue }));
      if (values.some((option, index) => !option.value || !/^[a-zA-Z0-9_.-]+$/.test(option.value) ||
        !/^[a-zA-Z0-9_]+$/.test(option.id) ||
        !parameters[index]!.options?.some(value => value.value === option.value))) {
        throw new Error('Cursor print cannot verify the requested model parameters');
      }
      // This qualified build accepts complete variant selections, not partial
      // overrides. Preserve embedded selections, filling advertised defaults.
      for (const option of values) embedded.set(option.id, option.value!);
      resolvedModel = `${selection[1]}[${[...embedded].sort(([a], [b]) => a.localeCompare(b))
        .map(([id, value]) => `${id}=${value}`).join(',')}]`;
    }
    return { supported: true, model, resolvedModel };
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
