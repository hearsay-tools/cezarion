#!/usr/bin/env node
import { noticeLegacyProject, projectPaths } from './project-paths.ts';
import { fallbackWorkflowPath } from './workflows/load.ts';
import { fallbackSkillPath } from './skills.ts';
import { commandText } from './home/command.ts';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { armRepoHandle } from './runs/arm-repo-handle.ts';
import { RunStore } from './runs/store.ts';
import { RunStoreOpenError } from './runs/store-open-error.ts';
import { ensureDataGitignore } from './data-gitignore.ts';
import { warnLegacyEnv } from './home/deprecation.ts';
import { resolveHome } from './home/resolve.ts';
import type { Home } from './home/home.ts';
import { runMigrations } from './workspace/migrations.ts';
import { registerProject, shouldRegisterProject } from './workspace/projects.ts';
import { main, defaultCliDeps } from './cli-dispatch.ts';
import { serverCommand } from './server-command.ts';
import { runHeadless, defaultHeadlessDeps, type TaskAccess } from './headless-run.ts';
import { serveCommand, defaultServeDeps } from './serve-command.ts';
import { onTerminal } from './serve-listener.ts';

warnLegacyEnv(process.env);

// ---- workspace boot ----------------------------------------------------------

/**
 * Boot-time workspace bookkeeping (spec 2026-07-20-multi-project-workspace,
 * "Boot flow"): run pending `~/.cezar` migrations first, then register the
 * boot repo in the per-user project registry. Registration is suppressed for
 * task worktrees and `$HOME` itself (`shouldRegisterProject`) — the process
 * still serves those folders normally. Strictly non-fatal: the zero-config
 * law says a broken or read-only home degrades to a smaller cockpit, never a
 * failed boot, so any workspace error logs one warning and boot continues.
 *
 * Returns the boot project's registry id when registration happened —
 * `serveCommand` plumbs it into the server (`ServerDeps.bootProjectId`) so
 * `/api/projects` and `/api/v1/health` can name the boot project without a
 * lookup. Undefined when registration was suppressed or the workspace is
 * unavailable; the server then derives a fallback on its own.
 */
async function initWorkspace(repoRoot: string, home: Home): Promise<string | undefined> {
  try {
    await runMigrations({ bootRepoRoot: repoRoot, home });
    if (await shouldRegisterProject(repoRoot)) return (await registerProject(repoRoot, 'local', home)).id;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`[cez] workspace registry unavailable (${message}) — continuing without it`);
  }
  return undefined;
}

// ---- run (headless) ----------------------------------------------------------

/**
 * The "a cockpit is running" hint for headless `run` (task-cli/hint.ts). Loaded lazily, never
 * awaited: discovery overlaps the run (hearsay-tools/cezarion#1039), and the returned stop
 * abandons it when the run ends, so it can neither delay the run nor keep the process alive.
 */
function hintRunningCockpit(repoRoot: string): () => void {
  let stopped = false;
  let stop: (() => void) | undefined;
  void import('./task-cli/hint.ts').then(({ startCockpitHint }) => {
    if (!stopped) stop = startCockpitHint(repoRoot);
  }, () => { /* best effort */ });
  return () => { stopped = true; stop?.(); };
}

async function runCommand(
  home: Home,
  repoRoot: string,
  task: string,
  workflowName: string | undefined,
  model: string | undefined,
  access: TaskAccess,
): Promise<void> {
  if (!task) {
    console.error(commandText('usage: cez run "<task>" [--workflow name] [--model model] [--no-workers] [--no-messaging]'));
    process.exitCode = 1;
    return;
  }
  const stopHint = hintRunningCockpit(repoRoot);
  try {
    await runHeadless(home, repoRoot, task, workflowName, model, access, { ...defaultHeadlessDeps, initWorkspace, openStore, onTerminal });
  } finally {
    stopHint();
  }
}

// ---- init --------------------------------------------------------------------

async function initCommand(repoRoot: string): Promise<void> {
  const workflowsDir = join(projectPaths(repoRoot).write, 'workflows');
  const skillsDir = join(projectPaths(repoRoot).write, 'skills');
  mkdirSync(workflowsDir, { recursive: true });
  mkdirSync(skillsDir, { recursive: true });

  const examples: Array<{ path: string; fallback: () => Promise<string | undefined>; content: string }> = [
    {
      path: join(workflowsDir, 'fix-and-verify.yaml'),
      fallback: () => fallbackWorkflowPath(repoRoot, 'fix-and-verify'),
      content: `name: fix-and-verify
description: Implement the task, then run your test command; on failure the agent retries with the failing output.
steps:
  - id: implement
    name: Implement
    prompt: "{{task}}"
  - id: verify
    name: Verify
    command: "echo 'replace me with: npm test / yarn test / pytest'"
    onFail:
      retry: implement
      max: 2
`,
    },
    {
      path: join(skillsDir, 'project-conventions.md'),
      fallback: () => fallbackSkillPath(repoRoot, 'project-conventions'),
      content: `---
name: project-conventions
description: House rules the agent should follow in this repo.
---

# Project conventions

- Describe your stack, style and testing conventions here.
- Reference this skill from a workflow step via \`skill: project-conventions\`.
`,
    },
  ];

  for (const example of examples) {
    // A starter with the same name under .ai/squawk/ is the user's: a legacy copy would hide it.
    const fallback = existsSync(example.path) ? undefined : await example.fallback();
    if (existsSync(example.path)) {
      console.log(`  = ${example.path} (exists, left untouched)`);
    } else if (fallback) {
      console.log(`  = ${fallback} (exists, left untouched)`);
    } else {
      writeFileSync(example.path, example.content, 'utf8');
      console.log(`  + ${example.path}`);
    }
  }
  ensureDataGitignore(repoRoot);
  console.log(commandText('\nDone. Start the cockpit with: npx cezarion'));
}

// ---- helpers -----------------------------------------------------------------

/** The project's run store, at the start of a process: a busy database is waited out
 *  (`retryBusy`), and a store that cannot open throws its `RunStoreOpenError`. */
function openStore(repoRoot: string, opts?: { keepLive?: boolean; repoHandleSignal?: AbortSignal }): RunStore {
  noticeLegacyProject(repoRoot);
  const dataDir = projectPaths(repoRoot).write;
  // First: an open that fails may already have created the database and the history backups.
  ensureDataGitignore(repoRoot);
  const store = RunStore.open(dataDir, { keepLive: opts?.keepLive, retryBusy: true });
  // Repo-scope the referenced tier (#945) — see `armRepoHandle`. Background, never awaited: a
  // `gh`-less or offline machine keeps working exactly as it did, just unscoped.
  armRepoHandle(store, repoRoot, opts?.repoHandleSignal);
  return store;
}

/**
 * The boot project's store for `serve` (#779, plan step 4). One that cannot open does not stop the
 * cockpit: the boot project answers every route with the reason (`RunStore.unavailable`), the
 * other projects work, and a restart once the cause is gone opens it.
 */
function openBootStore(repoRoot: string): RunStore {
  try {
    return openStore(repoRoot, { keepLive: true });
  } catch (error) {
    if (!(error instanceof RunStoreOpenError)) throw error;
    console.error(`\n  ✗ ${error.message}\n`);
    return RunStore.unavailable(projectPaths(repoRoot).write, error);
  }
}

/** Own package name — for the npm-registry update check (#368). */
function readOwnName(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { name?: string };
    return pkg.name ?? '@wjarka/cezarion';
  } catch {
    return '@wjarka/cezarion';
  }
}

function readOwnVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

main({
  ...defaultCliDeps, resolveCliHome: () => resolveHome({ purpose: 'cli' }), readOwnName, readOwnVersion, runCommand, initCommand, initWorkspace, serverCommand,
  serveCommand: (...args) => serveCommand(...args, { ...defaultServeDeps, initWorkspace, openBootStore, readOwnName, readOwnVersion }),
}).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
