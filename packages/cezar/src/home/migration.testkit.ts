import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Home } from './home.ts';
import { storeRoot } from './store.testkit.ts';

export function migrationFixture() {
  const directory = storeRoot();
  const legacy = Home.sandbox(join(directory, 'legacy'), { layout: 'legacy' });
  const target = Home.sandbox(join(directory, 'new'), { layout: 'split' });
  Home.seed(legacy, legacy.workspaceConfig, { projects: [], saved: 'original' });
  return { directory, legacy, target, env: { HOME: directory, SHELL: '/bin/bash' } };
}
export function rawJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value)); // Intentional old-binary or crash-fixture write.
}
export function json(path: string): any { return JSON.parse(readFileSync(path, 'utf8')); }
