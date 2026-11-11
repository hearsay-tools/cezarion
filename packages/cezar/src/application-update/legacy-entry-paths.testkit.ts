import assert from 'node:assert/strict';
import { execFile as execFileCallback } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, basename, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { productIdentity } from '../home/identity.ts';
import type { ApplicationUpdateOptions, ApplicationUpdateService, RestartPlan } from './service.ts';
import type { HelperPlan } from './helper.ts';

const execFile = promisify(execFileCallback);
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../../..');
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const old = productIdentity(false);
export const fixtureText = (file: string): string => readFileSync(join(repo, 'packages/cezar/test/fixtures', file), 'utf8');

/** Execute the shipped service, not a rewritten copy of its stage-path algorithm. */
export async function frozenUpdater(root: string): Promise<typeof import('./service.ts')> {
  const outfile = join(root, 'frozen-updater.mjs');
  await build({ stdin: { contents: fixtureText('v0.17.0-application-update-service.ts.txt'), loader: 'ts',
    resolveDir: join(repo, 'packages/cezar/src/application-update') }, outfile, bundle: true, platform: 'node', format: 'esm',
    plugins: [{ name: 'shipped-discovery', setup(builder) {
      builder.onLoad({ filter: /application-update[/\\]discovery\.ts$/ }, () => ({
        contents: fixtureText('v0.17.0-application-update-discovery.ts.txt'), loader: 'ts',
      }));
    } }],
  });
  return import(pathToFileURL(outfile).href);
}

export type ConsumerKind = 'global' | 'npx';
export function modulesAt(consumer: string, kind: ConsumerKind, windows = process.platform === 'win32'): string {
  return join(consumer, kind === 'global' && !windows ? 'lib/node_modules' : 'node_modules');
}

/** These are the exact released alias bytes and the current command-specific layout. */
export function oldInstallation(consumer: string, kind: ConsumerKind, alias: boolean, entries: string[], nested: boolean, links: boolean, windows = process.platform === 'win32') {
  const modules = modulesAt(consumer, kind, windows);
  const outer = join(modules, alias ? old.npmAlias : old.npmPackage);
  const packageRoot = alias && nested ? join(outer, 'node_modules', old.npmPackage) : join(modules, old.npmPackage);
  mkdirSync(join(packageRoot, 'dist'), { recursive: true });
  mkdirSync(join(packageRoot, 'web/dist'), { recursive: true });
  writeFileSync(join(packageRoot, 'dist/index.js'), 'console.log("previous implementation");');
  writeFileSync(join(packageRoot, 'web/dist/index.html'), 'previous cockpit');
  const scoped = JSON.parse(readFileSync(join(repo, 'packages/cezar/package.json'), 'utf8'));
  // The installation under test is the shipped v0.17.0, whatever version the repo is at now. A release bump must not make it look current.
  writeFileSync(join(packageRoot, 'package.json'), JSON.stringify({ ...scoped, version: '0.17.0', dependencies: {}, devDependencies: {}, scripts: {} }));
  if (alias) {
    const pkg = entries[0] === 'bin.js' ? JSON.parse(fixtureText('v0.17.0-alias-package.json.txt'))
      : JSON.parse(readFileSync(join(repo, 'alias-cezarion/package.json'), 'utf8'));
    mkdirSync(outer, { recursive: true });
    writeFileSync(join(outer, 'package.json'), JSON.stringify(pkg));
    writeFileSync(join(outer, 'bin.js'), fixtureText('v0.17.0-alias-bin.js.txt'));
    for (const path of ['cezarion.js', 'cez.js', 'hsq.js']) writeFileSync(join(outer, path), "import './bin.js';\n");
  } else for (const entry of entries) {
    if (entry !== 'dist/index.js') writeFileSync(join(outer, entry), "import './index.js';\n");
  }
  const launchEntries = entries.map(entry => join(outer, entry));
  if (links && !windows) {
    const binDir = kind === 'global' ? join(consumer, 'bin') : join(modules, '.bin');
    mkdirSync(binDir, { recursive: true });
    const pkg = JSON.parse(readFileSync(join(outer, 'package.json'), 'utf8'));
    for (const [command, target] of Object.entries(pkg.bin as Record<string, string>)) {
      const link = join(binDir, command);
      symlinkSync(join(outer, target), link);
      launchEntries.push(link);
    }
  }
  writeFileSync(join(consumer, 'package.json'), JSON.stringify({ private: true, _npx: { packages: [alias ? old.npmAlias : old.npmPackage] } }));
  return { outer, packageRoot, launchEntries };
}

/** One shipped preparation is reused only for its entry-path variants, never for another package layout. */
export async function capturePlans(options: ApplicationUpdateOptions, entries: string[], Frozen: typeof ApplicationUpdateService, root: string, Current: typeof ApplicationUpdateService): Promise<HelperPlan[]> {
  assert.equal((await new Frozen(options).apply()).status, 'ready');
  const records = join(options.home, 'application-updates');
  const record = join(records, readdirSync(records)[0]!, 'state.json');
  const ready = readFileSync(record, 'utf8');
  const plans: HelperPlan[] = [];
  for (const launchEntry of entries) {
    writeFileSync(record, ready);
    assert.equal((await new Frozen({ ...options, launchEntry }).apply()).status, 'ready');
    let restart: RestartPlan | undefined;
    const resumed = new Current({ ...options, launchEntry, rebrand: true, armRestart: async plan => { restart = plan; } });
    assert.equal(resumed.snapshot().status, 'ready');
    await resumed.restart();
    assert.ok(restart);
    assert.equal(restart.installation.launchEntry, launchEntry);
    plans.push({ ...restart, oldPid: 1, nodeExecutable: process.execPath, nodeArgs: [], cliArgs: [], cwd: root,
      repoRoot: root, host: '127.0.0.1', port: 12345, npmBin: npm });
  }
  return plans;
}

export async function launchOriginalEntries(plans: HelperPlan[], consumer: string, env: NodeJS.ProcessEnv): Promise<void> {
  for (const plan of plans) {
    const entry = plan.installation.launchEntry;
    assert.ok(existsSync(entry));
    const result = await execFile(process.execPath, [entry, 'worker', 'list'], { env, cwd: consumer });
    assert.deepEqual(JSON.parse(result.stdout), { workers: [] });
    const name = basename(entry).replace(/\.js$/, '');
    const command = name === 'bin' ? old.npmAlias : name === 'index' ? old.command : name;
    assert.equal(result.stderr, command === 'hsq' ? '' : `[${command}] '${command}' is deprecated; use 'hsq' instead.\n`);
  }
}

