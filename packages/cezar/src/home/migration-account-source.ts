import { realpathSync } from 'node:fs';
import { expandTilde } from '../paths.ts';
import { insideDirectory } from './migration-files.ts';

/** Migration and later imports must agree about aliases, missing paths and read failures. */
export function migrationAccountSource(legacyRoot: string, configDir: string): string | undefined {
  let source: string;
  try { source = realpathSync(expandTilde(configDir)); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  return insideDirectory(realpathSync(legacyRoot), source) ? source : undefined;
}
