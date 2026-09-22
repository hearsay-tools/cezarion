import { parseConfigContent } from '../agent-config/model-settings/shared.ts';
import type { AgentRunSpec } from '../core/agent-runner.ts';

/** Runtime config has highest precedence; merge only our collision-resistant server. */
export function ciOpenCodeEnv(spec: AgentRunSpec): Record<string, string> | undefined {
  if (!spec.cezarTools) return spec.env;
  const supplied = spec.env?.OPENCODE_CONFIG_CONTENT ?? process.env.OPENCODE_CONFIG_CONTENT;
  let config: Record<string, unknown> = {};
  if (supplied) {
    try {
      const parsed: unknown = parseConfigContent(supplied, 'jsonc');
      if (!isObject(parsed) || (parsed.mcp !== undefined && !isObject(parsed.mcp))) throw new Error();
      config = parsed;
    } catch { throw new Error('CI tool unavailable: invalid supplied OpenCode runtime configuration'); }
  }
  const { name, command, args } = spec.cezarTools;
  const existing = isObject(config.mcp) ? config.mcp : {};
  if (Object.hasOwn(existing, name)) throw new Error('CI tool unavailable: OpenCode server name collision');
  return { ...spec.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, mcp: { ...existing, [name]: { type: 'local', command: [command, ...args], enabled: true } } }) };
}
function isObject(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
