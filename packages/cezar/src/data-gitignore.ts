import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projectPaths } from './project-paths.ts';
import { projectWriteRefused } from './server/cockpit-ownership.ts';

/**
 * Keep run data out of the user's repo history; workflows/skills stay committable. Best effort:
 * it never throws. Called before a project's run store opens (#779), so the database and the
 * history backups an open creates are ignored even when that open then fails.
 */
export function ensureDataGitignore(repoRoot: string): void {
  const { write, reads } = projectPaths(repoRoot);
  const fallback = reads[1]!;
  if (projectWriteRefused(write)) return;
  const path = join(write, '.gitignore');
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
    'tmp/', // per-run agent temp control directories (#785)
    't/', // per-run agent TMPDIRs, short enough for Chromium's socket (hearsay-tools/cezarion#1022)
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
    'voice/', // voice mode: the local decision log (spec 2026-10-21-voice-mode)
    'automations.lock',
    'automations.reclaim*/',
    'automation-state.lock',
    'automation-state.reclaim*/',
  ];
  try {
    // A tracked copy left in the fallback directory awaits the user's `git mv`: a new file at its
    // destination would make that move fail. The shared excludes below cover both directories.
    const fallbackOnly = existsSync(fallback) && (!existsSync(write) || (!existsSync(path) && existsSync(join(fallback, '.gitignore'))));
    if (!fallbackOnly) {
      mkdirSync(write, { recursive: true });
      const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
      const lines = current.split('\n');
      const missing = wanted.filter((w) => !lines.includes(w));
      if (missing.length > 0) {
        const glue = current && !current.endsWith('\n') ? '\n' : '';
        writeFileSync(path, `${current}${glue}${missing.join('\n')}\n`, 'utf8');
      }
    }
    // Shared Git excludes also cover linked worktrees without adding a tracked input.
    const common = execFileSync('git', ['-C', repoRoot, 'rev-parse', '--git-common-dir'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const sharedPath = join(resolve(repoRoot, common), 'info', 'exclude');
    mkdirSync(join(resolve(repoRoot, common), 'info'), { recursive: true });
    const shared = existsSync(sharedPath) ? readFileSync(sharedPath, 'utf8') : '';
    const sharedRules = [...['cezar', 'squawk'].flatMap(name => wanted.map(rule => `/.ai/${name}/${rule}`)), '/.ai/squawk-migration.json', '/.ai/squawk-migration.lock*'];
    const absent = sharedRules.filter(rule => !shared.split('\n').includes(rule));
    if (absent.length) writeFileSync(sharedPath, `${shared}${shared && !shared.endsWith('\n') ? '\n' : ''}${absent.join('\n')}\n`, 'utf8');
  } catch {
    // non-fatal
  }
}
