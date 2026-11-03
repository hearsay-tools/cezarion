import type { SetConfigInput } from '@open-mercato/cezar-contract/workspace';
import { updateConfigFile } from '../config.ts';

type RawConfig = Record<string, unknown>;
type ApplyField = (raw: RawConfig, body: SetConfigInput) => void;

/** Undefined leaves a key alone; each field supplies its existing clear sentinels. */
function applyValue(raw: RawConfig, key: string, value: unknown, clear: readonly unknown[] = [null]): void {
  if (value === undefined) return;
  if (clear.includes(value)) delete raw[key];
  else raw[key] = value;
}

function applyWorktreeSetup(raw: RawConfig, body: SetConfigInput): void {
  // null or no commands = no setup: delete the key rather than store an empty list.
  const setup = body.worktreeSetup;
  if (setup === undefined) return;
  if (setup === null || setup.commands.length === 0) delete raw.worktreeSetup;
  else raw.worktreeSetup = {
    commands: setup.commands,
    ...(setup.timeoutSeconds !== undefined ? { timeoutSeconds: setup.timeoutSeconds } : {}),
  };
}

function applyDefaultModels(raw: RawConfig, body: SetConfigInput): void {
  if (body.defaultModels === undefined) return;
  // Per-runner merge, so setting codex's preset never clobbers claude's.
  // Unknown keys from the existing file survive too.
  const current = raw.defaultModels && typeof raw.defaultModels === 'object'
    ? { ...(raw.defaultModels as RawConfig) }
    : {};
  for (const [runner, model] of Object.entries(body.defaultModels)) {
    applyValue(current, runner, model, [null, '']);
  }
  if (Object.keys(current).length === 0) delete raw.defaultModels;
  else raw.defaultModels = current;
}

// Keep the old field order, including insertion order in the serialized config.
const fieldAppliers = {
  baseBranch: (raw, body) => applyValue(raw, 'baseBranch', body.baseBranch),
  defaultRunner: (raw, body) => applyValue(raw, 'defaultRunner', body.defaultRunner),
  // '' and null both clear: an emptied textarea means "no extra prompt".
  systemPrompt: (raw, body) => applyValue(raw, 'systemPrompt', body.systemPrompt, [null, '']),
  maxParallel: (raw, body) => applyValue(raw, 'maxParallel', body.maxParallel),
  // null clears back to the default (10); a number (including 0 = unlimited)
  // is stored as-is.
  worktreeRetention: (raw, body) => applyValue(raw, 'worktreeRetention', body.worktreeRetention),
  liveTitleUpdates: (raw, body) => applyValue(raw, 'liveTitleUpdates', body.liveTitleUpdates),
  archiveOnMerge: (raw, body) => applyValue(raw, 'archiveOnMerge', body.archiveOnMerge),
  reviewGate: (raw, body) => applyValue(raw, 'reviewGate', body.reviewGate),
  // null or 0 both mean "no ceiling" — drop the key back to the default.
  memoryLimitMb: (raw, body) => applyValue(raw, 'memoryLimitMb', body.memoryLimitMb, [null, 0]),
  worktreeSetup: applyWorktreeSetup,
  defaultModels: applyDefaultModels,
} satisfies Record<keyof SetConfigInput, ApplyField>;

/** Merge parsed config fields without materializing defaults or mutating either input. */
export function mergeConfig(raw: RawConfig, body: SetConfigInput): RawConfig {
  // The reader accepts arrays too; preserve their JSON serialization behavior.
  const next: RawConfig = Array.isArray(raw) ? Object.assign([...raw], raw) : { ...raw };
  for (const apply of Object.values(fieldAppliers)) apply(next, body);
  return next;
}

/**
 * `PUT /config`'s write: merge `body` into the project's `config.json` under the config lock.
 * A file only the schema refuses is merged into. One that is not a JSON object is never
 * overwritten, since the user's keys in it would be lost: the answer is why it cannot be read.
 */
export function writeMergedConfig(dataDir: string, body: SetConfigInput): Promise<string | undefined> {
  return updateConfigFile<string | undefined>(dataDir, (current) =>
    current.raw ? { write: mergeConfig(current.raw, body), result: undefined } : { refuse: current.ok ? undefined : current.issue });
}
