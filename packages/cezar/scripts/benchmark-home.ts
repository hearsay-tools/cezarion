import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { legacyHomeEnv, productEnvEntries } from '../src/core/product-env.ts';
import { Home } from '../src/home/home.ts';
import { readInstallMarker } from '../src/home/install-marker.ts';

/** Benchmarks may retain an explicit home, but must never use a live installation. */
export function benchmarkHome(home: Home): Home {
  const roots = new Set([home.config, home.rootOverride ?? home.root]);
  if ([...roots].some(root => readInstallMarker(root)?.kind === 'live')) throw new Error('Benchmark refuses a live install marker');
  Home.sandbox(home.rootOverride ?? home.root, { layout: home.layout });
  return home;
}

/** Sandbox controls must override both inherited product prefixes. */
export function setBenchmarkEnv(env: NodeJS.ProcessEnv = process.env): void {
  Object.assign(env, productEnvEntries('DRY_RUN', '1'), productEnvEntries('AUTONAME', '0'));
}

/** Retain an explicit legacy sandbox or allocate an isolated benchmark home. */
export function prepareBenchmarkEnv(env: NodeJS.ProcessEnv = process.env): string | undefined {
  setBenchmarkEnv(env);
  const existing = legacyHomeEnv(env);
  if (existing) {
    Object.assign(env, productEnvEntries('HOME', existing));
    return undefined;
  }
  const ownHome = mkdtempSync(join(tmpdir(), 'cez-bench-home-'));
  Object.assign(env, productEnvEntries('HOME', ownHome));
  return ownHome;
}
