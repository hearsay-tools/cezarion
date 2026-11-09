import { fileURLToPath } from 'node:url';
import { shellQuote } from '../core/shell-env.ts';

/** This program's own entry as argv, as `artifactInstructions` builds it: from source in a checkout. */
export function ownCommand(): string[] {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? '../index.ts' : '../index.js', import.meta.url));
  return [process.execPath, ...(source ? ['--import', import.meta.resolve('tsx')] : []), entry];
}

/**
 * The `job start` command an agent types, shell-quoted. The tool list loads inside other programs
 * too (Pi's and omp's extension hosts), where a loader may not resolve this program's entry: the
 * plain command name is the answer there, never a failed load.
 */
export function jobStartCommand(): string {
  try { return `${ownCommand().map(shellQuote).join(' ')} job start`; }
  catch { return 'cez job start'; }
}
