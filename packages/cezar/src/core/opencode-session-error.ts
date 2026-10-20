/**
 * OpenCode's skill loader catches a skill it cannot load, publishes an
 * unscoped `UnknownError` session.error, then skips the skill and continues
 * (1.18.35 skill/index.ts:105-116):
 * https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/skill/index.ts#L105-L116
 * The message is `Failed to parse skill <path>` for an unreadable file
 * (hearsay-tools/cezarion#723, captured on 1.18.33), or the FrontmatterError
 * text from config/markdown.ts:20-34,
 * `<path>: Failed to parse YAML frontmatter: <parser detail>`:
 * https://github.com/anomalyco/opencode/blob/v1.18.35/packages/opencode/src/config/markdown.ts#L20-L34
 * A 2026-10-18 reproduction on OpenCode 1.18.35 (hearsay-tools/cezarion#1265)
 * showed the turn going on to answer after that frontmatter frame.
 *
 * Only those proven wire shapes are recoverable, and only for a `SKILL.md` path
 * at the start of the message. In particular an absent session ID alone says
 * nothing about severity, scoped errors remain failures even with the same text,
 * and every other unscoped error stays fatal.
 */
export function opencodeSkillWarning(props: Record<string, unknown>): string | undefined {
  if (props.sessionID !== undefined) return undefined;
  const error = record(props.error);
  if (error?.name !== 'UnknownError') return undefined;
  const message = record(error.data)?.message;
  if (typeof message !== 'string') return undefined;
  if (/^Failed to parse skill .+[\\/]SKILL\.md$/.test(message))
    return `opencode: optional skill skipped: ${message}. Check that the skill file and any symlink target are readable; repair or reinstall the skill.`;
  const frontmatter = /^(.+?[\\/]SKILL\.md): Failed to parse YAML frontmatter: ([\s\S]*)$/.exec(message);
  if (!frontmatter) return undefined;
  const [, path, rawDetail = ''] = frontmatter;
  // The parser detail ends in a multi-line caret excerpt; keep the note one line.
  const detail = rawDetail.replace(/\s+/g, ' ').trim();
  return `opencode: optional skill skipped: ${path} has invalid YAML frontmatter${detail ? ` (${detail})` : ''}. Fix the frontmatter between the --- lines, for example by quoting values that contain a colon or a quote, or remove the skill.`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}
