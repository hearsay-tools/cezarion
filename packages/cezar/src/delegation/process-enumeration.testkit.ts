import fs from 'node:fs';

/** Shared by Vitest and installed-package node:test fixtures. Only enumeration is scoped;
 * PID/token/cwd/ownership reads and errors remain real, including observed orphan descendants. */
export function fixtureProcessEnumeration(read = fs.readdirSync, readStat = fs.readFileSync, self = process.pid): typeof fs.readdirSync {
  const seen = new Map<string, string>();
  return ((...args: unknown[]) => {
    if (String(args[0]) !== '/proc') return Reflect.apply(read, fs, args);
    const entries = read('/proc');
    const identities = new Map<string, { parent: string; token: string }>();
    for (const pid of entries.filter(name => /^\d+$/.test(name))) {
      try {
        const stat = readStat(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        identities.set(pid, { parent: fields[1]!, token: fields[19]! });
      } catch { /* vanished; an explicitly injected candidate is covered by probe tests */ }
    }
    const owned = new Set([String(self)]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, identity] of identities) {
        if (!owned.has(pid) && (owned.has(identity.parent) || seen.get(pid) === identity.token)) {
          owned.add(pid); seen.set(pid, identity.token); changed = true;
        }
      }
    }
    return entries.filter(pid => owned.has(pid));
  }) as typeof fs.readdirSync;
}

/** Give streaming /proc enumeration the same fixture scope as readdirSync.
 * Other directories retain their real implementation. This is a test spy,
 * not an isolation boundary for direct PID reads or signals. */
export function fixtureProcessDirectory(enumerate: typeof fs.readdirSync, open = fs.opendirSync): typeof fs.opendirSync {
  return ((path: fs.PathLike, options?: unknown) => {
    if (String(path) !== '/proc') return Reflect.apply(open, fs, [path, options]);
    const names = enumerate('/proc');
    let index = 0;
    return { readSync: () => index < names.length ? { name: names[index++] } : null, closeSync: () => {} } as fs.Dir;
  }) as typeof fs.opendirSync;
}
