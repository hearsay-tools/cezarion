import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadControls } from '../../scripts/mock-controls.mjs';

// Seam contract row S43 reads the pid every native mock appends at startup (hearsay-tools/cezarion#2991).
describe('mock controls', () => {
  const dirs: string[] = [];
  afterEach(() => {
    vi.unstubAllEnvs();
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it('appends this process pid to CEZ_MOCK_PID_FILE, one line per call', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-mock-pid-'));
    dirs.push(dir);
    const file = join(dir, 'pids');
    vi.stubEnv('CEZ_MOCK_PID_FILE', file);
    await loadControls();
    await loadControls();
    expect(readFileSync(file, 'utf8')).toBe(`${process.pid}\n${process.pid}\n`);
  });
});
