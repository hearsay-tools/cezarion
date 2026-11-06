#!/usr/bin/env node
// npm run mock:wire -- <output-directory> [runner] [scenario]
// Uses an explicit Vitest config because HARNESS_ADAPTERS imports Vitest testkits.
// This evidence collector is never included in the normal unit suite.
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
const require = createRequire(import.meta.url);
const [directory, runner = '', scenario = ''] = process.argv.slice(2);
if (!directory) { console.error('Usage: npm run mock:wire -- <output-directory> [runner] [scenario]'); process.exit(64); }
const result = spawnSync(process.execPath, [join(dirname(require.resolve('vitest/package.json')), 'vitest.mjs'), 'run', '--config',
  fileURLToPath(new URL('./mock-wire-evidence.config.mjs', import.meta.url))], {
  stdio: 'inherit', env: { ...process.env, MOCK_WIRE_OUTPUT_DIR: resolve(directory), MOCK_WIRE_RUNNER: runner, MOCK_WIRE_SCENARIO: scenario },
});
process.exit(result.status ?? 1);
