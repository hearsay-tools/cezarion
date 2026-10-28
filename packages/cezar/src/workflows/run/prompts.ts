import { dirname } from 'node:path';
import type { ContentBlock } from '../../core/agent-runner.ts';
import type { RunRecord } from '../../runs/store.ts';
import type { Skill } from '../../skills.ts';

/**
 * The effective "extra" system prompt for a run (spec §protocol v2, R2 2.3):
 * the per-run override (`POST /api/runs` `systemPrompt`) REPLACES the
 * `config.json` default — they are the same knob at two scopes, so the more
 * specific one wins outright; they never concatenate. Whichever wins is
 * ADDITIVE to the skill body and the handoff contract, which always ride
 * along (see `composeSystemPrompt`). Blank strings count as unset.
 */
export function resolveExtraSystemPrompt(
  override: string | undefined,
  configDefault: string | undefined,
): string | undefined {
  return override?.trim() || configDefault?.trim() || undefined;
}

/**
 * Joins the parts of one agent step's system prompt in fixed order — skill
 * body (most task-specific), then the run's extra prompt (user guidance, can
 * amend the skill), then the handoff contract (always last, never optional in
 * practice). Blank parts drop out; survivors join with the same `\n\n---\n\n`
 * divider the skill+handoff composition has always used.
 */
export function composeSystemPrompt(...parts: Array<string | undefined>): string {
  return parts
    .map((p) => p?.trim())
    .filter((p): p is string => Boolean(p))
    .join('\n\n---\n\n');
}

/** Compose only at delivery. The durable continuation retains its original text/attachments. */
export function withResumeContext(prompt: string, message: RunRecord['continuationMessage']): string {
  const context = message?.resumeContext;
  if (!context?.failure && !context?.restarted) return prompt;
  const parts: string[] = [];
  if (context.restarted) parts.push('The cezar process restarted while you were working on this task. Read the handoff file (CEZ_HANDOFF_FILE) to recover context.');
  if (context.failure) {
    const { stepId, error } = context.failure;
    // Error messages can contain newlines; keep the diagnostic on one line without changing
    // the saved error, or the human text that follows it.
    parts.push(`The previous ${stepId ? `step ${JSON.stringify(stepId)}` : 'turn'} failed: ${error.replace(/[\r\n\u2028\u2029]+/g, ' ')}`);
  }
  parts.push('Background commands from that session may have stopped; verify their state before restarting them.');
  return `${parts.join(' ')}\n${prompt}`;
}


export function applyTemplate(template: string, task: string): string {
  return template.replaceAll('{{task}}', task);
}

/**
 * Skill identity is context, while the Markdown body remains instructions.
 *
 * For an on-disk skill we also hand the agent the ABSOLUTE directory of the
 * installed copy. A run executes in an isolated worktree that has no local
 * `.agents/skills` (gitignored, absent in a fresh checkout), so without this
 * the agent cannot read the skill's companion files (`references/*.md`) — or,
 * worse, reads a stale copy materialized from the team-repo cache. The path
 * resolves against the MAIN project root (`discoverSkills(repoRoot)`), i.e. the
 * current `npx skills`-installed copy, so a worktree agent and the main
 * checkout read the exact same, up-to-date files. A team skill's `path` is not
 * on disk: its files are materialized per run (`RunManager.provisionRunSkills`).
 * Inside the run's task worktree they need no pointer; a run without one, or
 * whose worktree took no copy, gets a per-commit cache copy, passed here as
 * `teamFilesDir` (#1024). A worktree that took only some of its copies passes
 * the first one it did take.
 */
export function skillSystemPrompt(
  skill: Pick<Skill, 'name' | 'description' | 'body'> & Partial<Pick<Skill, 'path' | 'source'>>,
  teamFilesDir?: string,
): string {
  const lines = [
    `Selected skill: /${skill.name}`,
    ...(skill.description ? [`Description: ${skill.description}`] : []),
  ];
  if (skill.source && skill.source !== 'team' && skill.source !== 'builtin' && skill.path) {
    const dir = dirname(skill.path);
    lines.push(
      '',
      `Skill files are installed on disk at: ${dir}`,
      `Read any file this skill references (for example references/*.md) from that absolute directory. ` +
        `It is the current installed copy — use it even though your working directory is a separate worktree that does not contain the skill.`,
    );
  } else if (skill.source === 'team' && teamFilesDir) {
    lines.push(
      '',
      `Skill files are installed on disk at: ${teamFilesDir}`,
      `Read any file this skill references (for example references/*.md) from that absolute directory. ` +
        `It is a copy of the skill at the commit this run uses.`,
    );
  }
  lines.push('', 'Skill instructions:', skill.body.trim());
  return lines.join('\n');
}

/**
 * Expand a registry-backed slash skill in one prompt string before it reaches a
 * backend. Claude otherwise intercepts an unknown leading slash command, and
 * Codex/OpenCode have no native slash-skill lookup at all (#676).
 *
 * Only a match at character zero counts, and unknown commands pass through
 * byte-for-byte — a backend's OWN slash commands must keep working. The caller
 * persists the original user text before applying this delivery-only rewrite.
 *
 * All delivery seams route through here: live-session messages via
 * `expandRegistrySlashSkill`, and fresh or continuation opening prompts, which
 * become the session's `userPrompt` without passing through `deliverMessage`.
 */
export function expandRegistrySlashSkillText(
  text: string,
  skills: readonly Skill[],
  /** Per team skill, the cache or partial copy its prompt names (#1118). */
  teamFilesDir?: ReadonlyMap<string, string>,
): string {
  const name = leadingSlashSkillName(text);
  if (!name) return text;
  const skill = skills.find((candidate) => candidate.name === name);
  if (!skill) return text;

  const playbook = skillSystemPrompt(skill, teamFilesDir?.get(skill.name));
  const request = text.slice(name.length + 1).trim();
  return request ? `${playbook}\n\nUser request:\n${request}` : playbook;
}

/** The `name` of a prompt's leading `/name` slash command, else undefined. */
export function leadingSlashSkillName(text: string): string | undefined {
  return /^\/([A-Za-z0-9][A-Za-z0-9._-]*)(?=\s|$)/.exec(text)?.[1];
}

/**
 * `expandRegistrySlashSkillText` over a live chat message: only the first text
 * block is eligible, and an unchanged block returns the caller's array
 * identity untouched.
 */
export function expandRegistrySlashSkill(
  content: ContentBlock[],
  skills: readonly Skill[],
): ContentBlock[] {
  const textIndex = content.findIndex((block) => block.type === 'text');
  if (textIndex < 0) return content;
  const block = content[textIndex];
  if (!block || block.type !== 'text') return content;
  const text = expandRegistrySlashSkillText(block.text, skills);
  if (text === block.text) return content;

  const expanded = [...content];
  expanded[textIndex] = { type: 'text', text };
  return expanded;
}
