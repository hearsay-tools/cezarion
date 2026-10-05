import { dirname } from 'node:path';

import { LegacyWriterError } from './legacy-index.ts';
import { RunDatabaseError, RunDatabaseUnsupportedSchemaError, type RunDatabaseErrorKind } from './run-database.ts';

/** Why a project's run store could not be opened (#779, plan step 4). */
export type RunStoreOpenErrorKind = Exclude<RunDatabaseErrorKind, 'conflict'> | 'legacy-writer';

/**
 * A project's run store could not be opened, so there is no store: nothing about its runs can be
 * read or saved until the cause is gone. Never "no runs" — a caller that treated it so would
 * prune worktrees and scratch it took for orphans. `message` is for the user, as it stands: the
 * cockpit shows it as the project's 409, the CLI prints it.
 */
export class RunStoreOpenError extends Error {
  readonly kind: RunStoreOpenErrorKind;
  /** The database the failure is about. */
  readonly path: string;

  constructor(kind: RunStoreOpenErrorKind, path: string, message: string, options: { cause?: unknown } = {}) {
    super(message, options);
    this.name = 'RunStoreOpenError';
    this.kind = kind;
    this.path = path;
  }
}

/** File-system failures outside SQLite (creating the data directory, the backup). */
function errnoKind(error: unknown): RunStoreOpenErrorKind | undefined {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === 'EACCES' || code === 'EPERM' || code === 'EROFS') return 'permission';
  if (code === 'ENOSPC' || code === 'EDQUOT') return 'disk-full';
  return undefined;
}

/**
 * The user-facing failure for `error`, met while opening the store at `path`. `waitedMs` is how
 * long a busy database was retried, if it was.
 */
export function toRunStoreOpenError(error: unknown, path: string, opts: { waitedMs?: number } = {}): RunStoreOpenError {
  if (error instanceof RunStoreOpenError) return error;
  const detail = error instanceof Error ? error.message : String(error);
  const cause = { cause: error };
  if (error instanceof LegacyWriterError) return new RunStoreOpenError('legacy-writer', path, error.message, cause);
  const kind = error instanceof RunDatabaseError ? error.kind : errnoKind(error) ?? 'other';
  switch (kind) {
    case 'corrupt':
      return new RunStoreOpenError(kind, path, `${path} is damaged (${detail}). cezar left it and its -wal and -shm files exactly as they are: restore them from a backup, or rebuild them from runs.json.pre-sqlite.bak as the docs describe, then restart cezar.`, cause);
    case 'busy': {
      const held = opts.waitedMs ? ` for over ${(opts.waitedMs / 1000).toFixed(1)} s` : '';
      return new RunStoreOpenError(kind, path, `${path} is busy: another cezar process has held its write lock${held}. Wait for it to finish, then restart cezar.`, cause);
    }
    case 'permission':
      return new RunStoreOpenError(kind, path, `cezar cannot read or write ${path} (${detail}). Give your user read and write access to ${dirname(path)}, then restart cezar.`, cause);
    case 'disk-full':
      return new RunStoreOpenError(kind, path, `No space is left to write ${path} (${detail}). Free some disk space, then restart cezar.`, cause);
    case 'unsupported-schema': {
      const schema = error instanceof RunDatabaseUnsupportedSchemaError ? ` (schema ${error.found}; this cezar reads schema ${error.supported})` : '';
      return new RunStoreOpenError(kind, path, `${path} was written by a newer cezar${schema}. Upgrade cezar to open this project's runs.`, cause);
    }
    default:
      return new RunStoreOpenError('other', path, `${path} could not be opened (${detail}). Restart cezar to try again.`, cause);
  }
}
