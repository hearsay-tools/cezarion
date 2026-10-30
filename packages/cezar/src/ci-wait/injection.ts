import type { AgentRunSpec } from '../core/agent-runner.ts';
import { isObject, suppliedOpenCodeConfig } from '../core/opencode-runtime-config.ts';

/** Runtime config has highest precedence; merge only our collision-resistant server. */
export function ciOpenCodeEnv(spec: AgentRunSpec): Record<string, string> | undefined {
  if (!spec.cezarTools) return spec.env;
  const config = suppliedOpenCodeConfig(spec.env, 'mcp', isObject, 'CI tool unavailable: invalid supplied OpenCode runtime configuration');
  const { name, command, args } = spec.cezarTools;
  const existing = isObject(config.mcp) ? config.mcp : {};
  if (Object.hasOwn(existing, name)) throw new Error('CI tool unavailable: OpenCode server name collision');
  return { ...spec.env, OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...config, mcp: { ...existing, [name]: { type: 'local', command: [command, ...args], enabled: true } } }) };
}
