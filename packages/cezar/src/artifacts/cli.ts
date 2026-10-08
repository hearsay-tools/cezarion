import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { workspaceConfigPath } from '../paths.ts';
import { loadWorkspaceConfig } from '../workspace/config.ts';
import { artifactDirectory, publishArtifact } from './store.ts';

/** Canonicalize one side of the ownership comparison: the physical path when the directory
 * exists, the lexical `resolve` spelling when it does not (an absent project's storage can
 * still be named by the registry, and it must simply never match). */
function canonicalDirectory(path: string): string {
  try { return realpathSync(path); } catch { return resolve(path); }
}

/** The registry project that owns a run's artifact storage (#925).
 *
 * The comparison is realpath-SYMMETRIC: both the per-project candidate (`<root>/.ai/cezar`,
 * canonicalized by `artifactDirectory` and again here with the run suffix) and the task's
 * artifacts directory are canonicalized before comparing, so a directory spelled through an OS
 * alias (`/var` vs `/private/var`, a symlinked checkout) still names its owner instead of
 * silently degrading to an unscoped, boot-bound link. Exact canonical equality is what keeps a
 * NON-owner project out: a registry entry only matches when its own storage IS this directory. */
export function owningProjectId(
  projects: ReadonlyArray<{ id: string; root: string }>,
  artifactsDir: string,
  runId: string,
): string | undefined {
  return projects.find(project =>
    canonicalDirectory(artifactDirectory(join(project.root, '.ai/cezar'), runId)) === canonicalDirectory(artifactsDir),
  )?.id;
}

const HELP = `Usage: cez artifact publish <path>
Publish an immutable local file snapshot from an active task. Returns JSON
with metadata, a task-relative preview link, and escaped Markdown.

Limits: 10 MiB per file; 64 publications and 64 MiB per task. No old
snapshots are evicted. Requires CEZ_ARTIFACTS_DIR and CEZ_TASK_ID supplied
by the task runner. Never publish credentials or unrelated private files.

-h, --help   Show this help without task context.`;
export async function runArtifactCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0; }
  try {
    if (!env.CEZ_ARTIFACTS_DIR || !env.CEZ_TASK_ID) throw new Error('Artifact task context is missing. Run this command inside an active Cezar task with CEZ_ARTIFACTS_DIR and CEZ_TASK_ID.');
    if (argv.length !== 2 || argv[0] !== 'publish') throw new Error(HELP);
    const metadata = await publishArtifact(env.CEZ_ARTIFACTS_DIR, env.CEZ_TASK_ID, argv[1]!);
    // The task's storage identifies its owner even after an agent changes cwd.
    // Registry discovery is read-only and missing ownership retains legacy links.
    const config = await loadWorkspaceConfig(workspaceConfigPath(env));
    const owner = owningProjectId(config.projects, env.CEZ_ARTIFACTS_DIR!, metadata.runId);
    const prefix = owner ? `/p/${owner}` : '';
    const link = `${prefix}/tasks/${metadata.runId}/files?artifact=${metadata.id}`;
    const label = metadata.name.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_{}\[\]()#+.!|<>~\-]/g, '\\$&');
    console.log(JSON.stringify({ ...metadata, link, markdown: `[${label}](${link})` }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Artifact publication failed' }));
    return 1;
  }
}
