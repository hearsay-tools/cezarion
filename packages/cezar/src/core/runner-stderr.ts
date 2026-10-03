import { stripVTControlCharacters } from 'node:util';

/** Keep the exception, not Node's stack/property tail and runtime footer (#499). */
export function summarizeRunnerStderr(stderr: string): string {
  const lines = stripVTControlCharacters(stderr)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !/^Node\.js v\d+\./.test(line));
  const exception = lines.find(line => /^(?:[\w.$]*(?:Error|Exception)|error|fatal(?: error)?)(?:\s+\[[^\]]+\])?:\s*\S/i.test(line));
  const summary = exception ?? lines.filter(line => !/^at\s/.test(line) && !/^[{}\[\]]+$/.test(line)).slice(-3).join(' | ');
  if (summary.length <= 500) return summary;
  return exception ? `${summary.slice(0, 499)}…` : `…${summary.slice(-499)}`;
}
