import { unlink } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { projectPaths } from '../project-paths.ts';
import { fallbackWorkflowPath, loadWorkflows } from '../workflows/load.ts';

type DeletedWorkflow = { path: string } | { error: string; status: 400 | 404 | 409 | 500 };
/** Delete only file workflows under the write root; a fallback name would reappear without a tombstone. */
export async function deleteSavedWorkflow(repoRoot: string, name: string): Promise<DeletedWorkflow> {
  const fallback = await fallbackWorkflowPath(repoRoot, name);
  if (fallback) return { error: `Cannot delete read-only project data in ${fallback}. Use the binary that migrated the project.`, status: 409 };
  const { workflows } = await loadWorkflows(repoRoot);
  const workflow = workflows.find(item => item.name === name);
  if (!workflow) return { error: `unknown workflow: ${name}`, status: 404 };
  if (workflow.source !== 'file' || !workflow.path) return { error: 'built-in workflows cannot be deleted', status: 400 };
  const target = resolve(workflow.path);
  if (!target.startsWith(resolve(projectPaths(repoRoot).write, 'workflows') + sep)) return { error: 'refusing to delete a file outside the workflows dir', status: 400 };
  try { await unlink(target); }
  catch (error) { return { error: error instanceof Error ? error.message : String(error), status: 500 }; }
  return { path: target };
}
