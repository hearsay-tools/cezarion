import {
  WORKTREE_SETUP_DEFAULT_TIMEOUT_SECONDS,
  worktreeSetupConfigSchema,
} from '@open-mercato/cezar-contract';
import { buildCommandEnv } from './core/agent-env.ts';
import { runGroupedCommand } from './workflows/grouped-command.ts';

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

/** Output kept per command: the tail, because an install reports its error at the end. */
const OUTPUT_CAP = 20_000;
/** How much of a failed command's output the agent is shown. */
const AGENT_OUTPUT_CHARS = 4_000;
/** Commands are shortened to this many characters in notes. */
const NOTE_COMMAND_CHARS = 120;
const CONFIG_LABEL = 'worktreeSetup in .ai/cezar/config.json';
const MISSING_HINT = 'Dependencies or generated files may be missing. Fix the cause or run the setup yourself before tests or builds.';

export interface WorktreeSetupCommandResult {
  command: string;
  exitCode: number | null;
  timedOut: boolean;
  durationMs: number;
  output: string;
  spawnError?: string;
}

export type WorktreeSetupOutcome =
  | { status: 'done'; commands: string[]; durationMs: number }
  | {
      status: 'failed';
      reason: 'exit' | 'timeout' | 'spawn';
      failed: WorktreeSetupCommandResult;
      /** The commands after the failed one, which did not run. */
      skipped: string[];
      timeoutSeconds: number;
      durationMs: number;
    }
  | { status: 'stopped'; durationMs: number }
  | { status: 'invalid'; issue: string };

/**
 * Run the commands in order in `cwd`, stopping at the first one that fails, times out or cannot
 * start, or when the run is cancelled. Never throws: every way it ends is an outcome.
 */
export async function runWorktreeSetup(opts: {
  plan: Extract<WorktreeSetupPlan, { kind: 'commands' }>;
  cwd: string;
  env: NodeJS.ProcessEnv;
  setInterrupt: (stop: () => void) => void;
  isCancelled: () => boolean;
  onCommandResult: (result: WorktreeSetupCommandResult) => void;
}): Promise<WorktreeSetupOutcome> {
  const { plan, cwd, env, setInterrupt, isCancelled, onCommandResult } = opts;
  const started = Date.now();
  for (const [index, command] of plan.commands.entries()) {
    if (isCancelled()) return { status: 'stopped', durationMs: Date.now() - started };
    const commandStarted = Date.now();
    const result = await runGroupedCommand({
      command,
      cwd,
      env,
      setInterrupt,
      timeoutMs: plan.timeoutSeconds * 1000,
      keep: 'tail',
      cap: OUTPUT_CAP,
    });
    const commandResult: WorktreeSetupCommandResult = {
      command,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
      durationMs: Date.now() - commandStarted,
      output: result.output,
      ...(result.spawnError !== undefined ? { spawnError: result.spawnError } : {}),
    };
    onCommandResult(commandResult);
    if (isCancelled()) return { status: 'stopped', durationMs: Date.now() - started };
    const reason = result.spawnError !== undefined ? 'spawn' : result.timedOut ? 'timeout' : result.exitCode !== 0 ? 'exit' : undefined;
    if (reason) {
      return {
        status: 'failed',
        reason,
        failed: commandResult,
        skipped: plan.commands.slice(index + 1),
        timeoutSeconds: plan.timeoutSeconds,
        durationMs: Date.now() - started,
      };
    }
  }
  return { status: 'done', commands: plan.commands, durationMs: Date.now() - started };
}

/**
 * The environment setup commands run with: the curated host-command env the live preview gives a
 * dev server (no backend auth, no `gh` token; `CEZ_ENV_PASSTHROUGH` still applies), the run's own
 * temp directory, its task id, and the project root so a command can copy an untracked `.env`.
 */
export function worktreeSetupEnv(opts: {
  projectRoot: string;
  runId: string;
  tmpEnv: Record<string, string>;
  source?: NodeJS.ProcessEnv;
}): NodeJS.ProcessEnv {
  return buildCommandEnv({
    extraEnv: { ...opts.tmpEnv, CEZ_TASK_ID: opts.runId, CEZ_PROJECT_ROOT: opts.projectRoot },
    ...(opts.source ? { source: opts.source } : {}),
  });
}

export function formatSetupDuration(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function shortCommand(command: string): string {
  return command.length > NOTE_COMMAND_CHARS ? `${command.slice(0, NOTE_COMMAND_CHARS - 1)}…` : command;
}

const quoted = (command: string) => `\`${shortCommand(command)}\``;

/** "`npm ci` exited 1 after 12s" — the shared phrase of the end note and the agent note. */
function failurePhrase(outcome: Extract<WorktreeSetupOutcome, { status: 'failed' }>): string {
  const command = quoted(outcome.failed.command);
  if (outcome.reason === 'timeout') return `${command} timed out after ${outcome.timeoutSeconds}s`;
  if (outcome.reason === 'spawn') return `${command} could not start (${outcome.failed.spawnError ?? 'unknown error'})`;
  return `${command} exited ${outcome.failed.exitCode} after ${formatSetupDuration(outcome.failed.durationMs)}`;
}

export function worktreeSetupStartNote(commandCount: number): string {
  return `preparing the worktree — ${commandCount} command${commandCount === 1 ? '' : 's'} from ${CONFIG_LABEL}`;
}

export function worktreeSetupEndNote(outcome: WorktreeSetupOutcome): string {
  switch (outcome.status) {
    case 'done': return `worktree setup done in ${formatSetupDuration(outcome.durationMs)}`;
    case 'failed': return `worktree setup failed — ${failurePhrase(outcome)}; starting the agent anyway`;
    case 'stopped': return 'worktree setup stopped';
    case 'invalid': return `worktree setup skipped — ${CONFIG_LABEL} is invalid (${outcome.issue})`;
  }
}

/** A fence longer than any backtick run in `text`, so command output cannot close it early. */
function fenced(text: string): string {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = '`'.repeat(Math.max(3, longest + 1));
  return `${fence}text\n${text}\n${fence}`;
}

/**
 * The paragraph appended to the agent's opening message. On success it stops the agent repeating
 * the install a repo's own instructions ask for; on failure it carries what went wrong. A stopped
 * setup has no agent to tell.
 */
export function worktreeSetupAgentNote(outcome: WorktreeSetupOutcome): string | undefined {
  switch (outcome.status) {
    case 'done':
      return `Cezar prepared this worktree before your session started: ${outcome.commands.map(quoted).join(', ')} (${formatSetupDuration(outcome.durationMs)}). Dependencies are installed; do not repeat this setup.`;
    case 'failed': {
      const skipped = outcome.skipped.length
        ? ` The remaining commands did not run: ${outcome.skipped.map(quoted).join(', ')}.`
        : '';
      return `Cezar's worktree setup did not complete before your session started: ${failurePhrase(outcome)}.${skipped}\n\nIts last output:\n\n${fenced(outcome.failed.output.slice(-AGENT_OUTPUT_CHARS))}\n\n${MISSING_HINT}`;
    }
    case 'invalid':
      return `Cezar's worktree setup did not run: ${CONFIG_LABEL} is invalid (${outcome.issue}). ${MISSING_HINT}`;
    case 'stopped':
      return undefined;
  }
}

/** The one-line `RunRecord.worktreeSetup.error`; undefined when setup succeeded. */
export function worktreeSetupRecordError(outcome: WorktreeSetupOutcome): string | undefined {
  switch (outcome.status) {
    case 'done': return undefined;
    case 'stopped': return 'stopped';
    case 'invalid': return `invalid config: ${outcome.issue}`;
    case 'failed': {
      const command = quoted(outcome.failed.command);
      if (outcome.reason === 'timeout') return `${command} timed out after ${outcome.timeoutSeconds}s`;
      if (outcome.reason === 'spawn') return `${command} could not start: ${outcome.failed.spawnError ?? 'unknown error'}`;
      return `${command} exited ${outcome.failed.exitCode}`;
    }
  }
}
