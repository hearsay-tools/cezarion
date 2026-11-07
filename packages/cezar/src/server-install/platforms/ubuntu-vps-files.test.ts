import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { repairUnitEnv } from './ubuntu-vps-files.ts';
import { createAutoUi } from '../ui.ts';
import { testHome } from '../../home/test-home.testkit.ts';
import type { InstallContext } from '../types.ts';

it('repairs system units through the existing privilege path and verifies the result', async () => {
  const root = mkdtempSync(join(tmpdir(), 'system-env-drift-'));
  const path = join(root, 'cockpit.service');
  writeFileSync(path, '[Service]\nEnvironment=CEZ_REMOTE=1\nExecStart=/custom/entry\n');
  let writes = 0;
  const ctx: InstallContext = {home: testHome(), state: {schema: 1, installed: true, primaryPort: 4321, steps: {}},
    ui: createAutoUi(), runner: {
      capture: async (program) => ({code: 0, stdout: program === 'cat' ? readFileSync(path, 'utf8') : '', stderr: ''}),
      interactive: async (program, args) => {
        expect(program).toBe('sudo');
        const encoded = args.at(-1)!.match(/printf %s '([^']+)'/)![1]!;
        writeFileSync(path, Buffer.from(encoded, 'base64')); writes++;
        return 0;
      },
    }, save: async () => {}, dryRun: false, assumeYes: true, reconfigure: new Set(), repoRoot: root,
    instance: 'default', now: '2026-11-07T00:00:00Z', prefs: {}};
  try {
    await repairUnitEnv(ctx, 'system', path);
    expect(readFileSync(path, 'utf8')).toContain('Environment=HSQ_REMOTE=1');
    await repairUnitEnv(ctx, 'system', path);
    expect(writes).toBe(1);
    writeFileSync(path, '[Service]\nEnvironment=CEZ_REMOTE=1\n');
    await repairUnitEnv({...ctx, dryRun: true}, 'system', path);
    expect(writes).toBe(1);
    await repairUnitEnv({...ctx, runner: {...ctx.runner, capture: async () => ({code: 1, stdout: '', stderr: ''})}}, 'system', path);
    expect(writes).toBe(1);
  } finally { rmSync(root, {recursive: true, force: true}); }
});
