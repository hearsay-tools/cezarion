import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homePaths } from './home.ts';
import { resolveHome } from './resolve.ts'; // test-home-read: target uses only the injected sandbox HSQ_HOME.
import { migrateLegacyHome } from './migrate.ts';

export function runCrashMigration(legacyRoot: string, targetRoot: string, crashAt: string, crash = () => process.exit(74)): void {
  const legacy = homePaths(legacyRoot, join(legacyRoot, '.cache'), legacyRoot);
  const target = resolveHome({ purpose: 'cli', env: { HSQ_HOME: targetRoot }, layout: 'split' }); // test-home-read: injected sandbox.
  migrateLegacyHome(legacy, target, { env: {}, onStep(step) { if (step === crashAt) crash(); } });
}
if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const [legacyRoot, targetRoot, crashAt] = process.argv.slice(2) as [string, string, string];
  runCrashMigration(legacyRoot, targetRoot, crashAt);
}
