import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const roots: string[] = [];
export const storeFixture = fileURLToPath(new URL('./store-process.fixture.testkit.ts', import.meta.url));
export function storeRoot(): string { const dir = mkdtempSync(join(tmpdir(), 'cez-homestore-')); roots.push(dir); return dir; }
export function cleanStoreRoots(): void { for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true }); }
export function childEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...Object.fromEntries(Object.entries(process.env).filter(([name]) => !['VITEST', 'NODE_TEST_CONTEXT', 'JEST_WORKER_ID', 'NODE_OPTIONS'].includes(name) && !name.startsWith('STRYKER_'))), ...extra };
}
export function storeChild(dir: string, command: string, argument = '', env = childEnv()): string {
  const result = spawnSync(process.execPath, ['--import', 'tsx', storeFixture, dir, command, argument], { env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || String(result.error));
  return result.stdout;
}
