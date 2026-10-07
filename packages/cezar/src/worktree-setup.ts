import {
  WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS,
  worktreeSetupConfigSchema,
} from '@open-mercato/cezar-contract';

/**
 * Worktree setup (#917, spec `.ai/specs/2026-10-07-worktree-setup.md`): the commands a project
 * declares in `.ai/cezar/config.json` to prepare a new task or worker worktree before the agent's
 * first turn — a dependency install, generated code, a copied `.env`.
 */

/** What `config.json`'s `worktreeSetup` asks for. */
export type WorktreeSetupPlan =
  | { kind: 'none' }
  | { kind: 'invalid'; issue: string }
  | { kind: 'commands'; commands: string[]; timeoutSeconds: number };

/**
 * Judge the raw `worktreeSetup` value. Absent or `commands: []` is no setup, which keeps a
 * project without the key exactly as it was. A value that does not parse is `invalid` with the
 * first problem, so the run can say why it skipped setup.
 */
export function resolveWorktreeSetup(raw: unknown): WorktreeSetupPlan {
  if (raw === undefined) return { kind: 'none' };
  const parsed = worktreeSetupConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    const path = first?.path.join('.') ?? '';
    const message = first?.message ?? 'invalid value';
    return { kind: 'invalid', issue: path ? `${path}: ${message}` : message };
  }
  if (parsed.data.commands.length === 0) return { kind: 'none' };
  return {
    kind: 'commands',
    commands: parsed.data.commands,
    timeoutSeconds: parsed.data.timeoutSeconds ?? WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS,
  };
}
