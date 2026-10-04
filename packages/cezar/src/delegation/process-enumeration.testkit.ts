import fs from 'node:fs';

/** Shared by Vitest and installed-package node:test fixtures. Only enumeration is scoped;
 * PID/token/cwd/ownership reads and errors remain real, including observed orphan descendants. */
export function fixtureProcessEnumeration(): typeof fs.readdirSync {
  const read = fs.readdirSync;
  const seen = new Map<string, string>();
  return ((...args: unknown[]) => {
    if (String(args[0]) !== '/proc') return Reflect.apply(read, fs, args);
    const entries = read('/proc');
    const identities = new Map<string, { parent: string; token: string }>();
    for (const pid of entries.filter(name => /^\d+$/.test(name))) {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        identities.set(pid, { parent: fields[1]!, token: fields[19]! });
      } catch { /* vanished; an explicitly injected candidate is covered by probe tests */ }
    }
    const owned = new Set([String(process.pid)]);
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
