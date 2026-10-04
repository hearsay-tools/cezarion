import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { vi } from 'vitest';
import { fixtureProcessEnumeration } from './process-enumeration.testkit.ts';

/** Enumerate the fixture's process tree, including observed children subsequently orphaned.
 * Host daemons and parallel test workers are outside this fixture. Tokens/cwd/permissions are
 * real. Tests of arbitrary enumeration/denial use the injectable reader or their own scope. */
export function scopeFixtureProcesses(): () => void {
  if (process.platform !== 'linux') return () => {};
  const enumerate = fixtureProcessEnumeration();
  const scope = vi.spyOn(fs, 'readdirSync').mockImplementation(enumerate);
  syncBuiltinESMExports();
  return () => { scope.mockRestore(); syncBuiltinESMExports(); };
}
