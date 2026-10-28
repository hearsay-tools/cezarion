import { readFileSync } from 'node:fs';
import { sep } from 'node:path';

/** /proc maps escapes newlines as \\012 but does not escape literal backslashes.
 * Both interpretations, and both meanings of " (deleted)", must agree before
 * a pathname can authorize a signal. */
export function mappedPathScope(content: string, roots: readonly string[]): 'held' | 'clear' | 'unknown' {
  let held = false;
  for (const line of content.split('\n')) {
    if (!line) continue;
    const match = /^[0-9a-f]+-[0-9a-f]+\s+\S+\s+[0-9a-f]+\s+[0-9a-f]+:[0-9a-f]+\s+\d+(?:\s+(.*))?$/.exec(line);
    if (!match) return 'unknown';
    const raw = match[1];
    if (!raw || !raw.startsWith('/')) continue;
    const prefix = raw.split('\\012', 1)[0]!;
    if (!roots.some(root => root.startsWith(prefix) || prefix.startsWith(root))) continue;
    if (raw.includes('\ufffd')) return 'unknown';
    const forms = raw.endsWith(' (deleted)') ? [raw, raw.slice(0, -10)] : [raw];
    let variants: string[] = [];
    for (const form of forms) {
      const pieces = form.split('\\012');
      let values = [pieces[0]!];
      for (const piece of pieces.slice(1)) {
        values = values.flatMap(value => [value + '\\012' + piece, value + '\n' + piece]);
        if (values.length > 1024) return 'unknown';
      }
      variants.push(...values);
    }
    const scoped = variants.map(path => roots.some(root => path === root || path.startsWith(root + sep)));
    if (scoped.some(Boolean) && scoped.some(value => !value)) return 'unknown';
    if (scoped.some(Boolean)) held = true;
  }
  return held ? 'held' : 'clear';
}

export function mappedHolder(pid: number, roots: readonly string[]): 'held' | 'clear' | 'unreadable' | 'gone' {
  try {
    const scope = mappedPathScope(readFileSync(`/proc/${pid}/maps`, 'utf8'), roots);
    if (scope === 'unknown') throw new Error(`Ambiguous mapping evidence for destroy holder ${pid}`);
    return scope;
  } catch (error) {
    if (['ENOENT', 'ESRCH'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'gone';
    if (['EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) return 'unreadable';
    throw error;
  }
}
