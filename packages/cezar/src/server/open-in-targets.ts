import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Context } from 'hono';
import { imageMimeType, isOsOpenableImage } from '@open-mercato/cezar-contract/image-path';
import { engineOwnsRun } from '@open-mercato/cezar-contract/run-predicates';
import type { RunnerId } from '../core/agent-runner.ts';
import { resolveCursorExecutable } from '../core/cursor-model-catalog.ts';
import { resolveOmpExecutable } from '../core/omp-model-catalog.ts';
import { quoteExecutable } from '../core/shell-env.ts';
import type { RunRecord } from '../runs/store.ts';
import { AgentAccountUnavailableError, resolveProfileEnvForRoot } from '../workspace/agent-profiles.ts';
import { readWorktreePath } from './git-changes.ts';
import type { openFileInDefaultApp, openInApp } from './open-in-app.ts';
import type { openInTerminal } from './open-in-terminal.ts';
import type { resumeCommand } from './server.ts';

interface CliHandoffDeps {
  providerActionError: (required: readonly RunnerId[]) => Promise<string | null>;
  resumeCommand: typeof resumeCommand;
  handoffEnv: (provider: RunnerId, profileId: string | undefined) => Promise<{ env: Record<string, string> } | { error: string }>;
  handoffFallbackCommand: (cwd: string, command: string, env: Record<string, string>) => string | null;
  openTerminal: typeof openInTerminal;
}

/** Open only a contained raster image: the OS launcher does not apply the browser's CSP. */
export async function openRunDefaultApp(
  c: Context,
  run: RunRecord,
  relPath: string | undefined,
  openFile: typeof openFileInDefaultApp,
  NO_WORKTREE: string,
) {
  if (!run.worktreePath || !existsSync(run.worktreePath)) {
    return c.json({ error: NO_WORKTREE }, 409);
  }
  if (!relPath) return c.json({ error: 'path required for the default-app target' }, 400);
  const result = await readWorktreePath(run.worktreePath, relPath);
  if (result.kind !== 'file') {
    return c.json(
      {
        error: result.kind === 'dir' ? `not a file: ${relPath}` : result.error,
      },
      409,
    );
  }
  // This route's whole contract is "preview an image in its default app", and containment
  // alone does not enforce it. Without this gate any regular file in the worktree — a
  // `.command`/`.desktop` an agent just wrote, an `.exe` — would be handed to the OS
  // launcher, which EXECUTES it. Not remotely reachable (random run ids, same-origin, local
  // mode), so: defense in depth.
  //
  // Deliberately `isOsOpenableImage`, NOT the raw route's `imageMimeType`: that list allows
  // SVG on the strength of an `<img>` + no-script CSP the OS launcher never applies (the
  // default `.svg` handler is usually a browser, which would run the file's `<script>`).
  if (!isOsOpenableImage(result.path)) {
    // Say which rule refused, in the route's own words — "limited to images" would be a lie
    // to someone holding an SVG, which IS an image and DOES preview inline.
    return c.json(
      {
        error: imageMimeType(result.path)
          ? `SVG can carry scripts, so it previews inline but is never handed to the OS: ${result.path}`
          : `opening in the default app is limited to images: ${result.path}`,
      },
      409,
    );
  }
  const filePath = join(run.worktreePath, result.path);
  const opened = await openFile(filePath);
  if (!opened) return c.json({ error: `could not open ${result.path}`, path: filePath }, 409);
  return c.json({ opened: true, path: filePath });
}

// Coding-agent CLI handoff (open-mercato/cezar#402): open a terminal in the worktree that resumes
// THIS run's latest session when the chosen CLI owns it (and a session exists), or
// starts a fresh CLI there otherwise. Same terminal launcher the Terminal button uses.
// Records that predate the runner choice carry no `runner` at all — they default to Claude
// everywhere else (resumeCommand, the client's resumeHint/cliTargetResumes), so the match
// check defaults the same way here; without it, a legacy run's own Claude CLI would never
// resume its own session, only ever launch fresh.
// A run the engine still owns never resumes: `sessionId` is seeded when the agent step STARTS
// (workflows/run.ts), so a running/queued/waiting run already carries one, and resuming it
// would attach a SECOND CLI process to the transcript the engine is actively writing. Those
// picks launch the CLI fresh in the worktree — the same degradation as a cross-runner pick,
// and what the client's cliTargetResumes now labels. Resume-after-finish is untouched.
export async function openRunCli(
  c: Context,
  run: RunRecord,
  cliRunner: RunnerId,
  dir: string,
  repoRoot: string,
  { providerActionError, resumeCommand, handoffEnv, handoffFallbackCommand, openTerminal }: CliHandoffDeps,
) {
  const blocked = await providerActionError([cliRunner]);
  if (blocked) return c.json({ error: blocked }, 409);
  // A usage-limit hold has no session until its resume (hearsay-tools/cezarion#1236), so it resumes.
  const sessionStep = engineOwnsRun(run) ? undefined : [...run.steps].reverse().find((s) => s.sessionId);
  const sessionId = sessionStep?.sessionId;
  // An id resumeCommand refuses (open-mercato/cezar#431) degrades to a fresh CLI in the worktree,
  // exactly like a run that never recorded a session.
  const resume = sessionId && cliRunner === (sessionStep?.backend ?? run.runner ?? 'claude') ? resumeCommand(cliRunner, sessionId) : null;
  // Runners with a CEZ_*_BIN override launch the configured binary, not the PATH name.
  const command = resume ?? freshCliCommand(cliRunner);
  if (command === null) {
    return c.json({ error: `the configured ${cliRunner === 'omp' ? 'OMP' : 'Cursor'} executable cannot be used in a terminal command` }, 409);
  }
  // BOTH branches carry the account (spec 2026-07-29-agent-profiles): a resume needs the
  // config dir that holds its session, and a FRESH CLI in this worktree should still open
  // on the account the project works under — otherwise "Open in → Claude CLI" quietly
  // hands the user a different subscription than every task in the same project uses.
  const account = resume
    ? await handoffEnv(cliRunner, sessionStep?.profileId)
    : await resolveProfileEnvForRoot(repoRoot, cliRunner).then(({ env }) => ({ env }), (err: unknown) => {
      if (err instanceof AgentAccountUnavailableError) return { error: err.message };
      throw err;
    });
  if ('error' in account) return c.json({ error: account.error }, 409);
  const fallback = handoffFallbackCommand(dir, command, account.env);
  if (fallback === null) {
    return c.json({ error: 'this account\'s folder cannot be used in a terminal command' }, 409);
  }
  const opened = await openTerminal(dir, command, account.env);
  if (!opened) {
    return c.json({ error: 'no terminal emulator found', command: fallback }, 409);
  }
  return c.json({ opened: true, path: dir, command });
}

/** Resolve only the fresh-launch executable; resume commands keep their own session flags. */
function freshCliCommand(cliRunner: RunnerId): string | null {
  return cliRunner === 'cursor'
    ? quoteExecutable(resolveCursorExecutable(), process.platform)
    : cliRunner === 'omp' ? quoteExecutable(resolveOmpExecutable(), process.platform) : cliRunner;
}

/** Editors, the file manager and a plain terminal all open the same selected directory. */
export async function openRunApp(c: Context, target: string, dir: string, openApp: typeof openInApp) {
  const opened = await openApp(target, dir);
  if (!opened) return c.json({ error: `could not open ${target}`, path: dir }, 409);
  return c.json({ opened: true, path: dir });
}
