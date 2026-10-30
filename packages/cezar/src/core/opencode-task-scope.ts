import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseConfigContent } from '../agent-config/model-settings/shared.ts';

/** The plugin that keeps a governed session's `task` calls inside its own session tree. */
export const OPENCODE_TASK_SCOPE_PLUGIN = fileURLToPath(new URL('../../scripts/opencode-task-scope.mjs', import.meta.url));

/**
 * Adds the task-scope plugin to the runtime config of a governed OpenCode session
 * (hearsay-tools/cezarion#2279). OpenCode appends runtime `plugin` entries to the ones its
 * config files name, so the user's own plugins keep loading. `env` is the session's extra env
 * so far; a supplied runtime config is read from it first, then from the process env.
 */
export function opencodeTaskScopeEnv(
  env: Record<string, string> | undefined,
  restrict: boolean | undefined,
): Record<string, string> | undefined {
  if (!restrict) return env;
  const supplied = env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
  let config: Record<string, unknown> = {};
  if (supplied) {
    try {
      const parsed: unknown = parseConfigContent(supplied, 'jsonc');
      if (!isObject(parsed) || (parsed.plugin !== undefined && !Array.isArray(parsed.plugin))) throw new Error();
      config = parsed;
    } catch { throw new Error('Cross-task control unavailable: invalid supplied OpenCode runtime configuration'); }
  }
  const plugins = Array.isArray(config.plugin) ? config.plugin : [];
  const entry = pathToFileURL(OPENCODE_TASK_SCOPE_PLUGIN).href;
  return { ...env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, plugin: [...plugins, entry] }) };
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
