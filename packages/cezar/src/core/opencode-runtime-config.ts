import { parseConfigContent } from '../agent-config/model-settings/shared.ts';

/**
 * The OpenCode runtime config a session already carries (`OPENCODE_CONFIG_CONTENT`), read from
 * its extra env first, then the process env; `{}` when none is supplied. cezar merges its own
 * entries into it, and OpenCode gives this config precedence over its config files. Throws
 * `error` when the supplied text is not a JSONC object, or when `field` is present and fails
 * `valid`.
 */
export function suppliedOpenCodeConfig(
  env: Record<string, string> | undefined,
  field: string,
  valid: (value: unknown) => boolean,
  error: string,
): Record<string, unknown> {
  const supplied = env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
  if (!supplied) return {};
  try {
    const parsed: unknown = parseConfigContent(supplied, 'jsonc');
    if (!isObject(parsed) || (parsed[field] !== undefined && !valid(parsed[field]))) throw new Error();
    return parsed;
  } catch { throw new Error(error); }
}

export function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
