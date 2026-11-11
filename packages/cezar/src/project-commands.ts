import { markFreshProject } from './project-migration/fresh.ts';
import { noticeLegacyProject, projectPaths } from './project-paths.ts';
import { fallbackWorkflowPath } from './workflows/load.ts';
import { fallbackSkillPath } from './skills.ts';
import { commandText } from './home/command.ts';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { armRepoHandle } from './runs/arm-repo-handle.ts';
import { RunStore } from './runs/store.ts';
import { ensureDataGitignore } from './data-gitignore.ts';
import { admittedWrite } from './server/cockpit-ownership.ts';

/**
 * CLI commands that write a project's data directory, kept apart from `index.ts` (which runs the
 * CLI on import) so tests can drive them. Each re-checks the migration fence right before its
 * first project write.
 */

/** `cez init`: scaffold the starter workflow and skill. */
export async function initCommand(repoRoot: string): Promise<void> {
  const workflowsDir = join(projectPaths(repoRoot).write, 'workflows');
  const skillsDir = join(projectPaths(repoRoot).write, 'skills');
  const dataDir = projectPaths(repoRoot).write;
  admittedWrite(dataDir, () => { markFreshProject(repoRoot); mkdirSync(workflowsDir, { recursive: true }); mkdirSync(skillsDir, { recursive: true }); });

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
      // The fallback lookup awaited: a fence may have been taken since the last check.
      admittedWrite(dataDir, () => writeFileSync(example.path, example.content, 'utf8'));
      console.log(`  + ${example.path}`);
    }
  }
  admittedWrite(dataDir, () => ensureDataGitignore(repoRoot));
  console.log(commandText('\nDone. Start the cockpit with: npx cezarion'));
}

/** The project's run store, at the start of a process: a busy database is waited out
 *  (`retryBusy`), and a store that cannot open throws its `RunStoreOpenError`. */
export function openStore(repoRoot: string, opts?: { keepLive?: boolean; repoHandleSignal?: AbortSignal }): RunStore {
  noticeLegacyProject(repoRoot);
  const dataDir = projectPaths(repoRoot).write;
  // First: an open that fails may already have created the database and the history backups.
  // No await between the check and the open; later store writes pass the store's own backstop.
  const store = admittedWrite(dataDir, () => {
    markFreshProject(repoRoot);
    ensureDataGitignore(repoRoot);
    return RunStore.open(dataDir, { keepLive: opts?.keepLive, retryBusy: true });
  });
  // Repo-scope the referenced tier (#945) — see `armRepoHandle`. Background, never awaited: a
  // `gh`-less or offline machine keeps working exactly as it did, just unscoped.
  armRepoHandle(store, repoRoot, opts?.repoHandleSignal);
  return store;
}
