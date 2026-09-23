import { mkdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { artifactDirectory } from './store.ts';
import { fileURLToPath } from 'node:url';

/** Generated run-owned location; never let inherited parent session paths leak into a child. */
export function provisionArtifactDirectory(dataDir: string, runId: string): string {
  try {
    const directory = artifactDirectory(dataDir, runId);
    const parent = dirname(directory);
    if (realpathSync(parent) !== parent) return '';
    try { mkdirSync(directory, { mode: 0o700 }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') return '';
    }
    return realpathSync(directory) === directory && statSync(directory).isDirectory() ? directory : '';
  } catch { return ''; }
}

export function removeArtifacts(dataDir: string, runId: string): void {
  const directory = artifactDirectory(dataDir, runId);
  const parent = dirname(directory);
  if (realpathSync(parent) !== parent) throw Error('Artifact storage redirected');
  // rm removes a final symlink itself, never the directory it points at.
  rmSync(directory, { recursive: true, force: true });
}

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
export function artifactInstructions(directory: string | undefined): string {
  if (!directory) return '## Task artifacts\nArtifact storage is unavailable for this task. Do not claim that host files can be downloaded from the cockpit.';
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? '../index.ts' : '../index.js', import.meta.url));
  const command = [process.execPath, ...(source ? ['--import', import.meta.resolve('tsx')] : []), entry].map(quote).join(' ') + ' artifact publish';
  return `## Task artifacts\nTo let the user review a file outside the project, explicitly publish a snapshot with ${command} '<path>'. The command uses CEZ_ARTIFACTS_DIR and CEZ_TASK_ID from this session and returns JSON with a Markdown link. Include that returned link in your response. Project files can be linked by path and open inside the cockpit. Publish only intended deliverables, never credentials or unrelated private files. Limits: 10 MiB per file, 64 publications and 64 MiB per task. Snapshots survive worktree cleanup until task history is deleted. Publication is explicit, not automatic; files are not shared just because you mention their path.`;
}
