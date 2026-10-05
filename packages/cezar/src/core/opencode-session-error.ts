/**
 * OpenCode 1.18.33 skill/index.ts:96-111 catches unreadable optional skills,
 * publishes this unscoped diagnostic, then skips the skill and continues:
 * https://github.com/anomalyco/opencode/blob/v1.18.33/packages/opencode/src/skill/index.ts#L96-L111
 *
 * Only that proven wire shape is recoverable. In particular an absent session
 * ID alone says nothing about severity, and scoped errors remain failures even
 * with the same text. FrontmatterError uses different free-form text upstream;
 * without a distinguishing wire field it must not be guessed recoverable.
 */
export function opencodeSkillWarning(props: Record<string, unknown>): string | undefined {
  if (props.sessionID !== undefined) return undefined;
  const error = record(props.error);
  if (error?.name !== 'UnknownError') return undefined;
  const message = record(error.data)?.message;
  if (typeof message !== 'string' || !/^Failed to parse skill .+[\\/]SKILL\.md$/.test(message)) return undefined;
  return `opencode: optional skill skipped: ${message}. Check that the skill file and any symlink target are readable; repair or reinstall the skill.`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
