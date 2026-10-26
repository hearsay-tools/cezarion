import type { ToolGrant } from './agent-runner.ts';

/**
 * The grant for a test spec that does not test tool access: no list, which is what a spec
 * without `allowedTools` sent before hearsay-tools/cezarion#1810. Runs never pass it by
 * default; each builder resolves its own grant.
 */
export const UNSET_TOOL_GRANT: ToolGrant = { kind: 'unset' };

/** A hand-written list, as a step's own `allowedTools` resolves; `bashAllowlist` rides with it. */
export function explicitToolGrant(tools: readonly string[], bashAllowlist?: readonly string[]): ToolGrant {
  return bashAllowlist === undefined ? { kind: 'explicit', tools } : { kind: 'explicit', tools, bashAllowlist };
}
