import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { vi } from 'vitest';

/** Enumerate the fixture's process tree, including observed children subsequently orphaned.
 * Host daemons and parallel test workers are outside this fixture. Tokens/cwd/permissions are
 * real. Tests of arbitrary enumeration/denial use the injectable reader or their own scope. */
export function scopeFixtureProcesses(): void {
  if (process.platform !== 'linux') return;
  const read = fs.readdirSync;
  const seen = new Map<string, string>();
  vi.spyOn(fs, 'readdirSync').mockImplementation(((...args: unknown[]) => {
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
  }) as typeof fs.readdirSync);
  syncBuiltinESMExports();
}
