import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Keep run data out of the user's repo history; workflows/skills stay committable. Best effort:
 * it never throws. Called before a project's run store opens (#779), so the database and the
 * history backups an open creates are ignored even when that open then fails.
 */
export function ensureDataGitignore(repoRoot: string): void {
  const path = join(repoRoot, '.ai/cezar', '.gitignore');
  const wanted = [
    'runs.json',
    'runs.json.tmp',
    'runs.json.pre-sqlite.bak', // the exact runs.json the run database was imported from (#779)
    'runs.json.pre-sqlite.*', // a second such backup, named by its hash, and their temp files
    'runs.db',
    'runs.db-wal',
    'runs.db-shm',
    'runs/',
    'worktrees/',
    'tmp/', // per-run agent temp directories (#785)
    'todos.json',
    'todos.json.tmp',
    'launch-key',
    'cockpit.lock*',
    'automations.json',
    'automations.json.tmp',
    'automation-state.json',
    'automation-state.json.tmp',
    'automation-receipts.ndjson',
    'automation-receipts.ndjson.tmp',
    'automation-log.ndjson',
    'automation-log.ndjson.tmp',
    'automation-log.lock',
    'automation-log.reclaim*/',
    'automation-poll.lock',
    'automation-poll.reclaim*/',
    'preview/', // live preview: per-task Chromium profile, dev-server logs and pid records (#781)
    'automations.lock',
    'automations.reclaim*/',
    'automation-state.lock',
    'automation-state.reclaim*/',
  ];
  try {
    mkdirSync(join(repoRoot, '.ai/cezar'), { recursive: true });
    const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
    const lines = current.split('\n');
    const missing = wanted.filter((w) => !lines.includes(w));
    if (missing.length > 0) {
      const glue = current && !current.endsWith('\n') ? '\n' : '';
      writeFileSync(path, `${current}${glue}${missing.join('\n')}\n`, 'utf8');
    }
  } catch {
    // non-fatal
  }
}
