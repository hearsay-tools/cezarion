import { stripVTControlCharacters } from 'node:util';

/** Keep the exception, not Node's stack/property tail and runtime footer (#499). */
export function summarizeRunnerStderr(stderr: string): string {
  const lines = stripVTControlCharacters(stderr)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/gu, ' ')
    .split(/\r?\n/)
    .map(line => line.trimEnd())
    .filter(line => line.trim() && !/^Node\.js v\d+\./.test(line.trim()));
  // Select the latest outer exception. Indentation distinguishes nested causes
  // and multiline error properties from a later top-level fatal diagnostic.
  const headers = lines.filter(line => /^(?:[\w.$]*(?:Error|Exception)|error|fatal(?: error)?)(?:\s+\[[^\]]+\])?:\s*\S/i.test(line.trimStart()));
  const indent = (line: string) => line.length - line.trimStart().length;
  const outerIndent = headers.reduce((min, line) => Math.min(min, indent(line)), Infinity);
  const exception = headers.filter(line => indent(line) === outerIndent).at(-1)?.trim();
  const summary = exception ?? lines.map(line => line.trim()).filter(line => !/^at\s/.test(line) && !/^[{}\[\]]+$/.test(line)).slice(-3).join(' | ');
  if (summary.length <= 500) return summary;
  return exception ? `${summary.slice(0, 499)}…` : `…${summary.slice(-499)}`;
}
