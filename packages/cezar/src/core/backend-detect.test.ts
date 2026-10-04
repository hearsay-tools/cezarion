import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { detectEnvironment, probeOmp } from './backend-detect.ts';

describe('probeOmp', () => {
  const saved = { dry: process.env.CEZ_DRY_RUN, omp: process.env.CEZ_OMP_BIN, pi: process.env.CEZ_PI_BIN };
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'cez-probe-omp-'));
    delete process.env.CEZ_DRY_RUN;
  });

  afterEach(() => {
    for (const [key, value] of [['CEZ_DRY_RUN', saved.dry], ['CEZ_OMP_BIN', saved.omp], ['CEZ_PI_BIN', saved.pi]] as const) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    rmSync(root, { recursive: true, force: true });
  });

  it('reports the mock as present under CEZ_DRY_RUN=1', async () => {
    process.env.CEZ_DRY_RUN = '1';
    await expect(probeOmp()).resolves.toEqual({ name: 'omp', available: true, version: 'mock (CEZ_DRY_RUN=1)' });
  });

  it('reads the version from CEZ_OMP_BIN', async () => {
    const bin = join(root, 'omp');
    writeFileSync(bin, '#!/bin/sh\necho omp/18.4.11\n');
    chmodSync(bin, 0o755);
    process.env.CEZ_OMP_BIN = bin;
    await expect(probeOmp()).resolves.toMatchObject({ name: 'omp', available: true, version: 'omp/18.4.11' });
  });

  it('degrades to an optional-install hint when the binary is missing, and never spawns pi', async () => {
    const piMarker = join(root, 'pi-was-spawned');
    const pi = join(root, 'pi');
    writeFileSync(pi, `#!/bin/sh\ntouch ${piMarker}\necho 1.0.0\n`);
    chmodSync(pi, 0o755);
    process.env.CEZ_PI_BIN = pi;
    process.env.CEZ_OMP_BIN = join(root, 'nonexistent-omp');
    await expect(probeOmp()).resolves.toEqual({
      name: 'omp',
      available: false,
      hint: 'optional: install OMP (omp.sh) and run `omp login` to use the OMP runner',
    });
    expect(existsSync(piMarker)).toBe(false);
  });

  it('is one of the rows detectEnvironment reports', async () => {
    process.env.CEZ_DRY_RUN = '1';
    expect((await detectEnvironment()).find((row) => row.name === 'omp')).toMatchObject({ available: true });
  });
});
