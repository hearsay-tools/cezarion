import { Home } from '../home/home.ts';
import { testHome, useTestHome } from '../home/test-home.testkit.ts';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { afterEach, expect, it, vi } from 'vitest';
import { RUNNER_IDS } from './agent-runner.ts';
import { driveSeam } from './harness-parity.testkit.ts';

afterEach(() => vi.unstubAllEnvs());
for (const backend of RUNNER_IDS) {
  it.each(['0', '1'])(`${backend} native child omits the cockpit home with full-env=%s`, async (full) => {
    const dir = mkdtempSync(join(tmpdir(), 'cez-child-home-'));
    try {
      useTestHome(Home.sandbox(testHome().root));
      vi.stubEnv('CEZ_AGENT_ENV_FULL', full);
      vi.stubEnv('CEZ_ENV_PASSTHROUGH', 'CEZ_HOME');
      const record = join(dir, 'env.json');
      const recorder = pathToFileURL(fileURLToPath(new URL('../../scripts/mock-env-record.mjs', import.meta.url))).href;
      const obs = await driveSeam(backend, 'baseline', { spec: { env: {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --import=${recorder}`.trim(),
        CEZ_MOCK_ENV_RECORD: record, CEZ_MOCK_ENV_RECORD_NAMES: 'CEZ_HOME',
      } } });
      expect(obs.v1.filter(event => event.type === 'error')).toEqual([]);
      expect(JSON.parse(readFileSync(record, 'utf8'))).toEqual({ CEZ_HOME: null });
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }, 30_000); // bound: native mock startup and runner teardown on a loaded host.
}
