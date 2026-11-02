import type { SetConfigInput } from '@open-mercato/cezar-contract/workspace';

type RawConfig = Record<string, unknown>;
type ApplyField = (raw: RawConfig, body: SetConfigInput) => void;

/** Undefined leaves a key alone; each field supplies its existing clear sentinels. */
function applyValue(raw: RawConfig, key: string, value: unknown, clear: readonly unknown[] = [null]): void {
  if (value === undefined) return;
  if (clear.includes(value)) delete raw[key];
  else raw[key] = value;
}

function applyWorktreeSetup(raw: RawConfig, body: SetConfigInput): void {
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
  // Per-runner merge preserves presets and unknown keys from the existing file.
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
  systemPrompt: (raw, body) => applyValue(raw, 'systemPrompt', body.systemPrompt, [null, '']),
  maxParallel: (raw, body) => applyValue(raw, 'maxParallel', body.maxParallel),
  worktreeRetention: (raw, body) => applyValue(raw, 'worktreeRetention', body.worktreeRetention),
  liveTitleUpdates: (raw, body) => applyValue(raw, 'liveTitleUpdates', body.liveTitleUpdates),
  archiveOnMerge: (raw, body) => applyValue(raw, 'archiveOnMerge', body.archiveOnMerge),
  reviewGate: (raw, body) => applyValue(raw, 'reviewGate', body.reviewGate),
  memoryLimitMb: (raw, body) => applyValue(raw, 'memoryLimitMb', body.memoryLimitMb, [null, 0]),
  worktreeSetup: applyWorktreeSetup,
  defaultModels: applyDefaultModels,
} satisfies Record<keyof SetConfigInput, ApplyField>;

/** Merge parsed config fields without materializing defaults or mutating either input. */
export function mergeConfig(raw: RawConfig, body: SetConfigInput): RawConfig {
  const next = { ...raw };
  for (const apply of Object.values(fieldAppliers)) apply(next, body);
  return next;
}
