import { constants } from 'node:fs';
import { chmod, mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';

it.runIf(process.platform === 'darwin')('reports descriptor support for a mode-000 directory', async () => {
  const path = await mkdtemp(join(tmpdir(), 'cez-darwin-open-'));
  try {
    for (const [name, flags] of Object.entries({ event: 0x8000, eventNoFollow: 0x8000 | constants.O_NOFOLLOW,
      eventNoFollowAny: 0x8000 | 0x20000000, searchNoFollowAny: 0x40000000 | 0x100000 | 0x20000000 })) {
      await chmod(path, 0);
      try {
        const fd = await open(path, flags);
        try { await fd.chmod(0o700); console.log(`${name}: open and fchmod succeeded`); }
        finally { await fd.close(); }
      } catch (error) { console.log(`${name}: ${(error as NodeJS.ErrnoException).code} ${(error as NodeJS.ErrnoException).syscall}`); }
    }
    expect(true).toBe(true);
  } finally { await chmod(path, 0o700); await rm(path, { recursive: true, force: true }); }
});
