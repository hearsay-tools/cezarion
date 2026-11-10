import { productName } from '../home/display.ts';
import { commandText } from '../home/command.ts';
import { productEnv } from '../core/product-env.ts';
import { dirname } from 'node:path';
import { publishArtifact } from './store.ts';
import { assertProjectAdmitted } from '../server/cockpit-ownership.ts';

const HELP = commandText(`Usage: cez artifact publish <path>
Publish an immutable local file snapshot from an active task. Returns JSON
with metadata, a task-relative preview link, and escaped Markdown.

Limits: 10 MiB per file; 64 publications and 64 MiB per task. No old
snapshots are evicted. Requires CEZ_ARTIFACTS_DIR and CEZ_TASK_ID supplied
by the task runner. Never publish credentials or unrelated private files.

-h, --help   Show this help without task context.`);
export async function runArtifactCommand(argv: string[], env: NodeJS.ProcessEnv): Promise<number> {
  if (argv.includes('--help') || argv.includes('-h')) { console.log(HELP); return 0; }
  try {
    const artifactsDir = productEnv('ARTIFACTS_DIR', env), taskId = productEnv('TASK_ID', env);
    if (!artifactsDir || !taskId) throw new Error(`Artifact task context is missing. Run this command inside an active ${productName('Cezar')} task with CEZ_ARTIFACTS_DIR and CEZ_TASK_ID.`);
    if (argv.length !== 2 || argv[0] !== 'publish') throw new Error(HELP);
    // `<dataDir>/runs/<task>-artifacts`: a project under a migration fence takes no write.
    assertProjectAdmitted(dirname(dirname(artifactsDir)));
    const metadata = await publishArtifact(artifactsDir, taskId, argv[1]!);
    const prefix = productEnv('PROJECT_ID', env) ? `/p/${productEnv('PROJECT_ID', env)}` : '';
    const link = `${prefix}/tasks/${metadata.runId}/files?artifact=${metadata.id}`;
    const label = metadata.name.replace(/[\r\n\u0000-\u001f\u007f]/g, ' ').replace(/[\\`*_{}[\]()#+.!|<>~-]/g, '\\$&');
    console.log(JSON.stringify({ ...metadata, link, markdown: `[${label}](${link})` }));
    return 0;
  } catch (error) {
    console.error(JSON.stringify({ error: error instanceof Error ? error.message : 'Artifact publication failed' }));
    return 1;
  }
}
