import { fileURLToPath } from 'node:url';
import { shellQuote } from '../core/shell-env.ts';

/** This program's own entry as argv, as `artifactInstructions` builds it: from source in a checkout. */
export function ownCommand(): string[] {
  const source = import.meta.url.endsWith('.ts');
  const entry = fileURLToPath(new URL(source ? '../index.ts' : '../index.js', import.meta.url));
  return [process.execPath, ...(source ? ['--import', import.meta.resolve('tsx')] : []), entry];
}

/**
 * The launch prompt's part that names the `job start` command in full. Squawk composes it in its own
 * process, where `process.execPath` is the Node that runs Squawk. The tool list also loads inside
 * other programs (omp is a standalone binary), so the `cezar_wait` description names the command
 * only as `hsq job start` and points here.
 */
export function jobInstructions(): string {
  const command = `${ownCommand().map(shellQuote).join(' ')} job start`;
  return `## Long commands\nTo run a command that takes longer than one shell call (a full test run, a benchmark, a measurement), start it with ${command} <name> -- <command> [args...]. It prints JSON with a long-lived \`pid\`, a \`log\` path and an \`exitFile\` path, and the command keeps running after this shell call, this turn and this session end. Then call cezar_wait with kind "process", that \`pid\` and that \`exitFile\` as \`exit_file\`, and end your turn. Replace \`start\` with \`status\` to find a job by its name later.`;
}
